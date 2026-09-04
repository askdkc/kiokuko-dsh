import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import type { DshDatabaseOperation, DshRuntime } from '../../../src/dsh/runtime.js'
import { DshSessionLogMirror } from '../../../src/dsh/session-log-mirror.js'
import { DshSessionExportError, DshSessionLogExportService } from '../../../src/dsh/session-log-export.js'
import { KiokukoError } from '../../../src/errors.js'

async function fixture(readAttachment?: ConstructorParameters<typeof DshSessionLogMirror>[0]['readAttachment']) {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-session-export-'))
  const core = openConnection(join(root, 'core.sqlite3'))
  migrateDatabase(core, join(process.cwd(), 'migrations'))
  const runtime: Pick<DshRuntime, 'withDatabase'> = {
    withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(core, undefined as never),
  }
  const mirror = new DshSessionLogMirror({ runtime, databasePath: join(root, 'mirror.sqlite3'), ...(readAttachment === undefined ? {} : { readAttachment }) })
  return { mirror, cleanup: async () => { await mirror.close(); core.close(); await rm(root, { recursive: true, force: true }) } }
}

test('export maps readiness to typed non-500 failures and emits bounded streaming ZIP bytes', async () => {
  const f = await fixture()
  const service = new DshSessionLogExportService(f.mirror)
  try {
    await assert.rejects(service.open('missing'), (error: unknown) => error instanceof DshSessionExportError && error.status === 404)
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'tool/result', seq: 1, time: 2, data: { text: 'x'.repeat(70 * 1024) } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1 } },
    ]
    await f.mirror.observe('export-session', events[0]!)
    await assert.rejects(service.open('export-session'), (error: unknown) => error instanceof DshSessionExportError && error.status === 409)
    await f.mirror.checkpointAfterNativeFlush({ id: 'export-session', snapshotEvents: () => events })

    const opened = await service.open('export-session')
    assert.equal(opened.status, 200)
    assert.equal(opened.headers['content-type'], 'application/zip')
    const chunks: Uint8Array[] = []
    let highWater = 0
    for await (const chunk of opened.body) {
      chunks.push(chunk)
      highWater = Math.max(highWater, chunk.byteLength)
    }
    assert.ok(highWater <= 1024 * 1024)
    const zip = Buffer.concat(chunks)
    assert.equal(zip.readUInt32LE(0), 0x04034b50)
    const nameLength = zip.readUInt16LE(26)
    const contentStart = 30 + nameLength
    const descriptor = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), contentStart)
    assert.ok(descriptor > contentStart)
    const jsonl = zip.subarray(contentStart, descriptor).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(jsonl.map((event) => event.seq), [0, 1, 2])
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50)
  } finally {
    await f.cleanup()
  }
})

test('export durably flushes a live session before evaluating mirror readiness', async () => {
  const f = await fixture()
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1 } },
  ]
  const calls: string[] = []
  const service = new DshSessionLogExportService(f.mirror, {
    ensureNativeDurable: async (sessionId) => {
      calls.push(sessionId)
      await f.mirror.checkpointAfterNativeFlush({ id: sessionId, snapshotEvents: () => events })
    },
  })
  try {
    const opened = await service.open('live-export-session')
    assert.equal(opened.status, 200)
    assert.deepEqual(calls, ['live-export-session'])
  } finally {
    await f.cleanup()
  }
})

test('export maps a live native flush failure to typed 503 without opening a body', async () => {
  const f = await fixture()
  const service = new DshSessionLogExportService(f.mirror, {
    ensureNativeDurable: async () => { throw new Error('native flush failed') },
  })
  try {
    await assert.rejects(service.open('live-export-session'), (error: unknown) => (
      error instanceof DshSessionExportError
      && error.status === 503
      && error.code === 'cache_unavailable'
    ))
  } finally {
    await f.cleanup()
  }
})

test('export preserves typed cold-reader absence and legacy size failures', async () => {
  const f = await fixture()
  try {
    const missing = new DshSessionLogExportService(f.mirror, {
      ensureNativeDurable: async () => { throw new KiokukoError('NOT_FOUND', 'missing') },
    })
    await assert.rejects(missing.open('cold-missing'), (error: unknown) => (
      error instanceof DshSessionExportError && error.status === 404 && error.code === 'session_not_found'
    ))

    const oversized = new DshSessionLogExportService(f.mirror, {
      ensureNativeDurable: async () => {
        throw new KiokukoError('VALIDATION_ERROR', 'legacy log is too large', {
          httpStatus: 413,
          code: 'legacy_log_too_large',
        })
      },
    })
    await assert.rejects(oversized.open('cold-oversized'), (error: unknown) => (
      error instanceof DshSessionExportError && error.status === 413 && error.code === 'legacy_log_too_large'
    ))
  } finally {
    await f.cleanup()
  }
})

test('export mirrors verified DSH attachments and streams them with an identity manifest', async () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5, 6])
  const ref = { attachmentId: 'opaque-image-1', mediaType: 'image/png' as const, bytes: data.byteLength, width: 1, height: 1, name: 'proof.png' }
  const f = await fixture(async (requested) => {
    assert.deepEqual(requested, ref)
    return { ref, data }
  })
  try {
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'image', source: { attachment: ref } }] } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1 } },
    ]
    await f.mirror.checkpointAfterNativeFlush({ id: 'attachment-session', snapshotEvents: () => events })
    const opened = await new DshSessionLogExportService(f.mirror).open('attachment-session')
    const chunks: Uint8Array[] = []
    for await (const chunk of opened.body) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    const entries = new Map<string, Buffer>()
    let offset = 0
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
      const nameLength = bytes.readUInt16LE(offset + 26)
      const extraLength = bytes.readUInt16LE(offset + 28)
      const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
      const contentStart = offset + 30 + nameLength + extraLength
      const descriptor = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), contentStart)
      assert.ok(descriptor >= contentStart)
      entries.set(name, bytes.subarray(contentStart, descriptor))
      offset = descriptor + 16
    }
    const manifest = [...entries.entries()].find(([name]) => name === 'attachments/manifest.jsonl')
    assert.ok(manifest)
    const record = JSON.parse(manifest[1].toString('utf8'))
    assert.equal(record.attachmentId, ref.attachmentId)
    assert.equal(record.name, ref.name)
    assert.deepEqual(entries.get(record.path), Buffer.from(data))
  } finally {
    await f.cleanup()
  }
})
