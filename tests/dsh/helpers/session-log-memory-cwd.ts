import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { DshSessionLogMirror } from '../../../src/dsh/session-log-mirror.js'
import { DshSessionExportError, DshSessionLogExportService } from '../../../src/dsh/session-log-export.js'
import type { DshDatabaseOperation, DshRuntime } from '../../../src/dsh/runtime.js'

const repositoryRoot = process.argv[2]
assert.ok(repositoryRoot)
const core = openConnection(':memory:')
migrateDatabase(core, join(repositoryRoot, 'migrations'))
const runtime: Pick<DshRuntime, 'withDatabase'> = {
  withDatabase: async <T>(operation: DshDatabaseOperation<T>) => operation(core, undefined as never),
}
const data = Uint8Array.from([1, 2, 3, 4])
const ref = { attachmentId: 'memory-image', mediaType: 'image/png' as const, bytes: data.byteLength, width: 1, height: 1 }
const plain = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
const image = { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'image', source: { attachment: ref } }] } }
const mirror = new DshSessionLogMirror({ runtime, databasePath: ':memory:', readAttachment: async () => ({ ref, data }) })
const explicitRoot = await mkdtemp(join(tmpdir(), 'kiokuko-memory-attachments-'))
const explicit = new DshSessionLogMirror({
  runtime, databasePath: ':memory:', attachmentDirectory: join(explicitRoot, 'attachments'),
  readAttachment: async () => ({ ref, data }),
})
try {
  const plainCheckpoint = await mirror.checkpointAfterNativeFlush({ id: 'plain', snapshotEvents: () => [plain] })
  assert.equal(plainCheckpoint.health, 'healthy')
  assert.equal((await new DshSessionLogExportService(mirror).open('plain')).status, 200)
  assert.equal(existsSync(join(process.cwd(), ':memory:.attachments')), false)

  const beforeFlush = await mirror.observe('without-directory', image)
  assert.equal(beforeFlush.error?.code, 'ATTACHMENT_CACHE_FAILED')
  await assert.rejects(new DshSessionLogExportService(mirror).open('without-directory'),
    (error: unknown) => error instanceof DshSessionExportError && error.status === 409)
  const checkpoint = await mirror.checkpointAfterNativeFlush({ id: 'without-directory', snapshotEvents: () => [plain, image] })
  assert.equal(checkpoint.error?.code, 'ATTACHMENT_CACHE_FAILED')
  assert.equal(checkpoint.health, 'degraded')
  await assert.rejects(new DshSessionLogExportService(mirror).open('without-directory'),
    (error: unknown) => error instanceof DshSessionExportError && error.status === 503 && error.code === 'cache_unavailable')
  assert.equal(existsSync(join(process.cwd(), ':memory:.attachments')), false)

  const explicitCheckpoint = await explicit.checkpointAfterNativeFlush({ id: 'with-directory', snapshotEvents: () => [plain, image] })
  assert.equal(explicitCheckpoint.health, 'healthy')
  const exported = await new DshSessionLogExportService(explicit).open('with-directory')
  const chunks: Uint8Array[] = []
  for await (const chunk of exported.body) chunks.push(chunk)
  assert.ok(Buffer.concat(chunks).includes(Buffer.from(data)))
  assert.equal(existsSync(join(process.cwd(), ':memory:.attachments')), false)

  await mirror.markFinalized('without-directory')
  await mirror.evictFinalized(0)
  await mirror.checkpointAfterNativeFlush({ id: 'without-directory', snapshotEvents: () => [plain, image] })
  assert.equal((await mirror.observe('corrupt', { type: 'old', seq: 0, time: 1 })).health, 'catching_up')
  assert.equal((await mirror.observe('corrupt', { type: 'new', seq: 0, time: 2 })).error?.code, 'INTEGRITY_ERROR')
  assert.equal((await mirror.checkpointAfterNativeFlush({ id: 'corrupt', snapshotEvents: () => [{ type: 'new', seq: 0, time: 2 }] })).health, 'healthy')
  assert.equal(existsSync(join(process.cwd(), ':memory:.attachments')), false)
} finally {
  await mirror.close()
  await explicit.close()
  core.close()
  await rm(explicitRoot, { recursive: true, force: true })
}
