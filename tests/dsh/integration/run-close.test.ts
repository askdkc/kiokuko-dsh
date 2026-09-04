import assert from 'node:assert/strict'
import test from 'node:test'
import { DshRunLifecycle } from '../../../src/dsh/session-bridge.js'

test('close status is immutable and concurrent callers share one commit', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const lifecycle = new DshRunLifecycle({
    closeRun: async () => { calls += 1; await blocked },
  })
  const first = lifecycle.closeTurn({ runId: 'immutable-run', status: 'completed' })
  const duplicate = lifecycle.closeTurn({ runId: 'immutable-run', status: 'completed' })
  await assert.rejects(
    lifecycle.closeTurn({ runId: 'immutable-run', status: 'failed' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  )
  release()
  await Promise.all([first, duplicate])
  await lifecycle.closeTurn({ runId: 'immutable-run', status: 'completed' })
  assert.equal(calls, 1)
  await lifecycle.dispose()
})

test('orderly disposal retries a retained terminal commit once', async () => {
  let calls = 0
  const lifecycle = new DshRunLifecycle({
    closeRun: () => { calls += 1; if (calls === 1) throw new Error('first close failed') },
  })
  await assert.rejects(lifecycle.closeTurn({ runId: 'dispose-retry', status: 'completed' }), /first close failed/u)
  await lifecycle.dispose()
  assert.equal(calls, 2)
})
