import { initializeCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { answerCodingChoice } from '../../../src/dsh/coding-workflow/service.js'
import { spawnSync } from 'node:child_process'
import { LedgerStore } from '../../../src/ledger/store.js'
import { continuationProgress } from '../../../src/dsh/continuation-evidence.js'
import { continueVerification } from '../../../src/dsh/verification-continuation.js'
import { resetLoopGuardForUserInTransaction } from '../../../src/dsh/loop-guard.js'
import { bindTaskRepository, captureTaskLease } from '../../../src/dsh/task-state.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { bindMainModelRequestIntent, createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, finishTaskCompletionExecution,
  completionSourceDigest, initializeTaskCompletion, parseNodeTapSummary, saveTaskCompletionReceipt, selectedNodeTestCommand, taskCompletionBlocksClose } from '../../../src/dsh/task-completion.js'
import { observeProcessResult } from '../../../src/dsh/execution-result.js'

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

test('source-bound verification requires observed proof even in shadow mode', () => {
  const missing = { mode: 'shadow' as const, verified: false, required: 0, criteria: [], evidenceRequired: true as const }
  assert.equal(taskCompletionBlocksClose(missing), true)
  assert.equal(taskCompletionBlocksClose({ ...missing, verified: true }), false)
})

test('typed verification binds specification identity separately from host-observed evidence', async () => {
  const f = await fixture('enforce')
  try {
    const operation = { kind: 'test' as const, adapter: 'node-test' as const, adapterVersion: 1 as const,
      files: ['check.test.ts'], directory: 'src', timeoutMs: 120000, isolation: 'default' as const }
    const method = { kind: 'typed_operation' as const, definitionVersion: 1 as const, operation,
      sourcePaths: ['src/check.test.ts'], assertion: 'selected_tests_pass' as const }
    const receipt = { sessionId: 'typed-session', agentId: 'typed-agent', environmentDigest: 'typed-environment' }
    bindTaskCriterion(f.database, { runId: f.runId, callId: 'typed-bind',
      criterionId: f.criteria[0]!.criterionId, method, approved: true })
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'typed-wrong',
      operation: { ...operation, files: ['other.test.ts'] }, repositoryRoot: f.root, cwd: join(f.root, 'src'), receipt }), false)
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'typed-forged',
      operation, repositoryRoot: f.root, cwd: join(f.root, 'src'), receipt }), true)
    assert.throws(() => beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'typed-forged',
      operation, repositoryRoot: f.root, cwd: join(f.root, 'src'), receipt: { ...receipt, agentId: 'other-agent' } }),
    /reused with changed bound input/)
    finishTaskCompletionExecution(f.database, { runId: f.runId, callId: 'typed-forged', result: {
      value: { exitCode: 0, summary: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 } }, content: [],
    } })
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'unknown',
      'a copied success object is not host evidence')

    for (const [callId, summary] of [
      ['typed-zero', { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }],
      ['typed-skip', { tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 1, todo: 0 }],
    ] as const) {
      assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId,
        operation, repositoryRoot: f.root, cwd: join(f.root, 'src'), receipt }), true)
      finishTaskCompletionExecution(f.database, { runId: f.runId, callId, result: observeProcessResult({
        isError: false, value: { exitCode: 0, signal: null, timedOut: false, aborted: false,
          processStarted: true, processStopped: true, outputComplete: true, summary }, content: [],
      }) })
      assert.notEqual(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'satisfied',
        'zero tests and skipped tests are not typed completion proof')
    }

    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'typed-observed',
      operation, repositoryRoot: f.root, cwd: join(f.root, 'src'), receipt }), true)
    finishTaskCompletionExecution(f.database, { runId: f.runId, callId: 'typed-observed', result: observeProcessResult({
      isError: false,
      value: { exitCode: 0, signal: null, timedOut: false, aborted: false, processStarted: true,
        processStopped: true, outputComplete: true,
        summary: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 } },
      content: [],
    }) })
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'satisfied')
    await writeFile(join(f.root, 'src/check.test.ts'), 'changed typed target')
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'stale')
  } finally { await f.cleanup() }
})

test('coding resumes unbound checks only after the human selects the execution route', async () => {
  const f = await fixture('shadow')
  try {
    const task = 'Fix the parser'
    const message = { id: 'fix-original', role: 'user', content: [{ type: 'text', text: task }] }
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([message], task) })!
    const decision = bindMainModelRequestIntent({ relation: 'new', action: 'change', changeScope: 'implementation',
      evidenceRefs: requestIntentReferenceIds(context) }, context)
    assert.ok(decision)
    initializeTaskCompletion(f.database, f.runId, 'shadow', decision)
    const ledger = new LedgerStore(f.database)
    if (ledger.readRun(f.runId)?.status === 'intake') ledger.updateRunStatus(f.runId, 'active')
    const identity = { runId: f.runId, taskId: f.runId, sessionId: 'completion-session', repositoryRoot: f.root }
    bindTaskRepository(f.database, identity)
    const authority = captureTaskLease(f.database, identity)
    await mkdir(join(f.root, '.github/workflows'), { recursive: true })
    await writeFile(join(f.root, '.github/workflows/test.yml'), 'name: tests')
    const workflow = initializeCodingWorkflow(f.database, { ...identity, requestId: 'fix-original', task })
    const messages: unknown[] = []
    const agent = { status: 'idle', inbox: { nextStep: [], nextTurn: [] }, cancel() {},
      followup(message: unknown) { messages.push(message) } }
    const wake = (turn: number) => continueVerification({
      runtime: { withDatabase: async (fn: (database: typeof f.database) => unknown) => fn(f.database) } as any,
      agent, authority, turn, current: () => true,
    })
    await wake(1)
    assert.equal(messages.length, 0)
    answerCodingChoice(f.database, identity, { callId: 'choose', expectedRevision: workflow.revision,
      workflowId: workflow.workflowId, scopeVersion: workflow.scopeVersion, questionId: workflow.choice.questionId,
      questionRevision: workflow.choice.revision, answerRef: 'human', choice: 'no' })
    await wake(2)
    assert.equal(messages.length, 1)
    await wake(2)
    assert.equal(messages.length, 1)
    const assessment = assessTaskCompletion(f.database, f.runId)
    const ci = assessment.criteria.find(item => item.description.includes('CI checks'))
    assert.ok(ci, 'coding in a CI repository must also verify its applicable jobs')
    assert.equal(ci.reason, 'no_binding')
    const run = (callId: string, file: string) => {
      const args = ['--test', '--test-reporter=tap', file]
      assert.ok(beginTaskCompletionExecution(f.database, { runId: f.runId, callId,
        command: ['node', ...args].join(' '), repositoryRoot: f.root }))
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8', env })
      assert.ifError(result.error)
      finishTaskCompletionExecution(f.database, { runId: f.runId, callId, result: observeProcessResult({
        isError: result.status !== 0, value: { exitCode: result.status, signal: result.signal, aborted: false,
          timedOut: false, processStarted: true, processStopped: true, outputComplete: true },
        content: [{ type: 'text', text: result.stdout }],
      }) })
      return result.status
    }
    await writeFile(join(f.root, 'src/check.test.ts'), "import test from 'node:test'; test('smoke', () => {});")
    for (const item of f.criteria)
      bindTaskCriterion(f.database, { runId: f.runId, callId: item.criterionId, criterionId: item.criterionId,
        method: f.method, approved: true })
    assert.equal(run('focused', 'src/check.test.ts'), 0)
    assert.equal(assessTaskCompletion(f.database, f.runId).verified, false, 'the focused check cannot close the CI criterion')
    const ciFile = 'src/ci.test.mjs'
    await writeFile(join(f.root, ciFile), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from './value.mjs'; test('public value', () => assert.equal(value, 2));")
    await writeFile(join(f.root, 'src/value.mjs'), 'export const value = 1')
    bindTaskCriterion(f.database, { runId: f.runId, callId: 'bind-ci', criterionId: ci.criterionId, approved: true,
      method: { ...f.method, command: 'node --test --test-reporter=tap ' + ciFile,
        sourcePaths: [ciFile, 'src/value.mjs', '.github/workflows/test.yml'] } })
    assert.equal(run('ci-red', ciFile), 1)
    await wake(3)
    assert.equal(messages.length, 2)
    await writeFile(join(f.root, 'src/value.mjs'), 'export const value = 2')
    await wake(4)
    assert.equal(messages.length, 3, 'completed checks permit a subsequent repair cycle')
    assert.equal(run('ci-green', ciFile), 0)
    assert.ok(assessTaskCompletion(f.database, f.runId).verified)
    await wake(5)
    assert.equal(messages.length, 3, 'all required evidence stops the loop')
    await writeFile(join(f.root, '.github/workflows/test.yml'), 'name: revised tests')
    assert.equal(assessTaskCompletion(f.database, f.runId).verified, false, 'editing the CI definition invalidates its result')
  } finally { await f.cleanup() }
})

for (const boundary of ['before-dispatch', 'uncertain-dispatch'] as const) test(`verification reconciles ${boundary} without duplicate delivery`, async () => {
  const f = await fixture('shadow')
  try {
    const task = 'Verify parser output'
    const message = { id: 'verify-original', role: 'user', content: [{ type: 'text', text: task }] }
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([message], task) })!
    const decision = bindMainModelRequestIntent({ relation: 'new', action: 'verify',
      evidenceRefs: requestIntentReferenceIds(context) }, context)
    assert.ok(decision)
    initializeTaskCompletion(f.database, f.runId, 'shadow', decision)
    const ledger = new LedgerStore(f.database)
    if (ledger.readRun(f.runId)?.status === 'intake') ledger.updateRunStatus(f.runId, 'active')
    const identity = { taskId: f.runId, sessionId: 'completion-session', repositoryRoot: f.root }
    bindTaskRepository(f.database, identity)
    const authority = captureTaskLease(f.database, identity)
    for (const [index, criterion] of f.criteria.entries())
      bindTaskCriterion(f.database, { runId: f.runId, callId: `bind-${index}`,
        criterionId: criterion.criterionId, method: f.method, approved: true })

    let checks = 0, attempts = 0, interrupted = true
    const agent = { status: 'idle', inbox: { nextStep: [], nextTurn: [] }, cancel() {},
      followup() { attempts++; if (boundary === 'uncertain-dispatch') throw Error('unknown native outcome') } }
    const wake = () => continueVerification({
      runtime: { withDatabase: async (fn: (database: typeof f.database) => unknown) => fn(f.database) } as any,
      agent, authority, turn: 1, current: () => !(boundary === 'before-dispatch' && interrupted && ++checks === 3),
    })
    if (boundary === 'uncertain-dispatch') await assert.rejects(wake(), /unknown native outcome/)
    else await wake()
    interrupted = false
    await wake()
    await wake()
    assert.equal(attempts, 1, 'only a confirmed unsent reservation can be delivered again')
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM dsh_loop_guard_claims').get<{ n: number }>()?.n, 1,
      'reconciliation does not consume another retry')
  } finally { await f.cleanup() }
})

test('automatic verification parks after two wakes even when each retry changes source', async () => {
  const f = await fixture('shadow')
  try {
    const task = 'Verify parser output'
    const message = { id: 'verify-original', role: 'user', content: [{ type: 'text', text: task }] }
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([message], task) })!
    const decision = bindMainModelRequestIntent({ relation: 'new', action: 'verify',
      evidenceRefs: requestIntentReferenceIds(context) }, context)
    assert.ok(decision)
    initializeTaskCompletion(f.database, f.runId, 'shadow', decision)
    const ledger = new LedgerStore(f.database)
    if (ledger.readRun(f.runId)?.status === 'intake') ledger.updateRunStatus(f.runId, 'active')
    const identity = { taskId: f.runId, sessionId: 'completion-session', repositoryRoot: f.root }
    bindTaskRepository(f.database, identity)
    const authority = captureTaskLease(f.database, identity)
    for (const [index, criterion] of f.criteria.entries())
      bindTaskCriterion(f.database, { runId: f.runId, callId: `bind-${index}`,
        criterionId: criterion.criterionId, method: f.method, approved: true })

    const messages: unknown[] = []
    const agent = { status: 'idle', inbox: { nextStep: [], nextTurn: [] }, cancel() {},
      followup(message: unknown) { messages.push(message) } }
    const wake = (turn: number) => continueVerification({
      runtime: { withDatabase: async (fn: (database: typeof f.database) => unknown) => fn(f.database) } as any,
      agent, authority, turn, current: () => true,
    })
    for (let turn = 1; turn <= 6; turn++) {
      await writeFile(join(f.root, 'src/check.test.ts'), `changed source ${turn}`)
      await wake(turn)
      await wake(turn)
    }
    assert.equal(messages.length, 2)
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM dsh_session_notices WHERE id LIKE 'completion-retries-ended:%'")
      .get<{ n: number }>()?.n, 1, 'only one stop notice per human-input generation')
    assert.equal(assessTaskCompletion(f.database, f.runId).verified, false)
    assert.equal(ledger.readRun(f.runId)?.status, 'active', 'keep the unverified work available for explicit continuation')
    withImmediateTransaction(f.database, () => resetLoopGuardForUserInTransaction(f.database, {
      runId: f.runId, dshSessionId: authority.sessionId, resolution: 'manual_user',
    }))
    await wake(7)
    assert.equal(messages.length, 3, 'a new human turn can resume verification')
    for (const [index] of f.criteria.entries()) {
      const callId = `observed-${index}`
      assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId, command, repositoryRoot: f.root }), true)
      finishTaskCompletionExecution(f.database, { runId: f.runId, callId, result: {
        value: { exitCode: 0 }, content: [{ type: 'text', text: tap(1) }],
      } })
    }
    assert.equal(assessTaskCompletion(f.database, f.runId).verified, true)
    await wake(8)
    assert.equal(messages.length, 3, 'verified work must not schedule another wake')
  } finally { await f.cleanup() }
})

test('a bound verification request in shadow stays open until its current check passes', async () => {
  const f = await fixture('shadow')
  try {
    const task = 'Verify parser output'
    const message = { id: 'verify-original', role: 'user', content: [{ type: 'text', text: task }] }
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([message], task) })!
    const decision = bindMainModelRequestIntent({ relation: 'new', action: 'verify',
      evidenceRefs: requestIntentReferenceIds(context) }, context)
    assert.ok(decision)
    initializeTaskCompletion(f.database, f.runId, 'shadow', decision)
    const ledger = new LedgerStore(f.database)
    if (ledger.readRun(f.runId)?.status === 'intake') ledger.updateRunStatus(f.runId, 'active')
    assert.equal(taskCompletionBlocksClose(assessTaskCompletion(f.database, f.runId)), true)
    for (const [index, criterion] of f.criteria.entries()) {
      const callId = `observed-${index}`
      bindTaskCriterion(f.database, { runId: f.runId, callId: `bind-${index}`,
        criterionId: criterion.criterionId, method: f.method, approved: true })
      assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId, command,
        repositoryRoot: f.root }), true)
      finishTaskCompletionExecution(f.database, { runId: f.runId, callId, result: {
        value: { exitCode: 0 }, content: [{ type: 'text', text: tap(1) }],
      } })
    }
    const verified = saveTaskCompletionReceipt(f.database, f.runId)
    assert.equal(taskCompletionBlocksClose(verified), false)
    const progress = continuationProgress(f.database, f.runId, f.root, verified)
    f.database.prepare('UPDATE dsh_completion_executions SET source_digest = ? WHERE run_id = ?')
      .run('a'.repeat(64), f.runId)
    assert.equal(continuationProgress(f.database, f.runId, f.root, verified), progress,
      'a changed revision inside the verification digest alone is not progress')
    // Restore the exact source digest before observing the terminal transition.
    const source = completionSourceDigest(f.database, f.runId, f.root, f.method.sourcePaths)
    f.database.prepare('UPDATE dsh_completion_executions SET source_digest = ? WHERE run_id = ?').run(source, f.runId)
    ledger.updateRunStatus(f.runId, 'completed')
    assert.equal(assessTaskCompletion(f.database, f.runId).verified, true,
      'closing revokes execution without invalidating the closing proof')
    await writeFile(join(f.root, 'src/check.test.ts'), 'changed target')
    assert.notEqual(continuationProgress(f.database, f.runId, f.root, verified), progress)
    assert.equal(taskCompletionBlocksClose(assessTaskCompletion(f.database, f.runId)), true)
  } finally { await f.cleanup() }
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

test('pre-bound subdirectory checks accept complete Node TAP coverage and retain unrelated artifacts', async () => {
  const f = await fixture('enforce')
  try {
    const method = { ...f.method, cwd: 'src', command: 'node --test --test-reporter=tap check.test.ts' }
    bindTaskCriterion(f.database, { runId: f.runId, callId: 'subdir-bind', criterionId: f.criteria[0]!.criterionId, method, approved: true })
    assert.equal(beginTaskCompletionExecution(f.database, { runId: f.runId, callId: 'subdir-test', command: method.command, repositoryRoot: f.root, cwd: join(f.root, 'src') } as any), true)
    finishTaskCompletionExecution(f.database, { runId: f.runId, callId: 'subdir-test', result: { value: { exitCode: 0 }, content: [{type:'text',text:tap(1)}] } })
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'satisfied')
    await writeFile(join(f.root, 'generated.txt'), 'unrelated build output')
    assert.equal(assessTaskCompletion(f.database, f.runId).criteria[0]?.state, 'satisfied')
  } finally { await f.cleanup() }
})

test('unresolved managed work blocks only its explicitly bound task completion',async()=>{
  const f=await fixture('enforce')
  try {
    for(const [index,criterion]of f.criteria.entries())bindTaskCriterion(f.database,{runId:f.runId,callId:`bind-managed-${index}`,criterionId:criterion.criterionId,method:f.method,approved:true})
    beginTaskCompletionExecution(f.database,{runId:f.runId,callId:'managed-proof',command,repositoryRoot:f.root})
    finishTaskCompletionExecution(f.database,{runId:f.runId,callId:'managed-proof',result:{value:{exitCode:0},content:[{type:'text',text:tap(1)}]}})
    assert.equal(assessTaskCompletion(f.database,f.runId).verified,true)
    const {ManagedOperationJournal}=await import('../../../src/dsh/managed-operation-journal.js')
    const journal=new ManagedOperationJournal(f.database)
    const scope=journal.createScope({sessionId:'same-session',parentId:'unknown',runtimeIdentity:'fixture',binding:{taskId:'unrelated-task'}})
    const op=journal.prepare(scope.scopeId,{route:'owned',kind:'process',request:{command:'fixture'}})
    journal.claim(op.operationId);journal.transition(op.operationId,{state:'unknown'});journal.seal(scope.scopeId)
    assert.equal(assessTaskCompletion(f.database,f.runId).verified,true,'session coincidence cannot bind independent work')
    const ownScope=journal.createScope({sessionId:'same-session',parentId:'bound-unknown',runtimeIdentity:'fixture',binding:{taskId:f.runId}})
    const own=journal.prepare(ownScope.scopeId,{route:'owned',kind:'process',request:{command:'fixture'}})
    journal.claim(own.operationId);journal.transition(own.operationId,{state:'unknown'});journal.seal(ownScope.scopeId)
    const result=assessTaskCompletion(f.database,f.runId)
    assert.equal(result.managedOperationsReady,false);assert.equal(result.verified,false)
    assert.equal(taskCompletionBlocksClose(result),true)
  } finally {await f.cleanup()}
})

test('task-bound open or incomplete zero-operation collectors cannot count as completed evidence',async()=>{
  const f=await fixture('enforce')
  try {
    const {ManagedOperationJournal}=await import('../../../src/dsh/managed-operation-journal.js')
    const journal=new ManagedOperationJournal(f.database)
    const scope=journal.createScope({sessionId:'session',parentId:'collector',runtimeIdentity:'fixture',binding:{taskId:f.runId}})
    assert.equal(assessTaskCompletion(f.database,f.runId).managedOperationsReady,false)
    journal.seal(scope.scopeId)
    assert.equal(assessTaskCompletion(f.database,f.runId).managedOperationsReady,true)
    const broken=journal.createScope({sessionId:'session',parentId:'broken',runtimeIdentity:'fixture',binding:{taskId:f.runId}})
    journal.markIncomplete(broken.scopeId);journal.seal(broken.scopeId)
    assert.equal(assessTaskCompletion(f.database,f.runId).managedOperationsReady,false)
  } finally {await f.cleanup()}
})
