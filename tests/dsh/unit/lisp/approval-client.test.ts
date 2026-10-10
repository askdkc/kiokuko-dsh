import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../../src/client.js'

for (const modern of [false, true]) test(`${modern ? 'native config' : 'legacy settings'} keeps approval preferences out of ordinary chat`, () => {
  const globals = globalThis as unknown as Record<string, any>
  const previous = globals.createSnapshotStore
  globals.createSnapshotStore = (state: unknown) => ({ getSnapshot: () => state, update() {} })
  try {
    const registered: Array<{ definition: any; component: any }> = []
    const approvalScope = { getSnapshot: () => ({ status: 'ready', writable: true, base: { approvalMode: 'ask' }, value: { approvalMode: 'ask', lisp: { approvalMode: 'ask' } } }), subscribe: () => () => {}, set: async () => {} }
    const ctx: any = {
      uiConversation: { events: { register() {} } }, locale: { register() {} }, effect() {}, on() {},
      slots: { inject: (_name: string, register: () => void) => register(), register: (definition: any, component: any) => { registered.push({ definition, component }) } },
      inject(services: string[], callback: (scope: any) => void) {
        if (services.length !== 1 || services[0] !== (modern ? 'configForms' : 'settingsScope')) return
        callback(ctx)
      },
      settingsScope: { bind: () => approvalScope }, configForms: { get: () => approvalScope },
    }
    apply(ctx)
    const approvals = registered.filter(item => item.definition.id === 'kiokuko-lisp-approval')
    assert.deepEqual(approvals.map(item => item.definition.name), ['settings.general.item'])
    assert.equal(approvals[0]!.definition.inject().approvalScope, approvalScope)
    assert.ok(registered.some(item => item.definition.id === 'kiokuko-lisp-status'), 'session-bound recovery remains registered')
  } finally {
    if (previous === undefined) delete globals.createSnapshotStore
    else globals.createSnapshotStore = previous
  }
})
