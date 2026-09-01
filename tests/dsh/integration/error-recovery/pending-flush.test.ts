import assert from 'node:assert/strict'
import test from 'node:test'
import { DshRunLifecycle, DshSessionBridge } from '../../../../src/dsh/session-bridge.js'

test('failed maintenance preserves pending events and does not close the ledger early', async () => {
  let attempts = 0
  const closed: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async () => { attempts++; if (attempts === 1) { throw new Error('temporary') } },
  })
  bridge.bindSession('session', 'run')
  bridge.observe({ sessionId: 'session', runId: 'run', event: { type: 'turn/end', seq: 1, time: 0, data: { reason: 'failed' } } })
  const lifecycle = new DshRunLifecycle({ bridge, closeRun: ({ status }) => { closed.push(status) } })
  await assert.rejects(lifecycle.closeTurn({ runId: 'run', status: 'failed' }), /temporary/u)
  assert.equal(bridge.pendingCount, 1)
  assert.deepEqual(closed, [])
  await lifecycle.closeTurn({ runId: 'run', status: 'failed' })
  assert.equal(bridge.pendingCount, 0)
  assert.deepEqual(closed, ['failed'])
  await lifecycle.dispose()
})
