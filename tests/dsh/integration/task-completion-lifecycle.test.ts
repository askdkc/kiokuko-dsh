import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'
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

for (const fault of ['none', 'cache', 'kick'] as const) test(`completed task releases its owner with pending memory ${fault === 'none' ? 'without failure' : `after ${fault} failure`}`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-memory-close-'))
  const root = join(base, 'repo')
  await mkdir(root)
  const db = openConnection(join(base, 'state.sqlite3'))
  try {
    migrateDatabase(db, join(process.cwd(), 'migrations'))
    const prepared = await prepareAgentTask(db, { requestId: 'memory-cache-close', cwd: root,
      task: 'Read the repository and report the result.', dshSessionId: 'memory-cache-session',
      profileHints: { taskType: 'research', target: 'repo', expected: 'report', constraints: null },
      capabilities: [], skillDiscoveryMode: 'off' })
    const session = { id: 'memory-cache-session' }, agent = { id: 'memory-cache-agent', session }
    const item: any = { runId: prepared.run.runId, sessionId: session.id, agentId: agent.id,
      workspace: prepared.project.workspace, orchestrationId: prepared.intake.sessionId,
      repositoryRoot: root, cwd: root, turn: 1, prepared, nativeSession: session,
      nativeAgent: agent, failed: false, closed: false }
    const runtime: any = { withDatabase: async (fn: (database: typeof db) => unknown) => fn(db) }
    const finalizer = new DshMemoryFinalizer({ runtime })
    await finalizer.bindRunStart({ runId: item.runId, workspace: item.workspace, dshSessionId: session.id,
      sourceStartSeq: 0, sourceStartTurn: 1 })
    const observed: string[] = []
    finalizer.kick = () => { observed.push('kick'); if (fault === 'kick') throw new Error('memory worker unavailable') }
    const lifecycle = createLifecycle({ runtime, sessions: undefined,
      sessionMirror: { async markUnfinalized(id: string) {
        assert.equal(id, session.id); observed.push('cache')
        if (fault === 'cache') throw new Error('memory cache unavailable')
      } } as any,
      memoryFinalizer: finalizer, autoReview: { worker: { abort: () => observed.push('abort-review') } } as any,
      answerReview: { finish: async () => { observed.push('finish-review') } } as any,
      ennoController: { retire: () => observed.push('retire') } as any,
      ennoMemory: { clear: () => observed.push('clear-memory') } as any,
      executionSupport: { clear: () => observed.push('clear-execution') } as any,
      gate: { clearTurn: () => observed.push('clear-turn') } as any,
      turnState: { allTurns: () => [item], releaseRun: () => observed.push('release-run') } as any,
      getSelection: () => undefined, currentSession: () => item, currentForAgentEvent: () => item,
      stateForRun: () => prepared.ennoOduno, deliverCompletionReport: async () => undefined,
      reviewBinding: () => ({} as any), evolutionConfig: { mode: 'off' } as any,
      clearToolRun: () => { observed.push('clear-tools') }, sessionEventSource: () => ({} as any) })
    const close = { runId: item.runId, status: 'completed' as const, sourceEndSeq: 4, terminalTurn: 1 }
    await lifecycle.runLifecycle.closeTurn(close)
    assert.equal(db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{status: string}>(item.runId)?.status, 'completed')
    assert.deepEqual({ ...db.prepare('SELECT status,source_end_seq FROM dsh_memory_finalizations WHERE run_id=?').get(item.runId) },
      { status: 'pending', source_end_seq: 4 })
    assert.equal(item.closed, true)
    assert.deepEqual(observed, ['abort-review','retire','finish-review','clear-memory','clear-execution','clear-turn','release-run','clear-tools','cache','kick'])
    await lifecycle.runLifecycle.closeTurn(close)
    assert.equal(observed.filter(event => event === 'kick').length, 1, 'terminal replay must not enqueue or kick another finalization')
    await lifecycle.runLifecycle.dispose()
  } finally { db.close(); await rm(base, { recursive: true, force: true }) }
})
