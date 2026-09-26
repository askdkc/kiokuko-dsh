import assert from 'node:assert/strict'
import test from 'node:test'
import { onNativeEvent } from '../../../src/dsh/host-adapter/native-events.js'

// These lines are compiled by the repository typecheck and never executed.
if (false) {
  // @ts-expect-error Unknown event names must fail at the adapter boundary.
  onNativeEvent({}, 'agent/not-an-event', () => undefined)
  // @ts-expect-error A session-start payload cannot be treated as a tool result.
  onNativeEvent({}, 'agent/session-start', (_payload: { name: string }) => undefined)
}

test('native event registration preserves receiver, options, callback result, rejection, and disposer', async () => {
  const calls: string[] = []
  let registered: ((...args: unknown[]) => unknown) | undefined
  const source = {
    on(this: unknown, name: string, listener: (...args: unknown[]) => unknown, options?: { prepend?: boolean; global?: boolean }) {
      assert.equal(this, source)
      assert.equal(name, 'agent/pre-step')
      assert.deepEqual(options, { prepend: true, global: true })
      registered = listener
      calls.push('registered')
      return () => { calls.push('disposed') }
    },
  }
  const expected = { accepted: true }
  const dispose = onNativeEvent(source, 'agent/pre-step', (_event, next) => next(), { prepend: true, global: true })
  assert.equal(registered?.({}, () => expected), expected)
  dispose()
  assert.deepEqual(calls, ['registered', 'disposed'])

  const failure = new Error('native rejection')
  const rejecting = onNativeEvent({
    on(_name: string, listener: (...args: unknown[]) => unknown) {
      registered = listener
      return () => undefined
    },
  }, 'agent/request-error', (_event, next) => next())
  await assert.rejects(registered?.({ agent: {}, failure }, () => Promise.reject(failure)) as Promise<unknown>, error => error === failure)
  rejecting()
})

test('prepend preserves native listener order and disposal removes exactly that listener', () => {
  const listeners: Array<() => void> = []
  const order: string[] = []
  const source = {
    on(_name: string, listener: () => void, options?: { prepend?: boolean }) {
      if (options?.prepend) listeners.unshift(listener)
      else listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    },
  }
  const later = onNativeEvent(source, 'agent/idle', () => { order.push('normal') })
  const first = onNativeEvent(source, 'agent/idle', () => { order.push('prepend') }, { prepend: true })
  for (const listener of listeners) listener()
  assert.deepEqual(order, ['prepend', 'normal'])
  first()
  order.length = 0
  for (const listener of listeners) listener()
  assert.deepEqual(order, ['normal'])
  later()
  assert.equal(listeners.length, 0)
})
