import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { CompiledLispCache } from '../../../../src/dsh/lisp/compiled-cache.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { recordTaskEvidence, transitionTask } from '../../../../src/dsh/task-state.js'

for (const action of ['cancel', 'dispose', 'dispose-session'] as const) {
  test(`task ${action} aborts and waits for preflight before reporting stopped`, { timeout: 10000 }, async t => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-preflight-cancel-'))), root = join(base, 'workspace')
    await mkdir(root); await mkdir(join(base, 'runtime'))
    const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
    migrateDatabase(db)
    const owner = { sessionId: 'session', agentId: 'agent', root }
    const store = new LispStore(async fn => fn(db))
    const manager = new LispManager({ store, dataRoot: join(base, 'runtime'), config: LispConfig.parse({ enabled: true, executionMode: 'development' }) })
    let entered!: () => void, release!: () => void, compileSignal!: AbortSignal, starts = 0
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    t.mock.method(CompiledLispCache.prototype, 'ensure', async (signal: AbortSignal) => {
      compileSignal = signal; entered()
      await gate
      // Deliberately return despite cancellation: the manager must revalidate.
      return { key: 'fixture', path: base, reused: true, prepareMs: 0 }
    })
    t.mock.method(LispWorker.prototype, 'start', async () => { starts++; throw new Error('cancelled task must never start a worker') })
    try {
      await manager.enableTask(owner)
      const evaluation = manager.execute(owner, 'lisp_eval', { operationId: 'cancelled-evaluation', code: '(+ 20 22)' })
      await preparing
      let stopped = false
      const stopping = (action === 'cancel' ? manager.execute(owner, 'lisp_cancel', {})
        : action === 'dispose' ? manager.dispose() : manager.disposeSession(owner.sessionId)).then(value => { stopped = true; return value })
      await new Promise<void>(resolve => setImmediate(resolve))
      const wasAborted = compileSignal.aborted, acknowledgedEarly = stopped, idleWhileStopping = manager.taskJobsIdle(owner)
      release()
      const result = await evaluation as { ok: boolean; code: string }
      await stopping
      assert.equal(starts, 0, 'cancelled preflight never starts a worker after its compilation gate opens')
      assert.equal(wasAborted, true, 'cancel reaches task runtime preparation')
      assert.equal(acknowledgedEarly, false, 'stop acknowledgement waits for preflight cleanup')
      assert.equal(idleWhileStopping, false, 'stopping preflight must not be reported idle')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'CANCELLED')
      assert.notEqual((await store.get(owner, 'cancelled-evaluation'))!.state, 'SUCCEEDED')
    } finally { release(); await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
  })
}

test('worker stopped while resolving its launch never spawns a supervisor', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-worker-start-cancel-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const worker = new LispWorker({ base, scratch: base, inputs: base, cache: base, library: base, workspace: base, protected: false },
    LispConfig.parse({ sbclPath: process.execPath, executionMode: 'development' }))
  const starting = worker.start().then(() => undefined, error => error as { code: string })
  await worker.stop()
  const error = await starting
  assert.equal(worker.supervisorPid, null)
  assert.equal(error?.code, 'CANCELLED')
  assert.equal(worker.stopped, true)
})

for (const method of ['start-job', 'tool-call'] as const) {
  test(`${method} keeps a started job cancellable when its acknowledgement has stale task authority`, async t => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-stale-job-'))), root = join(base, 'workspace'), dataRoot = join(base, 'runtime')
    await mkdir(root); await mkdir(dataRoot)
    const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
    const owner = { sessionId: 'session', agentId: 'agent', root }
    const task = workingLispTask(db, owner)
    const store = new LispStore(async fn => fn(db)), cancelled: string[] = []
    t.mock.method(CompiledLispCache.prototype, 'ensure', async () => ({ key: 'fixture', path: base, reused: true, prepareMs: 0 }))
    t.mock.method(LispWorker.prototype, 'start', async () => {})
    t.mock.getter(LispWorker.prototype, 'healthy', () => true)
    t.mock.method(LispWorker.prototype, 'request', async function(this: LispWorker) {
      const args = method === 'start-job' ? { program: 'node', argv: ['--version'], timeoutMs: 1000 }
        : { name: 'kioku_exec', args: { command: 'node --version', background: true } }
      await this.hostCall!(method, args, { generation: this.generation, evaluationId: 'fixture-evaluation', rpcId: 'fixture-rpc', signal: new AbortController().signal })
      throw new Error('stale job acknowledgement must not return success')
    })
    const manager = new LispManager({ store, dataRoot, config: LispConfig.parse({ enabled: true, executionMode: 'development' }),
      toolCall: async (_owner, name, args) => {
        if (name === 'kioku_result') { assert.equal(args.cancel, true); cancelled.push(String(args.operationId)); return { receipt: { state: 'cancelled', operationId: args.operationId, processStopped: true } } }
        assert.equal(name, 'kioku_exec')
        recordTaskEvidence(db, task, { ref: 'stopped', kind: 'stopped', generation: task.generation, verified: true })
        const pending = transitionTask(db, task, { operation: 'wait', operationId: 'wait', expectedRevision: task.revision, reason: 'Fixture revokes old authority', evidence: ['stopped'] })
        transitionTask(db, pending, { operation: 'resume', operationId: 'resume', expectedRevision: pending.revision, explicit: true, reason: 'Fixture starts a new generation' })
        return { receipt: { state: 'started', operationId: 'old-background-job' } }
      } })
    try {
      await manager.enable(owner)
      const result = await manager.execute(owner, 'lisp_eval', { operationId: 'start-job-evaluation', code: '(+ 20 22)' }) as { ok: boolean; code: string }
      assert.equal(result.ok, false)
      assert.equal(result.code, 'TASK_STATE_CONFLICT')
      assert.notEqual((await store.get(owner, 'start-job-evaluation'))!.state, 'SUCCEEDED')
      await manager.execute(owner, 'lisp_cancel', {})
      assert.deepEqual(cancelled, ['old-background-job'])
    } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
  })
}

test('cancellation keeps an owned job unresolved until its host receipt confirms termination', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-job-stop-receipt-'))), root = join(base, 'workspace'), dataRoot = join(base, 'runtime')
  await mkdir(root); await mkdir(dataRoot)
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  const owner = { sessionId: 'session', agentId: 'agent', root }
  workingLispTask(db, owner)
  const store = new LispStore(async fn => fn(db))
  let terminated = false, cancelCalls = 0
  t.mock.method(CompiledLispCache.prototype, 'ensure', async () => ({ key: 'fixture', path: base, reused: true, prepareMs: 0 }))
  t.mock.method(LispWorker.prototype, 'start', async () => {})
  t.mock.getter(LispWorker.prototype, 'healthy', () => true)
  t.mock.method(LispWorker.prototype, 'request', async function(this: LispWorker) {
    await this.hostCall!('start-job', { program: 'node', argv: ['--version'], timeoutMs: 1000 },
      { generation: this.generation, evaluationId: 'fixture-evaluation', rpcId: 'fixture-rpc', signal: new AbortController().signal })
    return { version: 1, type: 'result', id: 'fixture-evaluation', ok: true, value: 'started', proposals: [] }
  })
  const manager = new LispManager({ store, dataRoot, config: LispConfig.parse({ enabled: true, executionMode: 'development' }),
    toolCall: async (_owner, name, args) => {
      if (name === 'kioku_result') { assert.equal(args.cancel, true); cancelCalls++ }
      // A terminal acknowledgement alone is not a confirmed process stop.
      return { receipt: { state: name === 'kioku_result' ? 'completed' : 'started', operationId: 'background-job',
        processStopped: name === 'kioku_result' && terminated } }
    } })
  try {
    await manager.enable(owner)
    assert.equal((await manager.execute(owner, 'lisp_eval', { operationId: 'start', code: '(+ 20 22)' }) as any).ok, true)
    const cancelling = await manager.execute(owner, 'lisp_cancel', {}) as any
    assert.equal(cancelling.ok, false, 'an abort request is not confirmed process termination')
    assert.equal(cancelling.code, 'STOP_UNCONFIRMED')
    assert.equal(manager.taskJobsIdle(owner), false)
    const status = await manager.status(owner) as { jobs: { operationId?: string }[] }
    assert.ok(status.jobs.some(job => job.operationId === 'background-job'))
    terminated = true
    assert.equal((await manager.execute(owner, 'lisp_cancel', {}) as any).ok, true)
    assert.equal(cancelCalls, 2, 'the unresolved job is retained for the next explicit stop attempt')
  } finally { terminated = true; await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
