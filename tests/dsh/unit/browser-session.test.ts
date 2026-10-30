import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
const { newSessionForTest } = await import(process.env.KIOKUKO_BROWSER_SESSION_SUBJECT ?? new URL('../../../scripts/browser-session.mjs', import.meta.url).href)

type Options = { drawer?: boolean; drawerStaysOpen?: boolean; reuseId?: string; returnedId?: string; clickError?: boolean; networkError?: boolean; ok?: boolean; displayedId?: string; displayedPhase?: string }
function fixture(options: Options = {}) {
  const page = new EventEmitter() as any
  let drawerOpen = false, displayedId = 'old', phase = 'active', clicks = 0, opened = 0
  let resolve!: (response: any) => void, reject!: (error: Error) => void
  const response = { status: () => 200, url: () => 'http://localhost/api/session/create', request: () => ({ method: () => 'POST', postDataJSON: () => ({ payload: { args: { request: options.reuseId === undefined ? {} : { sessionId: options.reuseId } } } }) }), json: async () => ({ result: { ok: options.ok !== false, value: { sessionId: options.returnedId ?? 'new' } } }) }
  page.waitForResponse = () => new Promise((yes, no) => { resolve = yes; reject = no })
  const locator = (kind: string): any => ({ filter() { return this }, first() { return this },
    count: async () => kind === 'drawer' && options.drawer && !drawerOpen ? 1 : 0,
    waitFor: async () => { assert.equal(drawerOpen, true, 'the real drawer must be open before its controls are used') },
    click: async () => {
      if (kind === 'opener') { drawerOpen = true; opened++; return }
      clicks++
      if (options.clickError || options.drawer && !drawerOpen) {
        // A second asynchronous failure must be observed even when the click rejects first.
        setImmediate(() => reject(new Error('RESPONSE_WAIT_CLOSED')))
        throw new Error('CLICK_BLOCKED')
      }
      if (options.networkError) { reject(new Error('REQUEST_FAILED')); return }
      displayedId = options.displayedId ?? options.returnedId ?? 'new'; phase = options.displayedPhase ?? 'hero'
      if (!options.drawerStaysOpen) drawerOpen = false
      page.emit('response', response); resolve(response)
    },
  })
  page.locator = (selector: string) => locator(selector.includes('data-sidebar-drawer') ? 'drawer' : 'opener')
  page.getByRole = (role: string) => locator(role === 'dialog' ? 'dialog' : 'create')
  const conversation = { getAttribute: async (key: string) => key === 'data-conversation-session' ? displayedId : phase }
  const poll = async (read: () => Promise<unknown>) => { for (let i = 0; i < 3; i++) { const value = await read(); if (value) return value }; throw new Error('DISPLAY_NOT_READY') }
  return { page, conversation, run: () => newSessionForTest(page, conversation, poll), state: () => ({ clicks, opened, responseListeners: page.listenerCount('response') }) }
}

for (const drawer of [false, true]) test(`new session follows the actual response with drawer=${drawer}`, async () => {
  const f = fixture({ drawer }); const result = await f.run()
  assert.deepEqual(result, { previous: 'old', sessionId: 'new', reused: false })
  assert.deepEqual(f.state(), { clicks: 1, opened: drawer ? 1 : 0, responseListeners: 0 })
})
test('a drawer opened for creation must close again before navigation succeeds', async () => {
  await assert.rejects(fixture({ drawer: true, drawerStaysOpen: true }).run(), /DISPLAY_NOT_READY/)
})
test('explicitly named blank can be reused without a new ID', async () => {
  const f = fixture({ drawer: true, reuseId: 'old', returnedId: 'old' })
  assert.equal((await f.run()).reused, true)
})
test('Host may decline a cached blank candidate that is now nonempty and return a fresh session', async () => {
  const f = fixture({ reuseId: 'old', returnedId: 'fresh' })
  assert.deepEqual(await f.run(), { previous: 'old', sessionId: 'fresh', reused: false })
})
test('same ID without an explicit reuse request is rejected', async () => {
  await assert.rejects(fixture({ returnedId: 'old' }).run(), /reuse|different session/)
})
test('a successful API response cannot substitute for selecting its actual UI session', async () => {
  await assert.rejects(fixture({ displayedId: 'wrong' }).run(), /DISPLAY_NOT_READY/)
})
test('an active nonempty conversation cannot substitute for the new blank session', async () => {
  await assert.rejects(fixture({ displayedPhase: 'active' }).run(), /DISPLAY_NOT_READY/)
})
test('click rejection stays primary, observes the abandoned response wait, and removes listeners', async () => {
  const f = fixture({ clickError: true })
  await assert.rejects(f.run(), /CLICK_BLOCKED/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.state().responseListeners, 0)
})
test('network failure and native refusal never become successful navigation', async () => {
  const network = fixture({ networkError: true })
  await assert.rejects(network.run(), /Session create response absent/)
  assert.equal(network.state().responseListeners, 0)
  const refused = fixture({ ok: false })
  await assert.rejects(refused.run(), /native session creation must succeed/)
  assert.equal(refused.state().responseListeners, 0)
})
