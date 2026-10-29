import assert from 'node:assert/strict'
import test from 'node:test'
import { mountRecoveryClient, openRecoveryDraft } from '../../../src/recovery-client.js'

test('recovery remains discoverable and places a draft before native navigation, preserving existing input', () => {
  const order: string[] = [], slots: any[] = []
  const binding = { sessionId: 'fresh' }
  const ctx: any = {
    get(name: string) { return {
      sessions: { retain: (id: string) => { assert.equal(id, 'fresh'); order.push('retain'); return { release: () => order.push('release') } }, binding: () => binding },
      conversation: { input: { requestDraftInitialization: (actual: unknown, options: unknown) => { assert.equal(actual, binding); assert.deepEqual(options, { prompt: 'Original request', whenDraftExists: 'keep' }); order.push('draft'); return 'preserved' } } },
      uiWorkspace: { openSession: () => order.push('open') },
    }[name] },
    effect() {}, locale: { register() {} },
    slots: { inject: (_name: string, register: () => void) => register(), register: (definition: any, component: unknown) => { slots.push({ definition, component }) } },
  }
  mountRecoveryClient(ctx)
  const action = slots.find(slot => slot.definition.id === 'kiokuko-session-recovery')
  assert.ok(action)
  assert.equal(typeof action.component, 'function')
  action.definition.inject().openRecovery('fresh', 'Original request')
  assert.deepEqual(order, ['retain', 'draft', 'open', 'release'])
})
test('a blocked draft leaves navigation alone and releases the exact retained generation', () => {
  let released = 0, opened = 0
  const ctx: any = { get: (name: string) => ({
    sessions: { retain: () => ({ release: () => released++ }), binding: () => ({ sessionId: 'fresh' }) },
    conversation: { input: { requestDraftInitialization: () => 'blocked' } },
    uiWorkspace: { openSession: () => opened++ },
  }[name]) }
  assert.throws(() => openRecoveryDraft(ctx, 'fresh', 'Original request'), /保持/)
  assert.equal(opened, 0)
  assert.equal(released, 1)
})
