import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSessionBridge } from '../../../../src/dsh/session-bridge.js'

test('bridge ignores exact duplicate source identity without duplicating the batch', async () => {
  let appended = 0
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (_runId, events) => { appended += events.length },
  })
  bridge.bindSession('session', 'run')
  const event = { sessionId: 'session', runId: 'run', event: { type: 'turn/start', seq: 0, time: 0, data: null } }
  bridge.observe(event)
  bridge.observe(event)
  await bridge.flush()
  assert.equal(appended, 1)
  assert.equal(bridge.pendingCount, 0)
})
