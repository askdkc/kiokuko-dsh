import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
test('durable requests deduplicate by owner and digest; restart quarantines unfinished work', async () => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec(readFileSync(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 's', agentId: 'a', root: '/workspace' }
  try {
    await store.enable(owner)
    const bound = await store.bind(owner, 'transport', 'logical', { code: '(+ 1 2)' })
    assert.equal(await store.bind(owner, 'transport', 'logical', { code: '(+ 1 2)' }), bound)
    assert.equal(await store.bind(owner, 'transport-retry', 'logical', { code: '(+ 1 2)' }), bound)
    await assert.rejects(store.bind(owner, 'transport', 'different', { code: '(+ 1 3)' }), /異なる入力/)
    assert.notEqual(await store.bind(owner, 'new-transport', 'new-logical', { code: '(+ 1 2)' }), bound)
    assert.equal(await store.reserve(owner, 'id', 'eval', 'hash', 'generation', {}), undefined)
    assert.equal((await store.reserve(owner, 'id', 'eval', 'hash', 'generation', {}))?.state, 'RUNNING')
    await assert.rejects(store.reserve(owner, 'id', 'eval', 'other', 'generation', {}), /異なる内容/)
    assert.equal((await store.start()).length, 1)
    assert.equal((await store.get(owner, 'id'))?.state, 'UNKNOWN')
    await assert.rejects(store.transition(owner, 'id', ['RUNNING'], 'SUCCEEDED', {}), /状態が変わって/)
    assert.equal(await store.get({ ...owner, agentId: 'other' }, 'id'), undefined)
    await store.reserve(owner, 'expire', 'lisp_eval', 'hash', 'generation', {})
    await store.transition(owner, 'expire', ['RUNNING'], 'SUCCEEDED', { value: 42 })
    await store.expireResults(new Date(Date.now() + 31 * 86400000))
    assert.equal((await store.get(owner, 'expire'))?.result, null)
    assert.equal((await store.reserve(owner, 'expire', 'lisp_eval', 'hash', 'generation', {}))?.state, 'SUCCEEDED')
    assert.equal((await store.get(owner, 'id'))?.state, 'UNKNOWN')
  } finally { db.close() }
})

test('declining Lisp persists without enabling a worker and cannot undo an enabled session', async () => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec(readFileSync(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 's', agentId: 'a', root: '/workspace' }
  try {
    await store.decline(owner)
    const restarted = new LispStore(async fn => fn(db))
    assert.equal((await restarted.session(owner.sessionId))?.enabled, 0)
    assert.deepEqual(await restarted.start(), [])
    await assert.rejects(restarted.decline({ ...owner, root: '/other' }), /状態が変わって/)
    await restarted.enable(owner)
    await assert.rejects(restarted.decline(owner), /状態が変わって/)
    assert.equal((await restarted.session(owner.sessionId))?.enabled, 1)
  } finally { db.close() }
})
