import assert from 'node:assert/strict'
import test from 'node:test'
import { auxiliaryDatabase, auxiliaryDatabasePending, AUXILIARY_DATABASE_LIMIT } from '../../../src/dsh/auxiliary-database.js'
import { openConnection } from '../../../src/db/connection.js'

test('expired optional DB acquisition never executes a late write', async () => {
  let release!: () => void, writes = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const runtime = { async withDatabase<T>(fn: (db: any) => T | Promise<T>) { await held; return fn({}) } }
  const keepalive = setTimeout(() => {}, 2000)
  try {
    await assert.rejects(auxiliaryDatabase(runtime, () => { writes++ }, () => true))
    release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(writes, 0)
  } finally { release(); clearTimeout(keepalive) }
})

test('optional DB callback restores busy timeout even when it fails', async () => {
  const db = openConnection(':memory:')
  const runtime = { async withDatabase<T>(fn: (connection: import('../../../src/db/adapter.js').SqliteDatabase) => T | Promise<T>) { return fn(db) } }
  try {
    const previous = db.prepare('PRAGMA busy_timeout').get()!.timeout
    await assert.rejects(auxiliaryDatabase(runtime, db => {
      assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout, 25)
      throw new Error('fixture failure')
    }, () => true), /fixture failure/)
    assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout, previous)
    let ran = false
    await assert.rejects(auxiliaryDatabase(runtime, () => { ran = true }, () => false))
    assert.equal(ran, false)
  } finally { db.close() }
})

test('input capture returns without waiting for held DB and cannot write after expiry', async () => {
  const { createSessionObservation } = await import('../../../src/dsh/host-adapter/session-observation.js')
  let release!: () => void, calls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const db = openConnection(':memory:')
  const observation = createSessionObservation({ withDatabase: async (fn: any) => { await held; calls++; return fn(db) } } as any)
  const keepalive = setTimeout(() => {}, 2000)
  try {
    await observation.captureInitialInput('held-session', 1, [{ role: 'user', content: 'input' }])
    release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n, 0)
  } finally { release(); clearTimeout(keepalive); db.close() }
})

test('real answer quarantine never acquires the optional database', async () => {
  const { DshAnswerContext } = await import('../../../src/dsh/answer-context.js')
  const { MemoryRetrievalConfig } = await import('../../../src/memory/retrieval-contracts.js')
  let calls = 0
  const answer = new DshAnswerContext({ withDatabase: async () => { calls++; throw new Error('unavailable') } } as any,
    { root: '/tmp', projectOnly: true, memoryRetrieval: MemoryRetrievalConfig.parse({}) })
  const agent = { session: { id: 'quarantine', snapshotEvents: () => [] } } as any
  await answer.quarantine(agent)
  await answer.quarantine(agent)
  assert.equal(calls, 0)
})

test('quarantine redacts explanation results, preserves ordinary evidence and is idempotent', async () => {
  const { DshAnswerContext } = await import('../../../src/dsh/answer-context.js')
  const { MemoryRetrievalConfig } = await import('../../../src/memory/retrieval-contracts.js')
  const events: any[] = [
    { seq: 0, type: 'tool/call', data: { name: 'memory_explain', callId: 'memory' } },
    { seq: 1, type: 'tool/result', data: { callId: 'memory', message: { role: 'tool', source: { kind: 'tool', callId: 'memory' }, content: [{ type: 'text', text: 'PRIVATE_MEMORY' }] } } },
    { seq: 2, type: 'tool/result', data: { callId: 'test', message: { role: 'tool', source: { kind: 'tool', callId: 'test' }, content: [{ type: 'text', text: 'TEST_PASSED' }] } } },
  ]
  const session = { id: 'redact', header: { version: 3 }, surface: { nodes: [1, 2] },
    eventAt: (seq: number) => events[seq], snapshotEvents: () => [...events],
    append(type: string, data: unknown, options: any) {
      const seq = events.length
      events.push({ seq, type, data, ...options })
      session.surface.nodes[session.surface.nodes.indexOf(options.surfaceOp.startSeq)] = seq
    } }
  const { explanationProof } = await import('../../../src/dsh/explanation-provenance.js')
  events[1].data.meta = { kiokukoExplanation: explanationProof(session, 'memory', 'registration') }
  const original = structuredClone(events)
  const answer = new DshAnswerContext({ withDatabase: async () => { throw Error('must not read DB') } } as any,
    { root: '/tmp', projectOnly: true, memoryRetrieval: MemoryRetrievalConfig.parse({}) })
  await answer.quarantine({ session } as any)
  const count = events.length
  await answer.quarantine({ session } as any)
  assert.equal(events.length, count)
  assert.deepEqual(events.slice(0, 3), original)
  const active = session.surface.nodes.map(seq => events[seq])
  assert.ok(!JSON.stringify(active).includes('PRIVATE_MEMORY'))
  assert.ok(JSON.stringify(active).includes('TEST_PASSED'))
  assert.ok(JSON.stringify(active).includes('validation is unavailable'))
})


test('timed out DB work retains capacity until the underlying operations settle', async () => {
  let release!: () => void, acquisitions = 0, writes = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const runtime = { async withDatabase<T>(fn: (db: any) => T | Promise<T>) { acquisitions++; await held; return fn({}) } }
  const keepalive = setTimeout(() => {}, 2000)
  try {
    const results = await Promise.allSettled(Array.from({length: 1000}, () => auxiliaryDatabase(runtime, () => { writes++ }, () => true)))
    assert.equal(results.filter(r => r.status === 'rejected').length, 1000)
    assert.equal(acquisitions, AUXILIARY_DATABASE_LIMIT)
    assert.equal(auxiliaryDatabasePending(runtime), AUXILIARY_DATABASE_LIMIT)
    await assert.rejects(auxiliaryDatabase(runtime, () => {}, () => true), /capacity/)
    release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(auxiliaryDatabasePending(runtime), 0)
    assert.equal(writes, 0)
  } finally { release(); clearTimeout(keepalive) }
})

for (const change of ['stop', 'session', 'generation'] as const) test(`input capture rejects late ${change} effects`, async () => {
  const { createSessionObservation } = await import('../../../src/dsh/host-adapter/session-observation.js')
  let release!: () => void, generation = 1
  const held = new Promise<void>(resolve => { release = resolve })
  const db = openConnection(':memory:'), controller = new AbortController()
  const session = {}, agent = { session }
  const observation = createSessionObservation({ withDatabase: async (fn: any) => { await held; return fn(db) } } as any)
  const pending = observation.captureInitialInput('same-id', 1, ['input'], { signal: controller.signal, agent, session, current: () => generation === 1 })
  if (change === 'stop') controller.abort()
  if (change === 'session') agent.session = {}
  if (change === 'generation') generation++
  release()
  try {
    await assert.rejects(pending)
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n, 0)
  } finally { db.close() }
})
