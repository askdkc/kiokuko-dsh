import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { assessTaskCompletion, beginTaskCompletionExecution, bindTaskCriterion, finishTaskCompletionExecution } from '../../../src/dsh/task-completion.js'

test('normal enforce keeps the run open until every approved condition has fresh host evidence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-completion-lifecycle-'))
  const root = join(base, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/check.mjs'), 'source')
  const db = openConnection(join(base, 'state.sqlite3'))
  try {
    migrateDatabase(db, join(process.cwd(), 'migrations'))
    const prepared = await prepareAgentTask(db, { requestId: 'normal-enforce-lifecycle', cwd: root,
      task: '報告する\n完了条件:\n- 検査が成功\n- 結果が正しい', dshSessionId: 'completion-native-session',
      completionMode: 'enforce', profileHints: { taskType: 'research', target: 'src', expected: '報告', constraints: null },
      capabilities: [], skillDiscoveryMode: 'off' })
    const session = { id: 'completion-native-session' }
    const agent = { id: 'completion-agent', session }
    const item: any = { runId: prepared.run.runId, sessionId: session.id, agentId: agent.id,
      workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId,
      repositoryRoot: root, cwd: root, task: '報告する', turn: 1, prepared,
      nativeSession: session, nativeAgent: agent, failed: false, closed: false }
    const runtime: any = { withDatabase: async (fn: (database: typeof db) => unknown) => fn(db) }
    const lifecycle = createLifecycle({ runtime, sessions: undefined, sessionMirror: {} as any,
      memoryFinalizer: {} as any, autoReview: {} as any, answerReview: { hold: () => false } as any,
      ennoController: {} as any, ennoMemory: {} as any, executionSupport: { paused: () => false } as any,
      gate: {} as any, turnState: { allTurns: () => [] } as any,
      getSelection: () => ({ value: { mode: 'normal', status: 'ready' }, revision: 1 }) as any,
      currentSession: () => item, currentForAgentEvent: () => item,
      stateForRun: () => prepared.ennoOduno, deliverCompletionReport: async () => undefined,
      reviewBinding: () => ({} as any), evolutionConfig: { mode: 'off' } as any,
      clearToolRun: () => undefined, sessionEventSource: () => ({} as any) })
    assert.equal(await lifecycle.resolveIdleClose(agent.id, session.id, session, agent), undefined)
    const criteria = assessTaskCompletion(db, item.runId).criteria
    assert.equal(criteria.length, 2)
    const method = { kind: 'native_command' as const, command: 'node src/check.mjs', cwd: '.',
      sourcePaths: ['src/check.mjs'], assertion: 'exit_zero' as const }
    for (const [index, criterion] of criteria.entries()) bindTaskCriterion(db, {
      runId: item.runId, callId: `bind-${index}`, criterionId: criterion.criterionId, method, approved: true,
    })
    assert.equal(await lifecycle.resolveIdleClose(agent.id, session.id, session, agent), undefined)
    assert.equal(beginTaskCompletionExecution(db, { runId: item.runId, callId: 'observed-command',
      command: method.command, repositoryRoot: root }), true)
    finishTaskCompletionExecution(db, { runId: item.runId, callId: 'observed-command',
      result: { value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] } })
    assert.deepEqual(await lifecycle.resolveIdleClose(agent.id, session.id, session, agent), {
      runId: item.runId, status: 'completed', terminalTurn: 1,
    })
    assert.equal(assessTaskCompletion(db, item.runId).verified, true)
    assert.equal(db.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get<{ status: string }>(item.runId)?.status, 'active')
  } finally { db.close(); await rm(base, { recursive: true, force: true }) }
})
