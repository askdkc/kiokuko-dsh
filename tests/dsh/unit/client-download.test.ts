import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadDshSessionLog } from '../../../src/client.js'

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
