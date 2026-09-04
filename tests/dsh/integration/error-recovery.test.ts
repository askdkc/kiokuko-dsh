import assert from 'node:assert/strict'
import test from 'node:test'
import { DshRunLifecycle } from '../../../src/dsh/session-bridge.js'

test('failed terminal commit retains an exact-status retry without involving DSH persistence', async () => {
  let attempts = 0
  const closed: string[] = []
  const lifecycle = new DshRunLifecycle({
    closeRun: ({ status }) => {
      attempts += 1
      if (attempts === 1) throw new Error('database temporarily unavailable')
      closed.push(status)
    },
  })

  await assert.rejects(lifecycle.closeTurn({ runId: 'retry-run', status: 'completed' }), /temporarily unavailable/u)
  await assert.rejects(
    lifecycle.closeTurn({ runId: 'retry-run', status: 'failed' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  )
  await lifecycle.closeTurn({ runId: 'retry-run', status: 'completed' })
  assert.deepEqual(closed, ['completed'])
  await lifecycle.dispose()
})

test('failed and cancelled closes remain independent terminal statuses', async () => {
  const statuses: string[] = []
  const lifecycle = new DshRunLifecycle({ closeRun: ({ status }) => { statuses.push(status) } })
  await lifecycle.closeTurn({ runId: 'failed-run', status: 'failed' })
  await lifecycle.closeTurn({ runId: 'cancelled-run', status: 'cancelled' })
  assert.deepEqual(statuses, ['failed', 'cancelled'])
  await lifecycle.dispose()
})
