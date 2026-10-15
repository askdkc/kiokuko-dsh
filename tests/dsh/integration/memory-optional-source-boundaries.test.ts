import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { DshRunLifecycle, mountDshIdleLifecycle, mountDshSessionLifecycle } from '../../../src/dsh/session-bridge.js'
import { readTaskSnapshot, requestTaskStop, confirmTaskStop, recordTaskEvidence, transitionTask, authorizeTaskLease } from '../../../src/dsh/task-state.js'

// Install at tests/dsh/integration/memory-optional-source-boundaries.test.ts.
// Frozen source-only proposal. These tests have not been executed.
for (const kind of ['idle', 'disposed'] as const) for (const flushFails of [false, true]) {
  test(`${kind} close ${flushFails ? 'retains native flush failure' : 'does not require optional memory-range metadata'}`, async () => {
    const session = { id: 'exact-native-session' }
    const agent = { id: 'exact-native-agent', session }
    let handler: (...args: any[]) => Promise<void> = async () => { throw new Error('handler not mounted') }
    let flushes = 0
    const closed: unknown[] = []
    const lifecycle = new DshRunLifecycle({ closeRun: value => { closed.push(value) } })
    const ctx = { on(_name: string, callback: typeof handler) { handler = callback; return () => {} } }
    const intent = { runId: 'native-completed-run', status: 'completed' as const, terminalTurn: 1 }
    const flush = async (value: unknown) => {
      assert.equal(value, session); flushes++
      if (flushFails) throw new Error('real native flush failed')
    }
    const dispose = kind === 'idle'
      ? mountDshIdleLifecycle(ctx as any, lifecycle, (_agentId, _sessionId, nativeSession, nativeAgent) => {
          assert.equal(nativeSession, session); assert.equal(nativeAgent, agent); return intent
        }, flush)
      : mountDshSessionLifecycle(ctx as any, lifecycle, (_sessionId, nativeSession) => {
          assert.equal(nativeSession, session); return intent
        }, flush)
    try {
      if (kind === 'idle') await handler({ agent, status: 'idle' })
      else await handler(session)
      assert.equal(flushes, 1)
      assert.equal(closed.length, flushFails ? 0 : 1)
      if (!flushFails) assert.deepEqual(closed[0], intent, 'do not invent a range when native snapshot metadata is unavailable')
    } finally { dispose(); await lifecycle.dispose() }
  })
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'optional-memory-source-')))
  const root = join(base, 'repo'); await mkdir(root)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete (env as Record<string, string | undefined>)[key]
  execFileSync('git', ['init', '--quiet', root], { env })
  const db = openConnection(join(base, 'state.sqlite3')); migrateDatabase(db, join(process.cwd(), 'migrations'))
  await resolveProjectWorkspace(db, root)
  let rejectMemory = false
  const reads: string[] = []
  const guarded: SqliteDatabase = { filePath: db.filePath, close() {}, exec(sql) { db.exec(sql) }, prepare(sql) {
    if (rejectMemory && /\b(?:dsh_memory_[a-z_]+|memory_review_[a-z_]+|task_memory_[a-z_]+|memory_evolution_[a-z_]+|auto_global_[a-z_]+)\b/u.test(sql)) {
      reads.push(sql); throw new Error('optional memory unavailable')
    }
    return db.prepare(sql)
  } }
  const runtime = { withDatabase: async <T>(fn: (db: SqliteDatabase) => T | Promise<T>) => fn(guarded) }
  const tasks = new CoreTasks(runtime as any)
  const task = await tasks.prepare({ requestId: 'source-task', sessionId: 'source-session', turn: 1,
    task: 'Inspect repository structure and report it.', cwd: root,
    profileHints: { taskType: 'research', target: '.', expected: 'Report', constraints: null },
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }], signal: new AbortController().signal })
  assert.equal(task.admitted, true); assert.ok(task.authority)
  return { root, db, guarded, runtime, task, reads, rejectMemory() { rejectMemory = true },
    async close() { db.close(); await rm(base, { recursive: true, force: true }) } }
}

test('superseded completion flushes the native session but ignores mirror and optional-range failures', async () => {
  const f = await fixture()
  let flushes = 0, mirrorCalls = 0, releases = 0
  const session = { id: f.task.sessionId }, agent = { id: 'native-agent', session }
  const item: any = { runId: f.task.runId, sessionId: session.id, authority: f.task.authority,
    cwd: f.root, repositoryRoot: f.root, turn: 1, nativeSession: session, nativeAgent: agent,
    prepared: { intake: { profile: f.task.profile } }, closed: false }
  const lifecycle = createLifecycle({ runtime: f.runtime as any,
    sessions: { flush: async (value: unknown) => { assert.equal(value, session); flushes++ } } as any,
    sessionMirror: { checkpointAfterNativeFlush: async () => { mirrorCalls++; throw new Error('optional mirror failed') } } as any,
    memoryFinalizer: { scheduleInTransaction() { throw new Error('must not schedule memory') } } as any,
    autoReview: { worker: { abort() {} } } as any, answerReview: { finish: async () => {} } as any,
    ennoController: { retire() {} } as any, ennoMemory: { clear() {} } as any,
    executionSupport: { clear() {} } as any, gate: { clearTurn() {} } as any,
    turnState: { allTurns: () => [item], releaseRun() { releases++ } } as any,
    getSelection: () => undefined, currentSession: () => item, currentForAgentEvent: () => item,
    stateForRun: () => ({ status: 'completed' } as any), deliverCompletionReport: async () => {},
    reviewBinding: () => ({} as any), evolutionConfig: { mode: 'active' } as any, clearToolRun() {},
    sessionEventSource: () => { throw new Error('optional memory range unavailable') } })
  try {
    f.rejectMemory()
    await lifecycle.retireSupersededRun(item, 'completed')
    assert.equal(flushes, 1); assert.equal(mirrorCalls, 1); assert.equal(releases, 1)
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get(f.task.runId)?.status, 'completed')
    assert.deepEqual(f.reads, [])
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get()?.n, 0)
  } finally { await lifecycle.runLifecycle.dispose(); await f.close() }
})

for (const hasEnd of [false, true]) test(`explicit resume preserves raw provenance with ${hasEnd ? 'observed' : 'unavailable'} end and no memory jobs`, async () => {
  const f = await fixture()
  try {
    const task = readTaskSnapshot(f.db, f.task.authority!)
    f.db.prepare('INSERT INTO dsh_run_log_boundaries VALUES(?,?,?,?,?,?,?)')
      .run(task.taskId, f.task.workspace, task.sessionId, 0, 1, '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z')
    const stopping = requestTaskStop(f.db, task, { operation: 'wait', operationId: 'native-stop', expectedRevision: task.revision,
      expectedGeneration: task.generation, reason: 'Explicit pause' })
    recordTaskEvidence(f.db, stopping, { ref: 'observed-stop', kind: 'stopped', generation: stopping.generation, verified: true })
    const pending = confirmTaskStop(f.db, stopping, { operationId: 'native-stop', expectedRevision: stopping.revision, evidenceRef: 'observed-stop' })
    f.rejectMemory()
    assert.throws(() => transitionTask(f.guarded, { ...pending, sessionId: 'foreign-session' }, {
      operation: 'resume', operationId: 'foreign-resume', expectedRevision: pending.revision, expectedGeneration: pending.generation,
      reason: 'Cannot borrow another owner', explicit: true }), /owner/)
    const resumed = transitionTask(f.guarded, pending, { operation: 'resume', operationId: 'explicit-resume',
      expectedRevision: pending.revision, expectedGeneration: pending.generation, reason: 'User resumes the same work', explicit: true },
      hasEnd ? { sourceEndSeq: 6 } : undefined)
    assert.equal(resumed.state, 'Working'); assert.equal(resumed.sessionId, task.sessionId)
    assert.ok(resumed.generation > pending.generation)
    assert.throws(() => authorizeTaskLease(f.db, f.task.authority!), /stale or stopped/)
    const history = f.db.prepare('SELECT * FROM dsh_task_source_history WHERE run_id=?').get(f.task.runId)!
    const boundary = JSON.parse(String(history.boundary_json))
    assert.equal(history.original_session_id, task.sourceSessionId)
    assert.equal(history.source_session_id, task.sessionId)
    assert.equal(history.task_generation, pending.generation)
    assert.equal(history.finalization_json, null); assert.equal(history.review_state_json, null)
    assert.equal(boundary.source_start_seq, 0)
    assert.equal(boundary.source_end_seq, hasEnd ? 6 : null)
    assert.equal(boundary.source_end_status, hasEnd ? 'host_observed' : 'unavailable')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_task_source_finalizations').get()?.n, 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get()?.n, 0)
    assert.deepEqual(f.reads, [])
  } finally { await f.close() }
})
