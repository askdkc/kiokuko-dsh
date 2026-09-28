import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService, databaseDecisionStore, type DecisionStore } from '../../../../src/dsh/decisions/service.js'

const signal = () => new AbortController().signal
const batch = { purpose: 'lisp', state: 'fixture', questions: [{ id: 'fruit', instructions: 'Which fruit?',
  choices: [{ id: 'apple', description: 'Apple' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }

function fixture(t: import('node:test').TestContext, wrap?: (store: DecisionStore) => DecisionStore) {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  t.after(() => db.close())
  db.exec(readFileSync(new URL('../../../../migrations/021_typed_decisions.sql', import.meta.url), 'utf8'))
  const store = wrap?.(databaseDecisionStore({ withDatabase: async operation => operation(db) }))
    ?? databaseDecisionStore({ withDatabase: async operation => operation(db) })
  let calls = 0
  const service = new DecisionService(TypedDecisionsConfig.parse({}), () => ({
    capabilities: { maxQuestions: 1, maxChoices: 2, maxBytes: 262144 },
    evaluate: async request => { calls++; return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
      answers: request.questions.map(q => ({ id: q.id, status: 'selected' as const, choiceId: 'apple' })) } },
  }), store, { cacheMaxEntries: 2 })
  return { db, store, service, calls: () => calls }
}

test('completed caches evict least-recent entries but persisted replay needs no inference', async t => {
  const f = fixture(t)
  for (const id of ['a', 'b']) await f.service.evaluate(id, batch, signal())
  await f.service.evaluate('a', batch, signal()) // make b least recent
  await f.service.evaluate('c', batch, signal())
  assert.equal((f.service as any).bindings.size, 2)
  assert.equal((f.service as any).results.size, 2)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_decision_results').get()!.n, 3)
  assert.equal(f.calls(), 3)
  await f.service.evaluate('b', batch, signal())
  assert.equal(f.calls(), 3)
  assert.equal((f.service as any).bindings.size, 2)
  assert.equal((f.service as any).results.size, 2)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_decision_results').get()!.n, 3)
})

test('the whole cache miss is single-flight, including delayed persisted read', async t => {
  let enter!: () => void, release!: () => void, reads = 0
  const entered = new Promise<void>(resolve => { enter = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const f = fixture(t, base => ({ ...base, read: async (id, digest) => {
    reads++
    const value = await base.read(id, digest)
    if (reads === 1) { enter(); await blocked }
    return value
  } }))
  const first = f.service.evaluate('same', batch, signal())
  await entered
  const second = f.service.evaluate('same', batch, signal())
  release()
  assert.deepEqual(await first, await second)
  assert.equal(reads, 1)
  assert.equal(f.calls(), 1)
})

test('a cancelled follower leaves its shared evaluation available to the first caller', async t => {
  const f = fixture(t)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const original = f.store.read
  f.store.read = async (id, digest) => { enter(); await blocked; return original(id, digest) }
  const first = f.service.evaluate('shared', batch, signal())
  await entered
  const cancel = new AbortController()
  const follower = f.service.evaluate('shared', batch, cancel.signal)
  cancel.abort()
  await assert.rejects(follower, { code: 'DECISION_CANCELLED' })
  release()
  await first
  assert.equal(f.calls(), 1)
})

test('alias failure can retry without changing the first durable target binding', async t => {
  let fail = true
  const f = fixture(t, base => ({ ...base, bind: async (id, config) => {
    if (id === 'alias' && fail) { fail = false; throw new Error('alias-write-failed') }
    return base.bind(id, config)
  } }))
  await f.service.bind('source')
  await assert.rejects(f.service.alias('alias', 'source'), /alias-write-failed/)
  await f.service.alias('alias', 'source')
  assert.deepEqual(await f.service.bind('alias'), await f.service.bind('source'))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_decision_bindings').get()!.n, 2)
})

test('an evicted old binding and its alias retain their original provider after a switch', async t => {
  const f = fixture(t)
  const original = await f.service.bind('old')
  assert.equal(original.provider, 'typesafe')
  const newProvider = TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } })
  const switched = new DecisionService(TypedDecisionsConfig.parse({}), () => ({
    capabilities: { maxQuestions: 1, maxChoices: 2, maxBytes: 262144 },
    evaluate: async request => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
      answers: request.questions.map(q => ({ id: q.id, status: 'selected' as const, choiceId: 'apple' })) }),
  }), f.store, { cacheMaxEntries: 2, resolveConfiguration: async () => newProvider })
  await switched.bind('old')
  await switched.selectProvider('laya-coreml', signal())
  for (const id of ['new-1', 'new-2']) assert.equal((await switched.bind(id)).provider, 'laya-coreml')
  assert.equal((await switched.bind('old')).provider, 'typesafe')
  await switched.alias('alias', 'old')
  assert.equal((await switched.bind('alias')).provider, 'typesafe')
})

test('failed persistence does not create a completed result and can be retried', async t => {
  let fail = true
  const f = fixture(t, base => ({ ...base, write: async (id, digest, outcome) => {
    if (fail) { fail = false; throw new Error('result-write-failed') }
    await base.write(id, digest, outcome)
  } }))
  await assert.rejects(f.service.evaluate('retry', batch, signal()), /result-write-failed/)
  assert.equal((f.service as any).results.size, 0)
  await f.service.evaluate('retry', batch, signal())
  assert.equal(f.calls(), 2)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_decision_results').get()!.n, 1)
})

test('a store with no binding reader and a service with no store retain prior replay behavior', async t => {
  const f = fixture(t, base => ({ bind: base.bind, read: base.read, write: base.write }))
  for (const id of ['a', 'b', 'c']) await f.service.evaluate(id, batch, signal())
  assert.equal((f.service as any).bindings.size, 3)
  assert.equal((f.service as any).results.size, 2)
  await f.service.evaluate('a', batch, signal())
  assert.equal(f.calls(), 3)
  let calls = 0
  const noStore = new DecisionService(TypedDecisionsConfig.parse({}), () => ({
    capabilities: { maxQuestions: 1, maxChoices: 2, maxBytes: 262144 },
    evaluate: async request => { calls++; return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
      answers: request.questions.map(q => ({ id: q.id, status: 'selected' as const, choiceId: 'apple' })) } },
  }), undefined, { cacheMaxEntries: 2 })
  for (const id of ['a', 'b', 'c']) await noStore.evaluate(id, batch, signal())
  await noStore.evaluate('a', batch, signal())
  assert.equal(calls, 3)
  assert.equal((noStore as any).bindings.size, 3)
  assert.equal((noStore as any).results.size, 3)
})

test('corrupt persisted result after eviction fails before provider inference', async t => {
  const f = fixture(t)
  for (const id of ['a', 'b', 'c']) await f.service.evaluate(id, batch, signal())
  f.db.prepare('UPDATE dsh_decision_results SET result_json=? WHERE request_id=?').run('{"status":"completed","result":{}}', 'a')
  await assert.rejects(f.service.evaluate('a', batch, signal()))
  assert.equal(f.calls(), 3)
})
