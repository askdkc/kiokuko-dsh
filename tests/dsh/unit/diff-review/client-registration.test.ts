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

test('review refresh keeps explicit model and empty file selection without choosing a provider', async () => {
  const previousStore = (globalThis as Record<string, unknown>).createSnapshotStore
  const previousFetch = globalThis.fetch
  ;(globalThis as Record<string, unknown>).createSnapshotStore = (initial: unknown) => {
    const state = initial
    return { getSnapshot: () => state, update: (change: (value: unknown) => void) => { change(state) } }
  }
  const responses = [
    [{ provider: 'configured', model: 'first' }, { provider: 'configured', model: 'second' }],
    [{ provider: 'configured', model: 'first' }, { provider: 'configured', model: 'second' }],
    [],
    [{ provider: 'configured', model: 'replacement' }],
    [{ provider: 'configured', model: 'after-capture' }],
  ]
  const review = { reviewId: 'captured', state: 'facts-only', snapshot: { files: [{ fileId: 'file', kind: 'text' }] } }
  globalThis.fetch = async (_url, init) => init?.method === 'POST' ? Response.json(review)
    : Response.json({ availability: 'available', modelAvailability: 'available', models: responses.shift() ?? [], untracked: [], turns: [], review })
  try {
    const registrations: { key?: string; inject?: () => Record<string, unknown> }[] = []
    const slots = { inject(_name: string, register: () => unknown) { return register() },
      register(definition: { key?: string; inject?: () => Record<string, unknown> }) { registrations.push(definition); return () => undefined } }
    let providePane: ((scope: unknown) => void) | undefined
    const effects: { label: string; setup: () => unknown }[] = []
    const ctx = { slots, locale: { register: () => () => undefined, bind: () => (key: string) => key },
      uiConversation: { events: { register: () => () => undefined } }, on: () => () => undefined,
      effect(setup: () => unknown, label: string) { effects.push({ setup, label }) },
      inject(_services: string[], callback: (scope: unknown) => void) { providePane = callback } }
    apply(ctx as never)
    assert.ok(providePane)
    providePane!({ ...ctx, sidebarRight: { openTab: () => undefined }, sidebarRightTabs: { register: () => () => undefined } })
    effects.find(item => item.label === 'kiokuko-dsh: diff review tab body')!.setup()
    const injected = registrations.find(item => item.key === 'kiokuko-dsh/diff-review')!.inject!()
    const controller = injected.reviewController as { load(id: string): Promise<void>; capture(id: string): Promise<void>; change(id: string, update: object): void;
      store: { getSnapshot(): { bySession: Record<string, { modelKey: string; selected: string[]; selectedUntracked: string[] }> } } }
    const key = (model: string) => JSON.stringify(['configured', model])
    await controller.load('session')
    assert.equal(controller.store.getSnapshot().bySession.session!.modelKey, '')
    controller.change('session', { modelKey: key('second'), selected: [], selectedUntracked: ['no-longer-listed'] })
    await controller.load('session')
    assert.equal(controller.store.getSnapshot().bySession.session!.modelKey, key('second'))
    assert.deepEqual(controller.store.getSnapshot().bySession.session!.selected, [])
    assert.deepEqual(controller.store.getSnapshot().bySession.session!.selectedUntracked, [])
    await controller.load('session')
    assert.equal(controller.store.getSnapshot().bySession.session!.modelKey, '')
    assert.deepEqual(controller.store.getSnapshot().bySession.session!.selected, [])
    await controller.load('session')
    assert.equal(controller.store.getSnapshot().bySession.session!.modelKey, '')
    await controller.capture('session')
    assert.equal(controller.store.getSnapshot().bySession.session!.modelKey, '')
    assert.deepEqual(controller.store.getSnapshot().bySession.session!.selected, ['file'])
  } finally {
    globalThis.fetch = previousFetch
    ;(globalThis as Record<string, unknown>).createSnapshotStore = previousStore
  }
})

test('stop prevents an older progress response from restoring analysis', { timeout: 3_000 }, async () => {
  const previousStore = (globalThis as Record<string, unknown>).createSnapshotStore
  const previousFetch = globalThis.fetch
  ;(globalThis as Record<string, unknown>).createSnapshotStore = (initial: unknown) => {
    const state = initial
    return { getSnapshot: () => state, update: (change: (value: unknown) => void) => { change(state) } }
  }
  const facts = { reviewId: 'review', state: 'facts-only', snapshot: { mode: 'current', files: [{ fileId: 'file', kind: 'text' }] } }
  let startPoll!: () => void
  const pollStarted = new Promise<void>(resolve => { startPoll = resolve })
  let finishPoll!: (response: Response) => void
  let holdPoll = true
  let captureCalls = 0
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { action: string }
      if (body.action === 'capture') captureCalls++
      return Response.json({ ...facts, state: body.action === 'cancel' ? 'cancelled' : 'analyzing' })
    }
    if (new URL(String(url)).searchParams.has('reviewId')) {
      if (holdPoll) return new Promise<Response>(resolve => { finishPoll = resolve; startPoll() })
      return Response.json({ ...facts, state: 'analyzed' })
    }
    return Response.json({ availability: 'available', modelAvailability: 'available', models: [{ provider: 'configured', model: 'chosen' }], untracked: [], turns: [], review: facts })
  }
  let controller: { load(id: string): Promise<void>; capture(id: string): Promise<void>; analyze(id: string): Promise<void>; cancel(id: string, reviewId: string): Promise<void>;
    refreshReview(id: string, reviewId: string): Promise<void>; change(id: string, update: object): void; dispose(): Promise<void>;
    store: { getSnapshot(): { bySession: Record<string, { review: { state: string }; cancelling: boolean; error: string }> } } } | undefined
  try {
    const registrations: { key?: string; inject?: () => Record<string, unknown> }[] = []
    const slots = { inject(_name: string, register: () => unknown) { return register() },
      register(definition: { key?: string; inject?: () => Record<string, unknown> }) { registrations.push(definition); return () => undefined } }
    let providePane: ((scope: unknown) => void) | undefined
    const effects: { label: string; setup: () => unknown }[] = []
    const ctx = { slots, locale: { register: () => () => undefined, bind: () => (key: string) => key },
      uiConversation: { events: { register: () => () => undefined } }, on: () => () => undefined,
      effect(setup: () => unknown, label: string) { effects.push({ setup, label }) },
      inject(_services: string[], callback: (scope: unknown) => void) { providePane = callback } }
    apply(ctx as never)
    providePane!({ ...ctx, sidebarRight: { openTab: () => undefined }, sidebarRightTabs: { register: () => () => undefined } })
    effects.find(item => item.label === 'kiokuko-dsh: diff review tab body')!.setup()
    controller = registrations.find(item => item.key === 'kiokuko-dsh/diff-review')!.inject!().reviewController as typeof controller
    assert.ok(controller)
    await controller.load('session')
    controller.change('session', { modelKey: JSON.stringify(['configured', 'chosen']) })
    await controller.analyze('session')
    await pollStarted
    controller.change('session', { busy: false }) // Progress failed while the server still analyzes.
    await controller.capture('session')
    assert.equal(captureCalls, 0)
    await controller.cancel('session', 'review')
    assert.equal(controller.store.getSnapshot().bySession.session!.review.state, 'cancelled')
    assert.equal(controller.store.getSnapshot().bySession.session!.cancelling, false)
    finishPoll(Response.json({ ...facts, state: 'analyzing' }))
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(controller.store.getSnapshot().bySession.session!.review.state, 'cancelled')
    holdPoll = false
    controller.change('session', { error: 'older error' })
    await controller.refreshReview('session', 'review')
    assert.equal(controller.store.getSnapshot().bySession.session!.review.state, 'analyzed')
    assert.equal(controller.store.getSnapshot().bySession.session!.error, '')
  } finally {
    await controller?.dispose()
    globalThis.fetch = previousFetch
    ;(globalThis as Record<string, unknown>).createSnapshotStore = previousStore
  }
})
