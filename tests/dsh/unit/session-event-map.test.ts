import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSessionBridge } from '../../../src/dsh/session-bridge.js'

function bridge(writer: (runId: string, events: readonly unknown[]) => unknown | PromiseLike<unknown>) {
  return new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: writer,
  })
}

test('post-commit observer never throws and emits immutable ordered source identities', async () => {
  const batches: Array<{ runId: string; events: readonly unknown[] }> = []
  const session = bridge((runId, events) => { batches.push({ runId, events }); })
  session.bindSession('session-a', 'run-a')
  assert.doesNotThrow(() => session.observe({ sessionId: 'session-a', runId: 'run-a', event: { type: 'assistant/chunk', seq: 2, time: 2, data: { text: 'two' } } }))
  session.observe({ sessionId: 'session-a', runId: 'run-a', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } })
  session.observe({ sessionId: 'session-a', runId: 'run-a', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } })
  assert.equal(session.pendingCount, 2)
  await session.flush()
  assert.equal(batches.length, 1)
  const emitted = batches[0]?.events as Array<{ sourceEventId: string; sourceSequence: number }>
  assert.deepEqual(emitted.map((event) => event.sourceSequence), [1, 2])
  assert.match(emitted[0]!.sourceEventId, /^dsh:session-a:[^:]+:1$/u)
  assert.match(emitted[1]!.sourceEventId, /^dsh:session-a:[^:]+:2$/u)
  assert.notEqual(emitted[0]!.sourceEventId, emitted[1]!.sourceEventId)
  assert.equal(session.pendingCount, 0)
  assert.doesNotThrow(() => session.observe({ sessionId: 'session-a', runId: 'run-a', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }))
  await session.flush()
  assert.equal(batches.length, 1)
  assert.doesNotThrow(() => session.observe({ sessionId: 'unknown', runId: 'run-a', event: { type: 'bad', seq: 0, time: 0 } }))
  assert.equal(session.observerErrors.length, 1)
})

test('session event source IDs remain distinct for delimiter and escaped IDs', () => {
  const session = bridge(() => undefined)
  session.bindSession('a:b', 'run-a')
  session.bindSession('a%3Ab', 'run-b')
  session.observe({ sessionId: 'a:b', runId: 'run-a', event: { type: 'event', seq: 1, time: 0, data: null } })
  session.observe({ sessionId: 'a%3Ab', runId: 'run-b', event: { type: 'event', seq: 1, time: 0, data: null } })
  assert.equal(session.pendingCount, 2)
})

test('oversized readable identities are reduced to bounded collision-resistant source IDs', () => {
  const ids: string[] = []
  const session = bridge((_runId, events) => {
    for (const event of events) ids.push((event as { sourceEventId: string }).sourceEventId)
  })
  const longSession = 's'.repeat(256)
  const longIncarnation = 'i'.repeat(256)
  session.bindSession(longSession, 'run', longIncarnation)
  session.observe({ sessionId: longSession, runId: 'run', event: { type: 'event', seq: 1, time: 0, data: null } })
  session.bindSession('short', 'run', longIncarnation)
  session.observe({ sessionId: 'short', runId: 'run', event: { type: 'event', seq: 1, time: 0, data: null } })
  assert.equal(session.pendingCount, 2)
  return session.flush().then(() => {
    assert.equal(ids.length, 2)
    assert.ok(ids.every((id) => id.length <= 256))
    assert.notEqual(ids[0], ids[1])
  })
})

test('flush splits one run into ledger-sized event batches without losing order', async () => {
  const batches: number[] = []
  const session = bridge((_runId, events) => { batches.push(events.length) })
  session.bindSession('batch-session', 'batch-run')
  for (let sequence = 0; sequence < 201; sequence += 1) {
    session.observe({ sessionId: 'batch-session', runId: 'batch-run', event: { type: 'event', seq: sequence, time: sequence, data: null } })
  }
  assert.equal(session.pendingCount, 201)
  await session.flush()
  assert.deepEqual(batches, [200, 1])
  assert.equal(session.pendingCount, 0)
})

test('event queue exhaustion fails closed instead of growing without bound', async () => {
  const session = bridge(() => undefined)
  session.bindSession('capacity-session', 'capacity-run')
  for (let sequence = 0; sequence < 4_097; sequence += 1) {
    session.observe({ sessionId: 'capacity-session', runId: 'capacity-run', event: { type: 'event', seq: sequence, time: sequence, data: null } })
  }
  assert.equal(session.pendingCount, 4_096)
  assert.equal(session.observerErrors.length, 1)
  await assert.rejects(session.flush(), /capacity is exhausted/u)
})

test('failed flush retains the suffix for a later retry', async () => {
  let attempts = 0
  const session = bridge(() => {
    attempts += 1
    if (attempts === 1) throw new Error('flush failed')
  })
  session.bindSession('session-b', 'run-b')
  session.observe({ sessionId: 'session-b', runId: 'run-b', event: { type: 'step/start', seq: 0, time: 0, data: null } })
  await assert.rejects(session.flush(), /flush failed/u)
  assert.equal(session.pendingCount, 1)
  await session.flush()
  assert.equal(session.pendingCount, 0)
})
