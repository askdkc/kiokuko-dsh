import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { createLifecycle } from '../../../src/dsh/host-adapter/lifecycle.js'
import { DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { memoryApplicationStatus, recordMemoryApplicationReview } from '../../../src/memory/application.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { readTaskSnapshot, captureTaskLease, authorizeTaskLease, requestTaskStop, recordTaskEvidence, transitionTask } from '../../../src/dsh/task-state.js'
import { assessTaskCompletion } from '../../../src/dsh/task-completion.js'
import { saveExecutionFrame, updateExecutionFrame } from '../../../src/dsh/execution-frame.js'
import { runMemoryAwareVerifiers } from '../../../src/enno-oduno/memory-verification.js'
import { RepositoryAuditError } from '../../../src/enno-oduno/verifier.js'

// Install at tests/dsh/integration/memory-optional-completion.test.ts.
// Frozen proposal tests: not executed while the governed product source is active.
const memorySql = /\b(?:task_memory_[a-z_]+|dsh_memory_[a-z_]+|memory_review_[a-z_]+|memory_evolution_[a-z_]+|auto_global_[a-z_]+)\b/u
const memoryTables = ['entries', 'entry_revisions', 'dsh_memory_finalizations', 'memory_review_jobs',
  'memory_review_effects', 'memory_evolution_jobs', 'auto_global_application_receipts', 'dsh_memory_observations']

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'optional-memory-completion-')))
  const root = join(base, 'repo')
  await mkdir(root)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete (env as Record<string, string | undefined>)[key]
  execFileSync('git', ['init', '--quiet', root], { env })
  await writeFile(join(root, 'check.mjs'), 'console.log("observed verifier output"); process.exit(Number(process.argv[2] ?? 0))\n')
  const db = openConnection(join(base, 'state.sqlite3'))
  migrateDatabase(db, join(process.cwd(), 'migrations'))
  await resolveProjectWorkspace(db, root)
  let fault: ((sql: string) => boolean) | undefined
  const accesses: string[] = []
  const gated: SqliteDatabase = { filePath: db.filePath, close() {}, exec(sql) {
    if (fault?.(sql)) { accesses.push(sql); throw new Error('optional memory unavailable') }
    db.exec(sql)
  }, prepare(sql) {
    if (fault?.(sql)) { accesses.push(sql); throw new Error('optional memory unavailable') }
    return db.prepare(sql)
  } }
  const runtime = { withDatabase: async <T>(operation: (database: SqliteDatabase) => T | Promise<T>) => operation(gated) }
  const tasks = new CoreTasks(runtime as any)
  const task = await tasks.prepare({ requestId: 'optional-memory-task', sessionId: 'session', turn: 1,
    task: 'Read check.mjs and report its behavior without modifying files.', cwd: root,
    capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }],
    profileHints: { taskType: 'research', target: 'check.mjs', expected: 'Report behavior', constraints: null },
    signal: new AbortController().signal })
  assert.equal(task.admitted, true)
  assert.ok(task.authority)
  const identity = { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: root }
  const counts = () => Object.fromEntries(memoryTables.map(name => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n]))
  const pending = () => {
    // A legacy delivery references an unavailable source. Its memory readiness
    // remains false; task completion must not require fabricating a decision.
    // Seed it independently of whether the new admission path creates bindings.
    db.prepare('INSERT OR IGNORE INTO task_memory_bindings(run_id,workspace,session_id,repository_root,generation,mode,retrieval,required_json) VALUES(?,?,?,?,1,?,?,?)')
      .run(task.runId, task.workspace, task.sessionId, root, 'code', 'delivered', '[]')
    db.prepare("UPDATE task_memory_bindings SET mode='code',required_json=? WHERE run_id=?")
      .run(JSON.stringify([{ entryId: 'missing-legacy-memory', revision: 1, deliveryId: 'legacy-delivery' }]), task.runId)
    assert.equal(memoryApplicationStatus(db, task.runId).ready, false)
  }
  return { base, root, db, gated, runtime, tasks, task, identity, accesses, counts, pending,
    setFault(value?: (sql: string) => boolean) { fault = value },
    async close() { db.close(); await rm(base, { recursive: true, force: true }) } }
}

for (const unavailable of [false, true]) test(`Core completion preserves the real outcome with ${unavailable ? 'unavailable' : 'pending'} memory`, async () => {
  const f = await fixture()
  try {
    f.pending()
    const before = f.counts()
    if (unavailable) f.setFault(sql => memorySql.test(sql))
    await f.tasks.finish(f.task, 'completed')
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get(f.task.runId)?.status, 'completed')
    assert.equal(f.db.prepare('SELECT 1 FROM dsh_execution_owners WHERE run_id=?').get(f.task.runId), undefined)
    assert.deepEqual(f.counts(), before, 'completion must neither save nor schedule memory')
    assert.deepEqual(f.accesses, [], 'Core completion must not query optional-memory readiness')
  } finally { await f.close() }
})

test('common ledger completion does not depend on memory and retains immutable terminal outcomes', async () => {
  const f = await fixture()
  try {
    f.pending(); f.setFault(sql => memorySql.test(sql))
    const before = f.counts(), store = new LedgerStore(f.gated)
    store.updateRunStatus(f.task.runId, 'completed')
    assert.equal(store.readRun(f.task.runId)?.status, 'completed')
    assert.throws(() => store.updateRunStatus(f.task.runId, 'failed'), /Terminal ledger run cannot change/)
    assert.deepEqual(f.counts(), before)
    assert.deepEqual(f.accesses, [])
  } finally { await f.close() }
})

function lifecycleFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const events: string[] = []
  const session = { id: f.task.sessionId }, agent = { id: 'native-agent', session }
  const item: any = { runId: f.task.runId, sessionId: session.id, agentId: agent.id,
    workspace: f.task.workspace, repositoryRoot: f.root, cwd: f.root, turn: 1, authority: f.task.authority!,
    nativeSession: session, nativeAgent: agent, failed: false, closed: false }
  const forbidden = () => { events.push('forbidden-memory-scheduling'); throw new Error('optional memory unavailable') }
  const lifecycle = createLifecycle({ runtime: f.runtime as any, sessions: undefined,
    sessionMirror: { markUnfinalized: forbidden } as any,
    memoryFinalizer: { scheduleInTransaction: forbidden, kick: forbidden } as any,
    autoReview: { worker: { abort() { events.push('memory-abort'); throw new Error('optional cleanup failed') } } } as any,
    answerReview: { finish: async () => { events.push('answer-finished') } } as any,
    ennoController: { retire: () => events.push('retired') } as any,
    ennoMemory: { clear() { events.push('memory-clear'); throw new Error('optional cleanup failed') } } as any,
    executionSupport: { clear: () => events.push('execution-clear') } as any,
    gate: { clearTurn: () => events.push('turn-clear') } as any,
    turnState: { allTurns: () => [item], releaseRun: () => events.push('released') } as any,
    getSelection: () => undefined, currentSession: () => item, currentForAgentEvent: () => item,
    stateForRun: () => ({} as any), deliverCompletionReport: async () => undefined,
    reviewBinding: () => ({} as any), evolutionConfig: { mode: 'active' } as any,
    clearToolRun: () => events.push('tools-clear'), sessionEventSource: () => ({} as any) })
  return { lifecycle, events, item }
}

for (const outcome of ['completed', 'failed', 'cancelled'] as const) test(`full-host ${outcome} is unchanged by memory outage and never schedules automatic memory`, async () => {
  const f = await fixture(), h = lifecycleFixture(f)
  try {
    f.pending(); const before = f.counts()
    f.setFault(sql => memorySql.test(sql))
    await h.lifecycle.runLifecycle.closeTurn({ runId: f.task.runId, authority: f.task.authority!, status: outcome, sourceEndSeq: 4 })
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get(f.task.runId)?.status, outcome)
    assert.equal(h.item.closed, true)
    assert.ok(h.events.includes('released')); assert.ok(h.events.includes('tools-clear'))
    assert.ok(!h.events.includes('forbidden-memory-scheduling'))
    assert.deepEqual(f.counts(), before)
    assert.deepEqual(f.accesses, [])
  } finally { await h.lifecycle.runLifecycle.dispose(); await f.close() }
})

test('optional-memory removal preserves native evidence, identity and explicit Stop controls', async () => {
  const f = await fixture(), h = lifecycleFixture(f)
  try {
    f.setFault(sql => memorySql.test(sql))
    const before = f.db.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get(f.task.runId)
    await assert.rejects(f.tasks.finish({ ...f.task, sessionId: 'foreign' }, 'completed'), /identity mismatch|owner mismatch/)
    assert.deepEqual(f.db.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get(f.task.runId), before)
    saveExecutionFrame(f.db, f.task.runId, updateExecutionFrame(undefined, f.root, '報告する\n完了条件:\n- 検査が成功'))
    f.db.prepare("UPDATE dsh_completion_runs SET mode='enforce' WHERE run_id=?").run(f.task.runId)
    assert.ok(assessTaskCompletion(f.db, f.task.runId).required > 0, 'negative control must have real explicit completion criteria')
    assert.equal(assessTaskCompletion(f.db, f.task.runId).verified, false)
    await assert.rejects(f.tasks.finish(f.task, 'completed'), /Required coding Goal evidence/)
    await assert.rejects(h.lifecycle.runLifecycle.closeTurn({ runId: f.task.runId, authority: f.task.authority!, status: 'completed', sourceEndSeq: 4 }), /completion evidence is unresolved/)
    f.db.prepare("UPDATE dsh_completion_runs SET mode='shadow' WHERE run_id=?").run(f.task.runId)
    const working = readTaskSnapshot(f.db, f.task.authority!)
    const stopping = requestTaskStop(f.db, working, { operation: 'ignore', operationId: 'explicit-stop',
      expectedRevision: working.revision, expectedGeneration: working.generation, reason: 'User explicitly stops this task' })
    assert.ok(stopping.pendingStop)
    assert.throws(() => authorizeTaskLease(f.db, f.task.authority!), /stale or stopped/)
    await assert.rejects(f.tasks.finish(f.task, 'completed'), /stale or stopped/)
    await h.lifecycle.runLifecycle.closeTurn({ runId: f.task.runId, authority: f.task.authority!, status: 'completed', sourceEndSeq: 4 })
    assert.deepEqual(readTaskSnapshot(f.db, working), stopping, 'stale completion cannot override a pending Stop')
    assert.equal(h.item.closed, false)
  } finally { await h.lifecycle.runLifecycle.dispose(); await f.close() }
})

test('native Done and confirmed Stop preserve checkpoints and receipts without finalizer scheduling', { timeout: 10_000 }, async () => {
  for (const action of ['done', 'stop'] as const) {
    const f = await fixture()
    let service: DshTaskWorkflow | undefined
    try {
      const session = { id: f.task.sessionId, seq: 5, header: { cwd: f.root } }
      const agent = { id: 'native-review-agent', session, status: 'idle', whenIdle: async () => {} }
      let checkpoints = 0, kicks = 0
      let arrived!: () => void
      const arrival = new Promise<void>(resolve => { arrived = resolve })
      service = new DshTaskWorkflow({ runtime: f.runtime as any,
        agents: new Map([[agent.id, agent]]), sessions: new Map([[session.id, session]]),
        skills: { snapshot: async () => ({ complete: true, skills: [] }) }, tools: { schemas: () => [] },
        checkpointSource: async () => { checkpoints++; session.seq = 9 },
        kickFinalizer: () => { kicks++ }, onCompleted: () => arrived(),
        emit: task => { if (task.state === 'Ignore') arrived() } })
      const working = readTaskSnapshot(f.db, f.task.authority!)
      const lease = captureTaskLease(f.db, working)
      f.setFault(sql => memorySql.test(sql))
      if (action === 'done') {
        recordTaskEvidence(f.db, working, { ref: 'host-observed-test-proof', kind: 'verification', generation: working.generation, verified: true })
        const done = transitionTask(f.db, working, { operation: 'complete', operationId: 'verified-complete', expectedRevision: working.revision,
          expectedGeneration: working.generation, reason: 'Host evidence confirms the work', evidence: ['host-observed-test-proof'] })
        service.finishCompletion(agent, done)
      } else {
        const stopping = requestTaskStop(f.db, working, { operation: 'ignore', operationId: 'confirmed-stop', expectedRevision: working.revision,
          expectedGeneration: working.generation, reason: 'User explicitly stops this task' })
        assert.throws(() => authorizeTaskLease(f.db, lease), /stale or stopped/)
        service.finishStop(agent, stopping)
      }
      await arrival
      assert.equal(checkpoints, 1); assert.equal(kicks, 0)
      assert.equal(readTaskSnapshot(f.db, working).state, action === 'done' ? 'Done' : 'Ignore')
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get()?.n, 0)
      assert.deepEqual(f.accesses, [], 'native completion and Stop must not touch finalizer storage')
      assert.ok(f.db.prepare('SELECT 1 FROM ledger_task_evidence WHERE run_id=? AND kind=? AND verified=1')
        .get(f.task.runId, action === 'done' ? 'verification' : 'stopped'))
    } finally { service?.dispose(); await f.close() }
  }
})

for (const exit of [0, 7]) test(`benign approved verifier runs once with unavailable memory and preserves exit ${exit}`, async () => {
  const f = await fixture()
  try {
    f.setFault(() => true)
    let calls = 0
    const results = await runMemoryAwareVerifiers(f.gated, f.task.runId,
      [{ id: 'benign-observation', kind: 'custom', executable: process.execPath, args: ['check.mjs', String(exit)], cwd: '.', timeoutMs: 5000 }], f.root,
      { descendantSettleMs: 0, spawn: ((...args: Parameters<typeof spawn>) => { calls++; return spawn(...args) }) as typeof spawn })
    assert.equal(calls, 1)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.exitCode, exit)
    assert.equal(results[0]!.status, exit === 0 ? 'passed' : 'failed')
    assert.match(results[0]!.stdoutPreview, /observed verifier output/)
    assert.equal(results[0]!.changedDuringVerification, false)
  } finally { await f.close() }
})

test('unavailable memory never masks repository audit failure or verifier cwd rejection', async () => {
  const f = await fixture()
  try {
    f.setFault(() => true)
    const spec = { id: 'safety-control', kind: 'custom' as const, executable: process.execPath, args: ['check.mjs'], cwd: '.', timeoutMs: 5000 }
    let calls = 0
    const dependencies = { descendantSettleMs: 0, spawn: ((...args: Parameters<typeof spawn>) => { calls++; return spawn(...args) }) as typeof spawn }
    await assert.rejects(runMemoryAwareVerifiers(f.gated, f.task.runId, [spec], f.root,
      { ...dependencies, captureRepositoryState: () => { throw new Error('actual audit failure') } }), RepositoryAuditError)
    await assert.rejects(runMemoryAwareVerifiers(f.gated, f.task.runId, [{ ...spec, cwd: '..' }], f.root, dependencies), /Verifier cwd must stay inside/)
    assert.equal(calls, 0, 'optional memory isolation must not bypass native verifier validation')
  } finally { await f.close() }
})

test('failed post-execution memory publication preserves real verifier output without inventing saved proof', async () => {
  const f = await fixture()
  try {
    f.pending()
    const memory = recordEntry(f.db, { workspace: f.task.workspace, kind: 'lesson', title: 'Observed verifier', body: 'Check the script before reusing it.', createdBy: 'fixture' })
    f.db.prepare("UPDATE task_memory_bindings SET mode='code',required_json=? WHERE run_id=?")
      .run(JSON.stringify([{ entryId: memory.id, revision: memory.revision, deliveryId: 'fixture-legacy-delivery' }]), f.task.runId)
    const status = memoryApplicationStatus(f.db, f.task.runId)
    assert.equal(status.supported, true)
    const command = `${process.execPath} check.mjs`
    recordMemoryApplicationReview(f.db, f.identity, 'review-proof', { generation: status.supported ? status.generation : 1,
      entryId: memory.id, entryRevision: memory.revision, expectedRevision: 0, decision: 'adopted',
      basis: 'The current script reports a typed exit.', paths: ['check.mjs'], invariant: 'Only actual typed results count.',
      counterexample: 'A text success claim without execution is insufficient.', method: 'Run check.mjs.', command })
    let calls = 0
    const results = await runMemoryAwareVerifiers(f.gated, f.task.runId,
      [{ id: 'post-publication', kind: 'custom', executable: process.execPath, args: ['check.mjs'], cwd: '.', timeoutMs: 5000 }], f.root,
      { descendantSettleMs: 0, spawn: ((...args: Parameters<typeof spawn>) => {
        calls++; f.setFault(sql => memorySql.test(sql)); return spawn(...args)
      }) as typeof spawn })
    assert.equal(calls, 1); assert.equal(results[0]!.status, 'passed')
    assert.match(results[0]!.stdoutPreview, /observed verifier output/)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM task_memory_executions WHERE run_id=? AND outcome='passed'").get(f.task.runId)?.n, 0)
    assert.ok(f.accesses.length > 0, 'this control must exercise failed publication after real execution')
  } finally { await f.close() }
})
