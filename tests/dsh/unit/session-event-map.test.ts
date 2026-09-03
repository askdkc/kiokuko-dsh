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

test('long streamed assistant messages retain every valid source event sequence', async () => {
  const batches: Array<readonly unknown[]> = []
  const session = bridge((_runId, events) => { batches.push(events) })
  session.bindSession('long-stream-session', 'long-stream-run')
  const sourceEventSeqs = Array.from({ length: 4_531 }, (_, index) => index)

  for (const sourceSequence of sourceEventSeqs) {
    session.observe({
      sessionId: 'long-stream-session',
      runId: 'long-stream-run',
      event: { type: 'assistant/chunk', seq: sourceSequence, time: sourceSequence, data: { text: 'x' } },
    })
    if (sourceSequence % 200 === 199) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  session.observe({
    sessionId: 'long-stream-session',
    runId: 'long-stream-run',
    event: {
      type: 'assistant/message',
      seq: 4_531,
      time: 4_531,
      data: { turn: 3, step: 16 },
      sourceEventSeqs,
      surfaceOp: 'append',
    },
  })

  assert.equal(session.observerErrors.length, 0)
  await session.flush()
  const bridgedEvents = batches.flat() as Array<{ payload: { event: { type: string; sourceEventSeqs?: number[] } } }>
  const payload = bridgedEvents.find((event) => event.payload.event.type === 'assistant/message')?.payload
  assert.equal(bridgedEvents.length, 4_532)
  assert.ok(payload)
  assert.deepEqual(payload.event.sourceEventSeqs, sourceEventSeqs)
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

test('sealed runs reject bind, rebind, quiesce, and late events fail-closed until disposal', async () => {
  const session = bridge(() => undefined)
  session.bindSession('sealed-session', 'sealed-run')
  session.sealRun('sealed-run')
  assert.throws(() => session.bindSession('new-session', 'sealed-run'), /run is sealed/u)
  assert.throws(() => session.quiesceRun('sealed-run'), /run is sealed/u)
  session.rebindSession('sealed-session', 'sealed-run')
  // observe is a post-commit observer: the rejected late event is recorded, never thrown.
  assert.doesNotThrow(() => session.observe({ sessionId: 'sealed-session', runId: 'sealed-run', event: { type: 'late', seq: 1, time: 0, data: null } }))
  assert.equal(session.pendingCount, 0)
  assert.equal(session.observerErrors.length, 1)
  // The fail-closed observer error is surfaced by flush and again by close.
  await assert.rejects(session.flush(), /matching run binding|sealed/u)
  await assert.rejects(session.close(), /matching run binding|sealed/u)
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
