import assert from 'node:assert/strict'
import test from 'node:test'
import { DshRunLifecycle, DshSessionBridge } from '../../../src/dsh/session-bridge.js'

test('flush failure leaves the event pending and allows a later maintenance retry', async () => {
  let appendAttempts = 0
  const closed: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async () => {
      appendAttempts += 1
      if (appendAttempts === 1) throw new Error('ledger temporarily unavailable')
    },
  })
  bridge.bindSession('session-dsh-retry', 'run-dsh-retry')
  bridge.observe({
    sessionId: 'session-dsh-retry', runId: 'run-dsh-retry',
    event: { type: 'turn/end', seq: 2, time: 0, data: { reason: 'failed' } },
  })
  const lifecycle = new DshRunLifecycle({
    bridge,
    closeRun: ({ status }) => { closed.push(status) },
  })

  await assert.rejects(lifecycle.closeTurn({ runId: 'run-dsh-retry', status: 'failed' }), /temporarily unavailable/u)
  assert.equal(bridge.pendingCount, 1)
  assert.deepEqual(closed, [])

  await lifecycle.closeTurn({ runId: 'run-dsh-retry', status: 'failed' })
  assert.equal(bridge.pendingCount, 0)
  assert.deepEqual(closed, ['failed'])
  await lifecycle.dispose()
})

test('abort and cancellation are terminal statuses only after a successful flush', async () => {
  const statuses: string[] = []
  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
  })
  const lifecycle = new DshRunLifecycle({
    bridge,
    closeRun: ({ status }) => { statuses.push(status) },
  })
  await lifecycle.closeTurn({ runId: 'run-aborted', status: 'failed' })
  await lifecycle.closeTurn({ runId: 'run-cancelled', status: 'cancelled' })
  assert.deepEqual(statuses, ['failed', 'cancelled'])
  await lifecycle.dispose()
})
