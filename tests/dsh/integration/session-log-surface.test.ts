import assert from 'node:assert/strict'
import test from 'node:test'
import type { DshSessionLogExportService } from '../../../src/dsh/session-log-export.js'
import { dshSessionExportResponse } from '../../../src/dsh/session-log-surface.js'

test('Web export preserves typed status and HEAD never starts the body iterator', async () => {
  let iterations = 0
  const service = {
    async open() {
      return {
        status: 200 as const,
        headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="x.zip"' },
        body: (async function* () { iterations += 1; yield Uint8Array.of(1, 2, 3) })(),
      }
    },
  } as unknown as DshSessionLogExportService
  const head = await dshSessionExportResponse(service, new Request('http://dsh.internal/api/session.export?sessionId=x', { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(await head.arrayBuffer().then((value) => value.byteLength), 0)
  assert.equal(iterations, 0)

  const get = await dshSessionExportResponse(service, new Request('http://dsh.internal/api/session.export?sessionId=x'))
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), Uint8Array.of(1, 2, 3))
  assert.equal(iterations, 1)
  const bad = await dshSessionExportResponse(service, new Request('http://dsh.internal/api/session.export'))
  assert.equal(bad.status, 400)
})
