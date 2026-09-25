import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../../src/client.js'

test('right pane registration is optional and can be withdrawn and provided again', () => {
  const previous = (globalThis as Record<string, unknown>).createSnapshotStore
  ;(globalThis as Record<string, unknown>).createSnapshotStore = (initial: unknown) => ({ getSnapshot: () => initial, update: () => undefined })
  try {
    const effects: { label: string; setup: () => unknown }[] = []
    const registrations: { name: string; id?: string }[] = []
    const slots = { inject(_name: string, register: () => unknown) { return register() },
      register(definition: { name: string; id?: string }) { registrations.push(definition); return () => undefined } }
    let providePane: ((scope: unknown) => void) | undefined
    const ctx = {
      slots, locale: { register: () => () => undefined, bind: () => (key: string) => key },
      uiConversation: { events: { register: () => () => undefined } }, on: () => () => undefined,
      effect(setup: () => unknown, label: string) { effects.push({ setup, label }) },
      inject(_services: string[], callback: (scope: unknown) => void) { providePane = callback },
    }
    apply(ctx as never)
    assert.equal(registrations.filter(item => item.id === 'kiokuko-diff-review-open').length, 1)
    assert.ok(providePane)
    const paneEffects: { label: string; setup: () => unknown }[] = []
    const pages: { kind: string; guide: unknown[] }[] = []
    const scope = { ...ctx, sidebarRight: { openTab: () => undefined }, sidebarRightTabs: { register(definition: { kind: string; guide: unknown[] }) {
      pages.push(definition); return () => { pages.pop() } } },
      effect(setup: () => unknown, label: string) { paneEffects.push({ setup, label }) } }
    providePane!(scope)
    const page = paneEffects.find(item => item.label === 'kiokuko-dsh: diff review page')
    assert.ok(page)
    const dispose = page.setup() as () => void
    assert.equal(pages[0]?.kind, 'kiokuko-diff-review')
    assert.equal(pages[0]?.guide.length, 1)
    dispose()
    assert.equal(pages.length, 0)
    providePane!(scope)
    const second = paneEffects.filter(item => item.label === 'kiokuko-dsh: diff review page').at(-1)!
    const disposeAgain = second.setup() as () => void
    assert.equal(pages.length, 1)
    disposeAgain()
  } finally { (globalThis as Record<string, unknown>).createSnapshotStore = previous }
})
