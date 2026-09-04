import assert from 'node:assert/strict'
import test from 'node:test'
import { DshRunLifecycle, mountDshIdleLifecycle, mountDshSessionLifecycle } from '../../../src/dsh/session-bridge.js'

test('terminal idle resolves state before the exact native DSH checkpoint and close', async () => {
  const order: string[] = []
  let listener: ((event: { agent: { id: string; session: { id: string; snapshotEvents(): readonly any[] } }; status: string }) => unknown) | undefined
  const nativeSession = { id: 'durable-session', snapshotEvents: () => [
    { type: 'turn/start', seq: 3, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 9, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ] }
  const lifecycle = new DshRunLifecycle({ closeRun: (close) => { assert.equal(close.sourceEndSeq, 9); order.push('kiokuko-close') } })
  const dispose = mountDshIdleLifecycle({
    on(_name, next) { listener = next as typeof listener; return () => { listener = undefined } },
  }, lifecycle, async () => { order.push('resolve-terminal'); return { runId: 'durable-run', status: 'completed' as const, terminalTurn: 1 } }, async (session) => {
    assert.equal(session, nativeSession)
    order.push('native-flush')
  })

  await listener?.({ agent: { id: 'durable-agent', session: nativeSession }, status: 'idle' })
  assert.deepEqual(order, ['resolve-terminal', 'native-flush', 'kiokuko-close'])
  dispose()
  await lifecycle.dispose()
})

test('ordinary idle performs no DSH flush and no Kiokuko close', async () => {
  let listener: ((event: { agent: { id: string; session: { id: string } }; status: string }) => unknown) | undefined
  let flushes = 0
  let closes = 0
  const lifecycle = new DshRunLifecycle({ closeRun: () => { closes += 1 } })
  const dispose = mountDshIdleLifecycle({
    on(_name, next) { listener = next as typeof listener; return () => { listener = undefined } },
  }, lifecycle, async () => undefined, async () => { flushes += 1 })
  await listener?.({ agent: { id: 'active-agent', session: { id: 'active-session' } }, status: 'idle' })
  assert.equal(flushes, 0)
  assert.equal(closes, 0)
  dispose()
  await lifecycle.dispose()
})

test('session disposal checkpoints before closing the final conversation run', async () => {
  const order: string[] = []
  let listener: ((session: { id: string; snapshotEvents(): readonly any[] }) => unknown) | undefined
  const nativeSession = { id: 'conversation-session', snapshotEvents: () => [
    { type: 'turn/start', seq: 12, time: 1, data: { turn: 4 } },
    { type: 'turn/end', seq: 18, time: 2, data: { turn: 4, reason: { kind: 'completed' } } },
  ] }
  const lifecycle = new DshRunLifecycle({ closeRun: (close) => { assert.equal(close.sourceEndSeq, 18); order.push('close') } })
  const dispose = mountDshSessionLifecycle({
    on(_name, next) { listener = next; return () => { listener = undefined } },
  }, lifecycle, async (sessionId, session) => {
    assert.equal(sessionId, nativeSession.id)
    assert.equal(session, nativeSession)
    order.push('resolve')
    return { runId: 'conversation-run', status: 'completed' as const, terminalTurn: 4 }
  }, async (session) => { assert.equal(session, nativeSession); order.push('flush') })
  await listener?.(nativeSession)
  assert.deepEqual(order, ['resolve', 'flush', 'close'])
  dispose()
  await lifecycle.dispose()
})

test('checkpoint failure is contained and prevents a false Kiokuko close', async () => {
  let listener: ((event: { agent: { id: string; session: { id: string } }; status: string }) => unknown) | undefined
  let closes = 0
  const lifecycle = new DshRunLifecycle({ closeRun: () => { closes += 1 } })
  mountDshIdleLifecycle({
    on(_name, next) { listener = next as typeof listener; return () => undefined },
  }, lifecycle, async () => ({ runId: 'failed-run', status: 'failed' as const }), async () => { throw new Error('flush failed') })
  await assert.doesNotReject(async () => listener?.({ agent: { id: 'agent', session: { id: 'session' } }, status: 'idle' }))
  assert.equal(closes, 0)
  await lifecycle.dispose()
})
