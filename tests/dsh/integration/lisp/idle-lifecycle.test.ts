import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

const native = { skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 90000 }
async function fixture(idleTimeoutMs = 300000, questions?: DshUserQuestions) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-idle-'))), root = join(base, 'work')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db))
  const manager = new LispManager({ store, dataRoot: join(base, 'data'), ...(questions ? { questions } : {}),
    config: LispConfig.parse({ enabled: true, maxWorkers: 1, idleTimeoutMs, startupTimeoutMs: 60000, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl' }) })
  await manager.start()
  const owner = (id: string): LispOwner => ({ sessionId: id, agentId: id, root })
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

test('worker slots are reused across idle conversations; replay never wakes or repeats effects', native, async () => {
  const f = await fixture(), first = f.owner('first')
  try {
    await f.manager.enable(first)
    const original = await status(f.manager, first)
    const input = { operationId: 'saved-effect', code: '(defparameter *old* 7) (kioku.files:propose-write "once.txt" "original")' }
    assert.equal((await f.manager.execute(first, 'lisp_eval', input) as any).ok, true)
    for (let i = 0; i < 5; i++) assert.equal((await f.manager.enable(f.owner(`next-${i}`)) as any).state, 'READY')
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
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    assert.equal((await evaluation as any).ok, true)
    const job = await f.manager.execute(first, 'lisp_eval', { operationId: 'job', code: '(kioku.process:start-job "python3" (list "-I" "-c" "import time; time.sleep(1)") :timeout-ms 5000)' }) as any
    assert.equal(job.ok, true)
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    await until(async () => (await status(f.manager, first)).jobs.every((j: any) => j.state !== 'RUNNING'))
    await f.store.reserve(first, 'uncertain', 'proposal', 'digest', 'generation', {})
    await f.store.transition(first, 'uncertain', ['RUNNING'], 'UNKNOWN', {})
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    assert.equal((await status(f.manager, first)).state, 'READY')
    await f.store.transition(first, 'uncertain', ['UNKNOWN'], 'ABANDONED', {})
    assert.equal((await f.manager.enable(second) as any).state, 'READY')
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
    await assert.rejects(f.manager.enable(second), { code: 'WORKER_LIMIT' })
    t.mock.restoreAll()
    assert.equal((await f.manager.prepare(first) as any).state, 'RECOVERY_REQUIRED')
    await f.manager.execute(first, 'lisp_cancel', {})
    assert.equal((await f.manager.prepare(second) as any).state, 'READY')
  } finally { t.mock.restoreAll(); await f.close() }
})
