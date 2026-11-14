import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { ManagedOperationJournal } from '../../../../src/dsh/managed-operation-journal.js'
import { resetStoppedSessionRecords, stopBeforeReset } from '../../../../src/dsh/lisp/session-reset.js'

test('session reset clears pending state but preserves tools, saved definitions, evidence and other sessions', async t => {
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
  const report = resetStoppedSessionRecords(db, owner)
  assert.equal(report.abandonedOperations, 1); assert.equal(report.abandonedManaged, 1)
  assert.equal(report.cancelledBeforeDispatch, 1)
  assert.equal(journal.readOperation(prepared.operationId).state, 'cancelled-before-dispatch')
  assert.equal(report.reexecuted, false); assert.equal(report.effectsReverted, false)
  assert.equal((await store.get(owner, 'broken'))?.state, 'ABANDONED')
  assert.equal((await store.get(owner, 'broken'))?.payload, 'broken-json')
  assert.equal((await store.get(owner, 'broken'))?.result, 'broken-result')
  assert.deepEqual(await store.get(owner, 'tool'), beforeTool)
  assert.deepEqual(await store.restoreState(owner, 'function'), beforeSaved)
  assert.equal((await store.session(owner.sessionId))?.enabled, 1)
  assert.equal(journal.readOperation(operations[0]!.operationId).state, 'abandoned')
  assert.equal(journal.readOperation(operations[0]!.operationId).outcome, undefined)
  assert.equal(journal.readOperation(operations[1]!.operationId).state, 'dispatching')
  assert.equal((await store.get(other, 'pending'))?.state, 'RUNNING')
  assert.throws(() => resetStoppedSessionRecords(db, { ...owner, root: '/other-repo' }), { code: 'SCOPE_CONFLICT' })
  assert.deepEqual(resetStoppedSessionRecords(db, owner), { abandonedOperations: 0, abandonedManaged: 0, cancelledBeforeDispatch: 0, reexecuted: false, effectsReverted: false })
})
test('failed or stuck stop never reaches record reset or restart', async () => {
  for (const stop of [async () => { throw new Error('stop failed') }, () => new Promise<void>(() => {})]) {
    let reset = false
    await assert.rejects((async () => { await stopBeforeReset(stop, 20); reset = true })())
    assert.equal(reset, false)
  }
  await stopBeforeReset(async () => {}, 20)
})
