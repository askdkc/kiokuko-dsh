import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
test('durable requests deduplicate by owner and digest; restart quarantines unfinished work', async () => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec(readFileSync(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../../../../migrations/047_managed_operation_journal.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../../../../migrations/049_lisp_session_hosts.sql', import.meta.url), 'utf8'))
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
    assert.equal(await store.hasPending(owner.sessionId), true)
    assert.equal(await store.countByKind(owner.sessionId, 'eval'), 1)
    assert.equal((await store.operationSummaries(owner.sessionId, 0)).operations[0]?.operation_id, 'id')
    await assert.rejects(store.reserve(owner, 'id', 'eval', 'other', 'generation', {}), /異なる内容/)
    assert.equal((await store.start()).length, 1)
    await store.claimSession(owner, 'test-host')
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
  db.exec(readFileSync(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  db.exec(readFileSync(new URL('../../../../migrations/047_managed_operation_journal.sql', import.meta.url), 'utf8'))
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

test('session claims distinguish hosts in the same process and never recover a live peer', async () => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  for (const name of ['019_dsh_lisp.sql', '031_dsh_lisp_hot_tools.sql', '047_managed_operation_journal.sql', '049_lisp_session_hosts.sql'])
    db.exec(readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), peer = new LispStore(async fn => fn(db))
  const owner = { sessionId: 'one', agentId: 'agent', root: '/one' }, other = { ...owner, sessionId: 'two', root: '/two' }
  try {
    await store.enable(owner); await store.enable(other)
    await store.claimSession(owner, 'host-one')
    await store.reserve(owner, 'live', 'lisp_eval', 'hash', 'generation', {})
    await peer.start()
    await assert.rejects(peer.claimSession(owner, 'host-two'), { code: 'SESSION_IN_USE' })
    await assert.rejects(peer.claimSession({ ...owner, root: '/wrong' }, 'host-two'), { code: 'SCOPE_CONFLICT' })
    await peer.claimSession(other, 'host-two')
    await peer.releaseHost('host-two')
    assert.equal((await store.get(owner, 'live'))!.state, 'RUNNING')
    await assert.rejects(peer.claimSession(owner, 'host-two'), { code: 'SESSION_IN_USE' })
    await store.claimSession(owner, 'host-one')
    await store.releaseHost('host-one')
    await peer.claimSession(owner, 'host-two')
    assert.equal((await peer.get(owner, 'live'))!.state, 'UNKNOWN')
  } finally { db.close() }
})

test('manual selection is atomic, idempotent, session/root/epoch scoped and survives restart without a pending effect',async()=>{
 const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:'))
 db.exec(readFileSync(new URL('../../../../migrations/019_dsh_lisp.sql',import.meta.url),'utf8'))
 db.exec(readFileSync(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql',import.meta.url),'utf8'))
 db.exec(readFileSync(new URL('../../../../migrations/047_managed_operation_journal.sql',import.meta.url),'utf8'))
 const store=new LispStore(async fn=>fn(db)),owner={sessionId:'manual-session',agentId:'a',root:'/workspace'}
 try{
 assert.equal(await store.manualMode(owner),false)
 await store.enable(owner);assert.equal(await store.manualMode(owner),false,'task yes is not manual ON')
 assert.equal(await store.manualMode(owner,true),true);assert.equal(await store.manualMode(owner,true),true);assert.equal(await store.hasPending(owner.sessionId),false)
 assert.equal(await store.countByKind(owner.sessionId,'manual_mode'),1)
 const restarted=new LispStore(async fn=>fn(db));await restarted.start();assert.equal(await restarted.manualMode(owner),true)
 assert.equal(await restarted.manualMode({...owner,sessionId:'other'}),false);assert.equal(await restarted.manualMode({...owner,root:'/other'}),false)
 await restarted.disable(owner.sessionId);assert.equal(await restarted.manualMode(owner),false);await restarted.enable(owner);assert.equal(await restarted.manualMode(owner),false,'new epoch must not inherit the old marker')
 }finally{db.close()}
})
