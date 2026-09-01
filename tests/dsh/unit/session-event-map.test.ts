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
  assert.deepEqual((batches[0]?.events as Array<{ sourceEventId: string; sourceSequence: number }>).map((event) => [event.sourceEventId, event.sourceSequence]), [
    ['dsh:session-a:1', 1], ['dsh:session-a:2', 2],
  ])
  assert.equal(session.pendingCount, 0)
  assert.doesNotThrow(() => session.observe({ sessionId: 'session-a', runId: 'run-a', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }))
  await session.flush()
  assert.equal(batches.length, 1)
  assert.doesNotThrow(() => session.observe({ sessionId: 'unknown', runId: 'run-a', event: { type: 'bad', seq: 0, time: 0 } }))
  assert.equal(session.observerErrors.length, 1)
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
