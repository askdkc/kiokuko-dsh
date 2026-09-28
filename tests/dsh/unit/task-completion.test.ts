import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, finishTaskCompletionExecution,
  parseNodeTapSummary, saveTaskCompletionReceipt, selectedNodeTestCommand, taskCompletionBlocksClose } from '../../../src/dsh/task-completion.js'

const command = 'node --test --test-reporter=tap src/check.test.ts'
const tap = (pass: number, skipped = 0) => `TAP version 13\n# tests ${pass + skipped}\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n# duration_ms 3\n`

async function fixture(mode: 'shadow' | 'enforce' | undefined) {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-task-completion-'))
  const root = join(base, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/check.test.ts'), 'test source')
  const database = openConnection(join(base, 'state.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const task = '資料を確認する。\n完了条件:\n- 対象テストが成功する\n- 結果を報告する'
  const prepared = await prepareAgentTask(database, { requestId: `completion-${mode ?? 'legacy'}`, cwd: root, task,
    dshSessionId: 'completion-session', profileHints: { taskType: 'research', target: 'src', expected: '結果を報告', constraints: null },
    ...(mode ? { completionMode: mode } : {}), capabilities: [], skillDiscoveryMode: 'off' })
  const runId = prepared.run.runId
  const criteria = assessTaskCompletion(database, runId).criteria
  const method = { kind: 'native_command' as const, command, cwd: '.', sourcePaths: ['src/check.test.ts'], assertion: 'selected_tests_pass' as const }
  const cleanup = async () => { database.close(); await rm(base, { recursive: true, force: true }) }
  return { base, root, database, runId, criteria, method, cleanup }
}

test('completion mode is frozen at run creation and shadow preserves legacy closure', async () => {
  const enforce = await fixture('enforce')
  const shadow = await fixture('shadow')
  const legacy = await fixture(undefined)
  try {
    assert.equal(enforce.criteria.length, 2)
    assert.equal(taskCompletionBlocksClose(saveTaskCompletionReceipt(enforce.database, enforce.runId)), true)
    assert.equal(taskCompletionBlocksClose(saveTaskCompletionReceipt(shadow.database, shadow.runId)), false)
    assert.equal(assessTaskCompletion(legacy.database, legacy.runId).mode, 'shadow')
    assert.equal(legacy.database.prepare('SELECT * FROM dsh_completion_runs').all().length, 0)
  } finally { await enforce.cleanup(); await shadow.cleanup(); await legacy.cleanup() }
})

test('only an approved, pre-bound exact command at the source revision supplies proof', async () => {
  const f = await fixture('enforce')
  try {
    const criterionId = f.criteria[0]!.criterionId
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'before-bind', command,
      repositoryRoot: f.root }), false)
    bindTaskCriterion(f.database, { runId: f.runId, callId: 'bind', criterionId, method: f.method, approved: true })
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'wrong-command', command: 'npm test',
      repositoryRoot: f.root }), false)
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'actual-command', command,
      repositoryRoot: f.root }), true)
    finishTaskCompletionExecution(f.database, { runId: f.runId, callId: 'actual-command', result: {
      value: { exitCode: 0 }, content: [{ type: 'text', text: tap(1) }],
    } })
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'satisfied')
    await writeFile(join(f.root, 'src/check.test.ts'), 'changed after verification')
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'stale')
    assert.throws(() => bindTaskCriterion(f.database, { runId: f.runId, callId: 'bind', criterionId,
      method: { ...f.method, command: 'node --test --test-reporter=tap src/other.test.ts' }, approved: true }), /reused/)
    bindTaskCriterion(f.database, { runId: f.runId, callId: 'new-binding', criterionId,
      method: { ...f.method, command: 'node src/other.mjs', assertion: 'exit_zero' }, approved: true })
    assert.throws(() => beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'actual-command',
      command: 'node src/other.mjs', repositoryRoot: f.root }), /reused with changed bound input/)
  } finally { await f.cleanup() }
})

test('a selected skipped test is unmet while an unsupported or incomplete output is unknown', async () => {
  const f = await fixture('enforce')
  try {
    const criterionId = f.criteria[0]!.criterionId
    bindTaskCriterion(f.database, { runId: f.runId, callId: 'bind', criterionId, method: f.method, approved: true })
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'skip', command, repositoryRoot: f.root }), true)
    finishTaskCompletionExecution(f.database, { runId: f.runId, callId: 'skip', result: {
      value: { exitCode: 0 }, content: [{ type: 'text', text: tap(0, 1) }],
    } })
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'unmet')
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'truncated', command, repositoryRoot: f.root }), true)
    finishTaskCompletionExecution(f.database, { runId: f.runId, callId: 'truncated', result: {
      value: { exitCode: 0 }, content: [{ type: 'text', text: 'Output capped at 8192 bytes' }],
    } })
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'unknown')
    assert.equal(parseNodeTapSummary(tap(0, 1))?.skipped, 1)
    assert.equal(selectedNodeTestCommand('echo ok; node --test --test-reporter=tap src/check.test.ts'), false)
  } finally { await f.cleanup() }
})
