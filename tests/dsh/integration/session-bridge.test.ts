import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSessionBridge, mountDshDurabilityBarriers } from '../../../src/dsh/session-bridge.js'

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
  await listeners.get('session/flush')?.({}, async () => { calls.push('session-next') })
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
