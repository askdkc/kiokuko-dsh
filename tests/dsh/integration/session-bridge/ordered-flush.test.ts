import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSessionBridge } from '../../../../src/dsh/session-bridge.js'

test('bridge keeps a failed flush suffix available for an exact retry', async () => {
  let attempts = 0
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (_runId, events) => {
      attempts += 1
      if (attempts === 1) throw new Error('durability failure')
      assert.equal(events.length, 1)
    },
  })
  bridge.bindSession('session', 'run')
  bridge.observe({ sessionId: 'session', runId: 'run', event: { type: 'turn/end', seq: 1, time: 1, data: { ok: true } } })
  await assert.rejects(bridge.flush(), /durability failure/u)
  assert.equal(bridge.pendingCount, 1)
  await bridge.flush()
  assert.equal(bridge.pendingCount, 0)
})
