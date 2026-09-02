import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSessionBridge, mountDshDurabilityBarriers, mountDshIdleLifecycle } from '../../../src/dsh/session-bridge.js'

test('durability barriers flush before session, pre-step, tools, and first model dispatch', async () => {
  const calls: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async () => { calls.push('flush') },
  })
  bridge.bindSession('barrier-session', 'barrier-run')
  const listeners = new Map<string, (...args: any[]) => any>()
  const ctx = {
    on(name: string, listener: (...args: any[]) => any) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }
  const dispose = mountDshDurabilityBarriers(ctx, bridge)
  bridge.observe({ sessionId: 'barrier-session', runId: 'barrier-run', event: { type: 'session/flush', seq: 0, time: 0, data: null } })
  await listeners.get('session/flush')?.({})
  calls.push('session-next')
  bridge.observe({ sessionId: 'barrier-session', runId: 'barrier-run', event: { type: 'agent/pre-step', seq: 1, time: 1, data: null } })
  await listeners.get('agent/pre-step')?.({}, async () => { calls.push('step-next') })
  bridge.observe({ sessionId: 'barrier-session', runId: 'barrier-run', event: { type: 'tools/execute', seq: 2, time: 2, data: null } })
  await listeners.get('tools/execute')?.({}, async () => { calls.push('tool-next') })
  bridge.observe({ sessionId: 'barrier-session', runId: 'barrier-run', event: { type: 'llm/stream', seq: 3, time: 3, data: null } })
  const stream = listeners.get('llm/stream')?.({}, () => (async function* () { calls.push('model-next'); yield 'chunk' })()) as AsyncIterable<string>
  for await (const _chunk of stream) { /* drain */ }
  assert.deepEqual(calls, ['flush', 'session-next', 'flush', 'step-next', 'flush', 'tool-next', 'flush', 'model-next'])
  dispose()
  assert.equal(listeners.size, 0)
})

test('ordinary idle does not close a non-terminal run', async () => {
  let closeCalls = 0
  let listener: ((event: { agent: { id: string }; status: string }) => unknown) | undefined
  const dispose = mountDshIdleLifecycle({
    on(_name, next) { listener = next; return () => { listener = undefined } },
  }, { closeTurn: async () => { closeCalls += 1 } } as any, async () => undefined)
  await listener?.({ agent: { id: 'agent-active' }, status: 'idle' })
  assert.equal(closeCalls, 0)
  dispose()
})

test('idle state-read and close failures are contained without a false terminal transition', async () => {
  let listener: ((event: { agent: { id: string }; status: string }) => unknown) | undefined
  let closeCalls = 0
  let failRead = true
  const dispose = mountDshIdleLifecycle({
    on(_name, next) { listener = next; return () => { listener = undefined } },
  }, { closeTurn: async () => { closeCalls += 1; throw new Error('durability failed') } } as any, async () => {
    if (failRead) throw new Error('state read failed')
    return { runId: 'run-failed-close', status: 'failed' as const }
  })
  await assert.doesNotReject(async () => { await listener?.({ agent: { id: 'agent-failed' }, status: 'idle' }) })
  assert.equal(closeCalls, 0)
  await assert.doesNotReject(async () => { await listener?.(null as any) })
  assert.equal(closeCalls, 0)
  failRead = false
  await assert.doesNotReject(async () => { await listener?.({ agent: { id: 'agent-failed' }, status: 'idle' }) })
  assert.equal(closeCalls, 1)
  dispose()
})

test('session bridge can move to the next turn run without reattributing queued events', async () => {
  const batches: Array<{ runId: string; count: number }> = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (runId, events) => { batches.push({ runId, count: events.length }) },
  })
  bridge.bindSession('turn-session', 'turn-one')
  bridge.observe({ sessionId: 'turn-session', runId: 'turn-one', event: { type: 'turn/end', seq: 1, time: 0, data: null } })
  bridge.rebindSession('turn-session', 'turn-two')
  bridge.observe({ sessionId: 'turn-session', runId: 'turn-two', event: { type: 'turn/start', seq: 2, time: 1, data: null } })
  await bridge.flush()
  assert.deepEqual(batches, [{ runId: 'turn-one', count: 1 }, { runId: 'turn-two', count: 1 }])
  await bridge.close()
})

test('bridge surfaces observer failures at flush and permits disposed session ID reuse', async () => {
  const batches: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (runId) => { batches.push(runId) },
  })
  bridge.bindSession('reused:session', 'first-run')
  bridge.observe({ sessionId: 'reused:session', runId: 'first-run', event: { type: 'turn/start', seq: 0, time: 0, data: null } })
  await bridge.flush()
  assert.deepEqual(batches, ['first-run'])
  bridge.unbindSession('reused:session')
  bridge.bindSession('reused:session', 'second-run')
  bridge.observe({ sessionId: 'reused:session', runId: 'second-run', event: { type: 'turn/start', seq: 0, time: 1, data: null } })
  await bridge.flush()
  assert.deepEqual(batches, ['first-run', 'second-run'])
  bridge.observe({ sessionId: 'reused:session', runId: 'second-run', event: { type: 'turn/end', seq: 0, time: 1, data: null } })
  await assert.rejects(bridge.flush(), /different content/u)
  bridge.observe({ sessionId: 'reused:session', runId: 'wrong-run', event: { type: 'turn/end', seq: 2, time: 2, data: null } })
  await assert.rejects(bridge.flush())
  await assert.rejects(bridge.close())
})

test('session incarnation separates an explicitly reused session and run identity', async () => {
  const ids: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (_runId, events) => { ids.push(events[0]!.sourceEventId!) },
  })
  bridge.bindSession('same-session', 'same-run', 'incarnation-one')
  bridge.observe({ sessionId: 'same-session', runId: 'same-run', event: { type: 'turn/start', seq: 0, time: 0, data: null } })
  await bridge.flush()
  bridge.unbindSession('same-session')
  bridge.bindSession('same-session', 'same-run', 'incarnation-two')
  bridge.observe({ sessionId: 'same-session', runId: 'same-run', event: { type: 'turn/start', seq: 0, time: 1, data: null } })
  await bridge.flush()
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  await bridge.close()
})
