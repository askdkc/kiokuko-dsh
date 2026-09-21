import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { requestLaya } from '../../../../src/dsh/decisions/laya-transport.js'
import { DECISION_BYTES } from '../../../../src/dsh/decisions/contracts.js'

function frame(body: Buffer | string) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body), header = Buffer.alloc(4)
  header.writeUInt32BE(data.length); return Buffer.concat([header, data])
}
async function server(t: TestContext, reply: (socket: Socket, body: Buffer) => void) {
  const dir = await mkdtemp('/tmp/klaya-'), path = `${dir}/w.sock`, sockets = new Set<Socket>()
  const listener = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let bytes = Buffer.alloc(0), received = false
    socket.on('data', chunk => {
      if (received) return
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length >= 4 && bytes.length >= bytes.readUInt32BE() + 4) { received = true; reply(socket, bytes.subarray(4)) }
    })
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => listener.close(() => resolve())); await rm(dir, { recursive: true, force: true }) })
  await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(path, resolve))
  return path
}
const signal = () => new AbortController().signal

test('UDS length prefix handles split header/body, Unicode byte length and isolated concurrent requests', { skip: process.platform === 'win32' }, async t => {
  let calls = 0
  const path = await server(t, (socket, body) => {
    calls++; const output = frame(JSON.stringify({ echo: JSON.parse(body.toString()).text }))
    let offset = 0
    const send = () => { if (offset < output.length && !socket.destroyed) { socket.write(output.subarray(offset, ++offset)); setImmediate(send) } }
    send()
  })
  const results = await Promise.all(['日本語', 'second'].map(text => requestLaya(path, JSON.stringify({ text }), signal(), 1000)))
  assert.deepEqual(results, [{ echo: '日本語' }, { echo: 'second' }]); assert.equal(calls, 2)
})

test('UDS rejects malformed, truncated and oversized frames without waiting for an unbounded payload', { skip: process.platform === 'win32' }, async t => {
  const zero = Buffer.alloc(4), huge = Buffer.alloc(4); huge.writeUInt32BE(1024 * 1024 + 1)
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(DECISION_BYTES + 1)
  for (const response of [zero, huge, oversized, frame('{'), frame(Buffer.from([0xc3, 0x28])), Buffer.from([0, 0]), frame('{"ok":true}').subarray(0, 8), Buffer.concat([frame('{}'), frame('{}')])]) {
    const path = await server(t, socket => socket.end(response))
    await assert.rejects(requestLaya(path, '{}', signal(), 500), { code: 'DECISION_MALFORMED_RESPONSE' })
  }
})

test('UDS request and response byte boundaries retain the smaller DSH limit', { skip: process.platform === 'win32' }, async t => {
  const json = JSON.stringify({ x: 'x'.repeat(DECISION_BYTES - 8) }); assert.equal(Buffer.byteLength(json), DECISION_BYTES)
  let calls = 0
  const path = await server(t, (socket, body) => { calls++; assert.equal(body.length, DECISION_BYTES); socket.write(frame(json)) })
  assert.deepEqual(await requestLaya(path, json, signal(), 1000), JSON.parse(json))
  await assert.rejects(requestLaya(path, `${json} `, signal(), 1000), { code: 'DECISION_TOO_LARGE' }); assert.equal(calls, 1)
})

test('UDS cancellation, deadline, absent socket and EOF are classified, with no retry', { skip: process.platform === 'win32' }, async t => {
  let connected!: () => void, calls = 0
  const began = new Promise<void>(resolve => { connected = resolve })
  const path = await server(t, () => { calls++; connected() })
  const parent = new AbortController(), pending = requestLaya(path, '{}', parent.signal, 1000)
  const rejected = assert.rejects(pending, { code: 'DECISION_CANCELLED' }); await began; parent.abort(); await rejected
  await assert.rejects(requestLaya(path, '{}', signal(), 20), { code: 'DECISION_TIMEOUT' }); assert.equal(calls, 2)
  await assert.rejects(requestLaya(`${path}.missing`, '{}', signal(), 1000), { code: 'DECISION_UNAVAILABLE' })
  await assert.rejects(requestLaya(path, '{}', parent.signal, 1000), { code: 'DECISION_CANCELLED' }); assert.equal(calls, 2)
})
