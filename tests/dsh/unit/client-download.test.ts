import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadDshSessionLog } from '../../../src/client.js'

test('client streams to File System Access API and falls back to browser navigation', async () => {
  const written: number[] = []
  const streamed = await downloadDshSessionLog({
    endpoint: 'http://dsh.internal/api/session.export',
    sessionId: 'session-a',
    fetch: async () => new Response(Uint8Array.of(1, 2, 3)),
    window: {
      location: { assign() { throw new Error('navigation was not expected') } },
      async showSaveFilePicker() {
        return { async createWritable() { return new WritableStream<Uint8Array>({ write(chunk) { written.push(...chunk) } }) } }
      },
    },
  })
  assert.equal(streamed, 'streamed')
  assert.deepEqual(written, [1, 2, 3])

  let navigated = ''
  const fallback = await downloadDshSessionLog({
    endpoint: 'http://dsh.internal/api/session.export',
    sessionId: 'session-b',
    window: { location: { assign(url) { navigated = url } } },
  })
  assert.equal(fallback, 'navigated')
  assert.match(navigated, /sessionId=session-b/u)
})
