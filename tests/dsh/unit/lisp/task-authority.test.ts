import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LedgerStore } from '../../../../src/ledger/store.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { captureTaskLease, readTaskSnapshot, recordTaskEvidence, requestTaskStop, transitionTask, type TaskSnapshot } from '../../../../src/dsh/task-state.js'
import { withNoTaskAuthority, withTaskAuthority } from '../../../../src/dsh/task-authority-context.js'
import { LispTaskAuthority } from '../../../../src/dsh/lisp/task-authority.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { stageCandidate } from '../../../../src/dsh/lisp/candidate.js'
import { snapshot } from '../../../../src/dsh/lisp/files.js'
import { mountLispHttp } from '../../../../src/dsh/lisp/http.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

async function fixture(t: test.TestContext, working = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-task-authority-'))), root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  migrateDatabase(db)
  const owner = { sessionId: 'session', agentId: 'agent', root }
  const task = working ? workingLispTask(db, owner) : undefined
  const database = async <T>(action: (db: NodeSqliteAdapter) => T) => action(db)
  const authority = new LispTaskAuthority(database)
  const store = new LispStore(database, (connection, value) => authority.authorizePublication(connection, value))
  await store.enable(owner)
  t.after(async () => { db.close(); await rm(base, { recursive: true, force: true }) })
  return { base, root, owner, db, task, authority, store }
}

function wait(f: Awaited<ReturnType<typeof fixture>>, task = f.task!) {
  const ref = `stopped-${task.generation}`
  recordTaskEvidence(f.db, task, { ref, kind: 'stopped', generation: task.generation, verified: true })
  return transitionTask(f.db, task, { operation: 'wait', operationId: `wait-${task.generation}`, expectedRevision: task.revision, reason: 'Observed all work stopped', evidence: [ref] })
}
function resume(f: Awaited<ReturnType<typeof fixture>>, task: TaskSnapshot) {
  return transitionTask(f.db, task, { operation: 'resume', operationId: `resume-${task.generation}`, expectedRevision: task.revision, explicit: true, reason: 'Explicit new execution' })
}

for (const state of ['missing', 'ToDo', 'Working', 'Pending', 'Done', 'Ignore', 'failed', 'cancelled', 'interrupted', 'stopping'] as const) {
  test(`task authority state table: ${state}`, async t => {
    const f = await fixture(t, state !== 'missing')
    if (f.task) {
      if (state === 'Pending') wait(f)
      else if (state === 'Done') {
        recordTaskEvidence(f.db, f.task, { ref: 'verified', kind: 'verification', generation: f.task.generation, verified: true })
        transitionTask(f.db, f.task, { operation: 'complete', operationId: 'complete', expectedRevision: f.task.revision, reason: 'Observed completion', evidence: ['verified'] })
      } else if (state === 'Ignore') {
        const pending = wait(f)
        transitionTask(f.db, pending, { operation: 'ignore', operationId: 'ignore', expectedRevision: pending.revision, reason: 'Explicitly ignored' })
      } else if (state === 'ToDo') f.db.prepare("UPDATE ledger_runs SET task_state='ToDo' WHERE run_id=?").run(f.task.taskId)
      else if (['failed', 'cancelled', 'interrupted'].includes(state)) {
        new LedgerStore(f.db).updateRunStatus(f.task.taskId, state as 'failed' | 'cancelled' | 'interrupted')
        assert.equal(readTaskSnapshot(f.db, f.task).state, 'Pending')
        assert.equal(readTaskSnapshot(f.db, f.task).runStatus, state)
      } else if (state === 'stopping') requestTaskStop(f.db, f.task, { operation: 'wait', operationId: 'stop', expectedRevision: f.task.revision, reason: 'Stopping before wait' })
    }
    await f.authority.run(f.owner, async () => {
      assert.equal(6 * 7, 42, 'pure computation remains available in every state')
      if (state === 'Working') assert.equal((await f.authority.authorizeEffect(f.owner)).taskId, f.task!.taskId)
      else await assert.rejects(f.authority.authorizeEffect(f.owner), /Working|not Working|stopped|タスク/)
    })
  })
}

test('missing validator database blocks effects and evidence, but permits pure result persistence', async t => {
  const f = await fixture(t, false), authority = new LispTaskAuthority(async () => { throw new Error('database unavailable') })
  await authority.run(f.owner, async () => {
    assert.equal(authority.current()!.lease, undefined)
    authority.authorizePublication(f.db, f.owner)
    assert.throws(() => authority.authorizeEffectPublication(f.db, f.owner), { code: 'TASK_REQUIRED' })
    await assert.rejects(authority.authorizeEffect(f.owner), { code: 'TASK_STATE_UNAVAILABLE' })
  })
})

test('stop/resume cannot refresh a pinned execution, inherited lease, or detached background binding', async t => {
  const f = await fixture(t), lease = captureTaskLease(f.db, f.task!)
  let detached: ReturnType<LispTaskAuthority['current']>
  await f.authority.run(f.owner, async () => {
    detached = f.authority.current()
    await f.authority.authorizeEffect(f.owner)
    resume(f, wait(f))
    await assert.rejects(f.authority.authorizeEffect(f.owner), { code: 'TASK_STATE_CONFLICT' })
    assert.throws(() => f.authority.authorizeEffectPublication(f.db, f.owner), { code: 'TASK_STATE_CONFLICT' })
  })
  await assert.rejects(f.authority.bound(detached, () => f.authority.authorizeEffect(f.owner)), { code: 'TASK_STATE_CONFLICT' })
  await assert.rejects(withTaskAuthority(lease, () => f.authority.run(f.owner, () => f.authority.authorizeEffect(f.owner))), { code: 'TASK_STATE_CONFLICT' })
  await f.authority.run(f.owner, async () => assert.ok((await f.authority.authorizeEffect(f.owner)).generation > lease.generation))
})

test('task identity cannot be replaced by caller args, another session, agent, or repository', async t => {
  const f = await fixture(t)
  await f.authority.run(f.owner, async () => {
    for (const owner of [{ ...f.owner, sessionId: 'other' }, { ...f.owner, agentId: 'other' }, { ...f.owner, root: f.base }])
      await assert.rejects(f.authority.authorizeEffect(owner), { code: 'TASK_OWNER_MISMATCH' })
  })
  const lease = captureTaskLease(f.db, f.task!)
  await assert.rejects(withTaskAuthority({ ...lease, sessionId: 'foreign' }, () => f.authority.run(f.owner, async () => 42)), { code: 'TASK_OWNER_MISMATCH' })
})

test('compiled execution begun without a task never rebinds to one created later', async t => {
  const f = await fixture(t, false)
  await withNoTaskAuthority(async () => {
    workingLispTask(f.db, f.owner)
    await f.authority.run(f.owner, async () => {
      assert.equal(f.authority.current()!.lease, undefined)
      assert.equal(6 * 7, 42)
      await assert.rejects(f.authority.authorizeEffect(f.owner), { code: 'TASK_REQUIRED' })
    })
  })
  await f.authority.run(f.owner, async () => assert.ok((await f.authority.authorizeEffect(f.owner)).taskId))
})

test('successful effect receipt is CAS checked inside its database write, while read receipts remain available', async t => {
  const f = await fixture(t)
  await f.authority.run(f.owner, async () => {
    await f.store.reserve(f.owner, 'effect', 'lisp_eval', 'effect-digest', 'worker', {})
    await f.authority.authorizeEffect(f.owner)
    wait(f)
    await assert.rejects(f.store.transition(f.owner, 'effect', ['RUNNING'], 'SUCCEEDED', { ok: true }), { code: 'TASK_STATE_CONFLICT' })
    assert.equal((await f.store.get(f.owner, 'effect'))!.state, 'RUNNING')
    await f.store.transition(f.owner, 'effect', ['RUNNING'], 'UNKNOWN', { code: 'TASK_STATE_CONFLICT' })
  })
  await f.authority.run(f.owner, async () => {
    await f.store.reserve(f.owner, 'read', 'lisp_observe', 'read-digest', 'host', {})
    await f.store.transition(f.owner, 'read', ['RUNNING'], 'SUCCEEDED', { value: 42 })
    assert.equal((await f.store.get(f.owner, 'read'))!.state, 'SUCCEEDED')
  })
})

const approved: DshUserQuestions = { ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.intent!.approve!] }] }) }

for (const boundary of ['missing', 'working', 'approval-revoked'] as const) test(`standalone manager proposal apply: ${boundary}`, async t => {
  const f = await fixture(t, boundary !== 'missing')
  await writeFile(join(f.root, 'value.txt'), 'before')
  const target = await snapshot(f.root, 'value.txt', [])
  const candidate = await stageCandidate(f.owner, f.store, { changes: [{ operation: 'write', path: 'value.txt', content: 'after' }],
    baseRef: randomUUID(), resultRef: randomUUID(), readSet: [target], targets: { 'value.txt': target } })
  let questions = 0
  const manager = new LispManager({ store: f.store, dataRoot: join(f.base, 'runtime'), config: LispConfig.parse({ enabled: true, executionMode: 'protected' }),
    questions: { ask: async request => { questions++; if (boundary === 'approval-revoked') wait(f); return approved.ask(request) } } })
  await manager.enableTask(f.owner)
  const result = await manager.execute(f.owner, 'lisp_apply', { operationId: 'apply', candidateRef: candidate.candidateRef }) as any
  assert.equal(result.ok, boundary === 'working', JSON.stringify(result))
  assert.equal(await readFile(join(f.root, 'value.txt'), 'utf8'), boundary === 'working' ? 'after' : 'before')
  if (boundary === 'missing') assert.equal(questions, 0)
  if (boundary === 'approval-revoked') assert.match(JSON.stringify(result), /TASK_STATE_CONFLICT/)
  await manager.dispose()
})

test('restore and HTTP recover deny unavailable task state; HTTP status/cancel remain usable', async t => {
  const f = await fixture(t, false)
  const manager = new LispManager({ store: f.store, dataRoot: join(f.base, 'runtime'), config: LispConfig.parse({ enabled: true }) })
  await manager.enableTask(f.owner)
  await assert.rejects(manager.restore(f.owner, 'old-proposal', new AbortController().signal), { code: 'TASK_REQUIRED' })
  let handler!: (request: Request) => Promise<Response>
  mountLispHttp({ get: () => ({ fetch: { register: (route: any) => { handler = route.fetch; return () => {} } } }) } as any, manager, () => f.owner)
  const get = await handler(new Request('http://localhost/api/kiokuko.lisp?sessionId=session'))
  assert.equal(get.status, 200)
  for (const action of ['recover', 'cancel']) {
    const response = await handler(new Request('http://localhost/api/kiokuko.lisp?sessionId=session', { method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify({ action }) }))
    const body = await response.json() as any
    assert.equal(response.status, action === 'recover' ? 409 : 200)
    if (action === 'recover') assert.equal(body.code, 'TASK_REQUIRED')
    else assert.equal(body.ok, true)
  }
  await manager.dispose()
})
