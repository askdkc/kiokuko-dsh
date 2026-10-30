import { workingLispTask } from '../../helpers/lisp-task.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, LispError, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import { findSessionTask, requestTaskStop } from '../../../../src/dsh/task-state.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

const native = { skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 90000 }
async function fixture(idleTimeoutMs = 300000, questions?: DshUserQuestions) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-idle-'))), root = join(base, 'work')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  migrateDatabase(db)
  const store = new LispStore(async fn => fn(db))
  const manager = new LispManager({ store, dataRoot: join(base, 'data'), ...(questions ? { questions } : {}),
    config: LispConfig.parse({ executionMode: 'protected', enabled: true, maxWorkers: 1, idleTimeoutMs, startupTimeoutMs: 60000, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl' }) })
  await manager.start()
  const owner = (id: string): LispOwner => {
    const binding = { sessionId: id, agentId: id, root }; workingLispTask(db, binding); return binding
  }
  return { manager, store, root, owner, async close() { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) } }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'lifecycle did not reach the expected state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const status = (manager: LispManager, owner: LispOwner) => manager.status(owner) as Promise<any>

test('capacity pressure preserves repository workers; replay never wakes or repeats effects', native, async () => {
  const f = await fixture(), first = f.owner('first')
  try {
    await f.manager.enable(first)
    const original = await status(f.manager, first)
    const input = { operationId: 'saved-effect', code: '(defparameter *old* 7) (kioku.files:propose-write "once.txt" "original")' }
    assert.equal((await f.manager.execute(first, 'lisp_eval', input) as any).ok, true)
    for (let i = 0; i < 5; i++) await assert.rejects(f.manager.enable(f.owner(`next-${i}`)), { code: 'WORKER_LIMIT' })
    const retained = await status(f.manager, first)
    assert.equal(retained.state, 'READY'); assert.equal(retained.runtimePid, original.runtimePid); assert.equal(retained.generation, original.generation)
    assert.equal((await f.manager.execute(first, 'lisp_eval', { operationId: 'retained-state', code: '*old*' }) as any).value.printed, '(7)')
    await f.manager.disposeSession(first.sessionId)
    assert.equal((await status(f.manager, first)).state, 'SUSPENDED')
    assert.equal(f.manager.enabled.has(first.sessionId), true)
    await writeFile(join(f.root, 'once.txt'), 'edited later')
    const replay = await f.manager.execute(first, 'lisp_eval', input) as any
    assert.equal(replay.replay, true)
    assert.equal((await status(f.manager, first)).state, 'SUSPENDED', 'saved evidence must not allocate a worker')
    assert.equal(await readFile(join(f.root, 'once.txt'), 'utf8'), 'edited later')
    const resumed = await f.manager.execute(first, 'lisp_eval', { operationId: 'new-effect', code: '(kioku.files:propose-write "unexpected.txt" "bad")' }) as any
    assert.equal(resumed.code, 'WORKER_RESUMED'); assert.equal(resumed.executed, false)
    assert.notEqual(resumed.generation, original.generation)
    await assert.rejects(readFile(join(f.root, 'unexpected.txt')), { code: 'ENOENT' })
    assert.equal(await f.store.get(first, 'new-effect'), undefined, 'unexecuted requests are not recorded as effects')
    assert.equal((await f.manager.execute(first, 'lisp_eval', { operationId: 'fresh-state', code: '(boundp (quote *old*))' }) as any).value.printed, '(NIL)')
    await f.manager.execute(first, 'lisp_cancel', {})
    assert.equal((await f.manager.prepare(first) as any).state, 'RECOVERY_REQUIRED', 'explicit cancel never auto-recovers')
  } finally { await f.close() }
})

test('idle timeout releases workers despite status polling, while active turns are protected', native, async () => {
  const f = await fixture(1000), first = f.owner('active'), second = f.owner('waiting')
  try {
    await f.manager.enable(first, true)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal((await status(f.manager, first)).state, 'READY')
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    assert.equal((await status(f.manager, second)).state, 'SUSPENDED', 'capacity pressure is not abnormal recovery')
    f.manager.setAgentBusy(first, false)
    await until(async () => (await status(f.manager, first)).state === 'SUSPENDED')
    assert.equal((await f.manager.prepare(second) as any).state, 'READY')
    await f.manager.disposeSession(second.sessionId)
    assert.equal((await status(f.manager, second)).state, 'SUSPENDED')
    assert.equal((await f.manager.prepare(second) as any).state, 'READY', 'a normally disposed conversation can reopen')
  } finally { await f.close() }
})

test('evaluation, approval, background jobs and uncertain journal entries are never evicted', native, async () => {
  let decline: (() => void) | undefined
  const f = await fixture(300000, { ask: request => new Promise(resolve => {
    decline = () => resolve({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![0]!.label] }] })
  }) }), first = f.owner('working'), second = f.owner('new')
  try {
    await f.manager.enable(first)
    const evaluation = f.manager.execute(first, 'lisp_eval', { operationId: 'slow', code: '(sleep 0.3) 42' })
    await until(async () => (await status(f.manager, first)).state === 'EVALUATING')
    assert.equal(f.manager.taskJobsIdle(first), true, 'pure evaluation is not a background job')
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    assert.equal((await evaluation as any).ok, true)
    const job = await f.manager.execute(first, 'lisp_eval', { operationId: 'job', code: '(kioku.process:start-job "python3" (list "-I" "-c" "import time; time.sleep(1)") :timeout-ms 5000)' }) as any
    assert.equal(job.ok, true)
    assert.equal(f.manager.taskJobsIdle(first), false, 'the protected process prevents completion')
    assert.equal(f.manager.taskJobsIdle({ ...first, agentId: 'another-agent' }), false, 'all agents in the task session share the job observation')
    assert.equal(f.manager.taskJobsIdle(second), true, 'another session is independent')
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    await until(async () => (await status(f.manager, first)).jobs.every((j: any) => j.state !== 'RUNNING'))
    assert.equal(f.manager.taskJobsIdle(first), true)
    await f.store.reserve(first, 'uncertain', 'proposal', 'digest', 'generation', {})
    await f.store.transition(first, 'uncertain', ['RUNNING'], 'UNKNOWN', {})
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    assert.equal((await status(f.manager, first)).state, 'READY')
    await f.store.transition(first, 'uncertain', ['UNKNOWN'], 'ABANDONED', {})
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' }, 'settled work does not authorize evicting a repository owner')
    await f.manager.disposeSession(first.sessionId)
    assert.equal((await f.manager.enable(second) as any).state, 'READY')
    await f.manager.disposeSession(second.sessionId)
    await f.manager.prepare(first)
    await writeFile(join(f.root, 'keep.txt'), 'keep')
    const approval = f.manager.execute(first, 'lisp_eval', { operationId: 'approval', code: '(kioku.files:propose-delete "keep.txt")' })
    await until(async () => decline !== undefined)
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    assert.equal((await status(f.manager, first)).state, 'EVALUATING')
    decline!(); await approval
    assert.equal(await readFile(join(f.root, 'keep.txt'), 'utf8'), 'keep')
  } finally { decline?.(); await f.close() }
})

test('concurrent cold admission never exceeds maxWorkers', native, async () => {
  const f = await fixture()
  try {
    const owners = Array.from({ length: 4 }, (_, i) => f.owner(`parallel-${i}`))
    const outcomes = await Promise.allSettled(owners.map(owner => f.manager.enable(owner, true)))
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'WORKER_LIMIT')
    const states = await Promise.all(owners.map(owner => status(f.manager, owner)))
    assert.equal(states.filter(s => s.state === 'READY').length, 1)
    assert.equal(states.filter(s => s.state === 'SUSPENDED').length, 3)
  } finally { await f.close() }
})

test('an unhealthy worker still occupies its slot until termination is confirmed', native, async t => {
  const f = await fixture(), first = f.owner('unconfirmed'), second = f.owner('blocked')
  try {
    await f.manager.enable(first)
    // Model a broken connection while the supervised process is still alive.
    t.mock.getter(LispWorker.prototype, 'healthy', () => false)
    assert.equal((await status(f.manager, first)).state, 'RECOVERY_REQUIRED')
    assert.equal(f.manager.taskJobsIdle(first), false, 'a broken live supervisor is not confirmed idle')
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    t.mock.method(LispWorker.prototype, 'stop', async () => { throw new LispError('STOP_UNCONFIRMED', 'fixture stop unconfirmed') })
    assert.equal((await f.manager.execute(first, 'lisp_cancel', {}) as any).code, 'STOP_UNCONFIRMED')
    assert.equal(f.manager.taskJobsIdle(first), false, 'unconfirmed termination cannot be completion evidence')
    t.mock.restoreAll()
    assert.equal((await f.manager.prepare(first) as any).state, 'STOP_UNCONFIRMED')
    await f.manager.execute(first, 'lisp_cancel', {})
    assert.equal(f.manager.taskJobsIdle(first), true, 'confirmed cancellation drains local jobs')
    assert.equal((await f.manager.prepare(second) as any).state, 'READY')
  } finally { t.mock.restoreAll(); await f.close() }
})

test('task-stop disposal drains a real protected background job after its execution lease is revoked', native, async t => {
  const f = await fixture(), owner = f.owner('task-stop')
  const start = LispWorker.prototype.start
  let worker: LispWorker | undefined
  t.mock.method(LispWorker.prototype, 'start', async function(this: LispWorker) { worker = this; return start.call(this) })
  try {
    await f.manager.enable(owner)
    const result = await f.manager.execute(owner, 'lisp_eval', { operationId: 'background',
      code: '(kioku.process:start-job "python3" (list "-I" "-c" "import time; time.sleep(30)"))' }) as any
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(worker?.hasRunningJobs)
    assert.equal(f.manager.taskJobsIdle(owner), false)
    const jobs = [...worker.jobs.values()]
    assert.equal(jobs.length, 1)
    const supervisorPid = jobs[0]!.child.pid!
    process.kill(supervisorPid, 0)
    await f.store.database(db => {
      const task = findSessionTask(db, { sessionId: owner.sessionId, repositoryRoot: owner.root })!
      requestTaskStop(db, task, { operation: 'wait', operationId: 'stop-request', expectedRevision: task.revision,
        reason: 'Stop the real protected background job' })
    })
    await f.manager.disposeSession(owner.sessionId)
    assert.equal(worker.stopped, true)
    assert.equal(worker.hasRunningJobs, false)
    assert.equal(f.manager.taskJobsIdle(owner), true)
    assert.ok(jobs.every(job => job.settled), 'all supervised background receipts must settle before disposal returns')
    assert.throws(() => process.kill(supervisorPid, 0), { code: 'ESRCH' })
    assert.equal((await status(f.manager, owner)).state, 'SUSPENDED')
  } finally { await f.close() }
})
