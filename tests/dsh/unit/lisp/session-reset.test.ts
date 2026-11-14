import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { ManagedOperationJournal } from '../../../../src/dsh/managed-operation-journal.js'
import { resetStoppedSessionRecords, stopBeforeReset } from '../../../../src/dsh/lisp/session-reset.js'

test('session reset deletes pending data but preserves tools, saved definitions, completed results and other sessions', async t => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:')); t.after(() => db.close())
  migrateDatabase(db)
  const store = new LispStore(async fn => fn(db)), journal = new ManagedOperationJournal(db)
  const owner = { sessionId: 'session', agentId: 'agent', root: '/repo' }
  await store.enable(owner)
  await store.saveState(owner, 'function', 'definition', '(defun saved () 42)')
  await store.reserve(owner, 'tool', 'task_tool', 'hash', 'old', { source: '(lambda (x) x)' })
  await store.transition(owner, 'tool', ['RUNNING'], 'SUCCEEDED', { toolRef: 'saved-tool' })
  await store.reserve(owner, 'broken', 'lisp_eval', 'hash', 'old', {})
  db.prepare("UPDATE dsh_lisp_operations SET payload='broken-json',result='broken-result' WHERE operation_id='broken'").run()
  const other = { ...owner, sessionId: 'other' }; await store.enable(other)
  await store.reserve(other, 'pending', 'lisp_eval', 'hash', 'old', {})
  const operations = ['session', 'other'].map(sessionId => {
    const scope = journal.createScope({ sessionId, parentId: 'evaluation', runtimeIdentity: 'sbcl:old' })
    const op = journal.prepare(scope.scopeId, { route: 'native', kind: 'process', request: {} })
    journal.claim(op.operationId); return op
  })
  const beforeTool = await store.get(owner, 'tool'), beforeSaved = await store.restoreState(owner, 'function')
  const prepared = journal.prepare(operations[0]!.scopeId, { route: 'native', kind: 'process', request: { prepared: true } })
  const snapshot = journal.snapshot(operations[0]!.scopeId)
  journal.retainSnapshot(snapshot.snapshotId)
  const report = resetStoppedSessionRecords(db, owner)
  assert.equal(report.deletedOperations, 1); assert.equal(report.deletedManaged, 2)
  assert.throws(() => journal.readOperation(prepared.operationId))
  assert.equal(report.reexecuted, false); assert.equal(report.effectsReverted, false)
  assert.equal(await store.get(owner, 'broken'), undefined)
  assert.deepEqual(await store.get(owner, 'tool'), beforeTool)
  assert.deepEqual(await store.restoreState(owner, 'function'), beforeSaved)
  assert.equal((await store.session(owner.sessionId))?.enabled, 1)
  assert.throws(() => journal.readOperation(operations[0]!.operationId))
  assert.throws(() => journal.readSnapshot(snapshot.snapshotId))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dsh_managed_transitions WHERE operation_id=?').get<{count:number}>(operations[0]!.operationId)?.count, 0)
  assert.equal(journal.readOperation(operations[1]!.operationId).state, 'dispatching')
  assert.equal((await store.get(other, 'pending'))?.state, 'RUNNING')
  assert.throws(() => resetStoppedSessionRecords(db, { ...owner, root: '/other-repo' }), { code: 'SCOPE_CONFLICT' })
  assert.equal(await store.hasPending(owner.sessionId), false)
  const stale = journal.prepare(operations[0]!.scopeId, { route: 'native', kind: 'process', request: { stale: true } })
  journal.claim(stale.operationId); journal.recover(stale.scopeId); journal.abandon(stale.operationId, 'earlier reset')
  assert.equal(resetStoppedSessionRecords(db, owner).deletedManaged, 1)
  assert.throws(() => journal.readOperation(stale.operationId))
  assert.deepEqual(resetStoppedSessionRecords(db, owner), { deletedOperations: 0, deletedManaged: 0, reexecuted: false, effectsReverted: false })
})
test('failed or stuck stop never reaches record reset or restart', async () => {
  for (const stop of [async () => { throw new Error('stop failed') }, () => new Promise<void>(() => {})]) {
    let reset = false
    await assert.rejects((async () => { await stopBeforeReset(stop, 20); reset = true })())
    assert.equal(reset, false)
  }
  await stopBeforeReset(async () => {}, 20)
})
