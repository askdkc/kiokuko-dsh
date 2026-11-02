import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'

test('completed task releases its owner without invoking optional memory writes', async () => {
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
    finalizer.kick = () => { observed.push('kick'); throw new Error('memory worker unavailable') }
    const lifecycle = createLifecycle({ runtime, sessions: undefined,
      sessionMirror: { async markUnfinalized(id: string) {
        assert.equal(id, session.id); observed.push('cache')
        throw new Error('memory cache unavailable')
      } } as any,
      memoryFinalizer: finalizer, autoReview: { worker: { abort: () => observed.push('abort-review') } } as any,
      answerReview: { finish: async () => { observed.push('finish-review') } } as any,
      executionSupport: { clear: () => observed.push('clear-execution') } as any,
      gate: { clearTurn: () => observed.push('clear-turn') } as any,
      turnState: { allTurns: () => [item], releaseRun: () => observed.push('release-run') } as any,
      getSelection: () => undefined, currentSession: () => item, currentForAgentEvent: () => item,
      deliverCompletionReport: async () => undefined,
      reviewBinding: () => ({} as any), evolutionConfig: { mode: 'off' } as any,
      sessionEventSource: () => ({} as any) })
    const close = { runId: item.runId, status: 'completed' as const, sourceEndSeq: 4, terminalTurn: 1 }
    await lifecycle.runLifecycle.closeTurn(close)
    assert.equal(db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<{status: string}>(item.runId)?.status, 'completed')
    assert.equal(db.prepare('SELECT status,source_end_seq FROM dsh_memory_finalizations WHERE run_id=?').get(item.runId), undefined)
    assert.equal(item.closed, true)
    assert.deepEqual(observed, ['abort-review','finish-review','clear-execution','clear-turn','release-run'])
    await lifecycle.runLifecycle.closeTurn(close)
    assert.equal(observed.filter(event => event === 'kick' || event === 'cache').length, 0, 'completion and terminal replay cannot invoke optional memory writes')
    await lifecycle.runLifecycle.dispose()
  } finally { db.close(); await rm(base, { recursive: true, force: true }) }
})
