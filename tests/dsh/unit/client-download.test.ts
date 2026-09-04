import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, downloadDshSessionLog } from '../../../src/client.js'

test('client streams to File System Access API and falls back to browser navigation', async () => {
  const written: number[] = []
  const order: string[] = []
  const streamed = await downloadDshSessionLog({
    endpoint: 'http://dsh.internal/api/session.export',
    sessionId: 'session-a',
    fetch: async (_input, init) => {
      order.push('fetch')
      assert.ok(init?.signal instanceof AbortSignal)
      return new Response(Uint8Array.of(1, 2, 3))
    },
    signal: new AbortController().signal,
    window: {
      location: { assign() { throw new Error('navigation was not expected') } },
      async showSaveFilePicker() {
        order.push('picker')
        return { async createWritable() { return new WritableStream<Uint8Array>({ write(chunk) { written.push(...chunk) } }) } }
      },
    },
  })
  assert.equal(streamed, 'streamed')
  assert.deepEqual(written, [1, 2, 3])
  assert.deepEqual(order, ['picker', 'fetch'])

  let navigated = ''
  const fallback = await downloadDshSessionLog({
    endpoint: 'http://dsh.internal/api/session.export',
    sessionId: 'session-b',
    window: { location: { assign(url) { navigated = url } } },
  })
  assert.equal(fallback, 'navigated')
  assert.match(navigated, /sessionId=session-b/u)
  assert.match(navigated, /includeDescendants=true/u)
})

test('client rejects a non-success export response before opening a writable file', async () => {
  let writableOpened = false
  await assert.rejects(downloadDshSessionLog({
    endpoint: 'http://dsh.internal/api/session.export',
    sessionId: 'missing',
    fetch: async () => new Response('{"code":"not_found"}', { status: 404 }),
    window: {
      location: { assign() { throw new Error('navigation was not expected') } },
      async showSaveFilePicker() {
        return { async createWritable() {
          writableOpened = true
          return new WritableStream<Uint8Array>()
        } }
      },
    },
  }), /HTTP 404.*not_found/u)
  assert.equal(writableOpened, false)
})

test('durable completion reports project into a visible accessible chat node', () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const previousStore = globals.createSnapshotStore
  const previousJsx = globals.jsx
  globals.createSnapshotStore = (initial: unknown) => ({ getSnapshot: () => initial, update: () => undefined })
  globals.jsx = (component: unknown, props: unknown) => ({ component, props })
  let definition: any
  let render: any
  try {
    apply({
      uiConversation: { events: { register(value) { definition = value } } },
      locale: { register: () => undefined }, effect: () => undefined, on: () => undefined,
      slots: { inject: (_name, register) => register(), register: (descriptor, component) => {
        if (descriptor.key === 'kiokuko-completion-report') render = component
      } },
    })
    const event = { type: 'kiokuko/completion-report', seq: 42, data: { reportId: 'report-a', text: 'Completed. Tests: passed.' } }
    assert.deepEqual(definition.match(event), { id: 'report-a', role: 'start' })
    assert.equal(definition.match({ type: 'other', data: {} }), null)
    const state = definition.start({}, { event })
    const node = definition.buildViewNode({ key: 'report-a', id: 'report-a', state, start: { location: { kind: 'session' } } })
    assert.equal(node.target, 'chat')
    assert.equal(node.visibility, 'visible')
    assert.equal(node.anchorSeq, 42)
    const view = render({ node })
    assert.equal(view.component, 'section')
    assert.equal(view.props.role, 'status')
    assert.equal(view.props.children, event.data.text)
  } finally {
    if (previousStore === undefined) delete globals.createSnapshotStore; else globals.createSnapshotStore = previousStore
    if (previousJsx === undefined) delete globals.jsx; else globals.jsx = previousJsx
  }
})
