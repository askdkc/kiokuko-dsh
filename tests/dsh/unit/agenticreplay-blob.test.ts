import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { readAgenticReplayBlob } from '../../../src/dsh/agenticreplay-blob.js'
import { AgenticReplayError, agenticReplayErrorCode } from '../../../src/dsh/agenticreplay-types.js'

async function fixture(body = Buffer.from('ordinary blob 日本語\n'.repeat(100))) {
  const dir = await mkdtemp(join(tmpdir(), 'private-blob-'))
  const hex = createHash('sha256').update(body).digest('hex')
  const shard = join(dir, 'blobs', hex.slice(0, 2)), raw = join(shard, hex)
  await mkdir(join(dir, 'blobs'), { mode: 0o700 })
  await mkdir(shard, { mode: 0o700 })
  const ref = Object.freeze({ $blob: `sha256:${hex}`, bytes: body.length })
  return { dir, shard, raw, body, ref, read: () => readAgenticReplayBlob(dir, ref, body.length),
    dispose: () => rm(dir, { recursive: true, force: true }) }
}
const code = (expected: string) => (error: unknown) => error instanceof AgenticReplayError && error.code === expected

for (const [target, checkIndex] of [['blobs directory', 1], ['shard', 2], ['gzip file', 3]] as const) {
  test(`gzip rejects UID mismatch at ${target}`, { skip: process.getuid === undefined }, async t => {
    const f = await fixture()
    assert.equal(typeof process.getuid, 'function')
    // Node's mock type excludes optional methods; the platform guard proves this one exists.
    const ownerProcess = process as NodeJS.Process & { getuid: () => number }
    const uid = ownerProcess.getuid()
    let checks = 0
    try {
      await writeFile(f.raw + '.gz', gzipSync(f.body), { mode: 0o600 })
      // Checks proceed through blobs, shard, then gzip (the absent raw has no stat).
      t.mock.method(ownerProcess, 'getuid', () => ++checks === checkIndex ? uid + 1 : uid)
      await assert.rejects(f.read(), code('unsafe_path'))
      assert.equal(checks, checkIndex, 'must reach the selected ownership boundary')
      t.mock.restoreAll()
      assert.deepEqual(await f.read(), f.body, 'the same files pass under their real owner')
    } finally {
      t.mock.restoreAll()
      await f.dispose()
    }
  })
}

test('gzip pathname replacement after verified open cannot replace bytes read from the original handle', async t => {
  const f = await fixture()
  const compressed = gzipSync(f.body)
  const replacement = gzipSync(Buffer.alloc(f.body.length, 120))
  let replaced = false
  try {
    await writeFile(f.raw + '.gz', compressed, { mode: 0o600 })
    const probe = await open(f.raw + '.gz', 'r')
    const prototype: FileHandle = Object.getPrototypeOf(probe)
    const originalRead = prototype.read
    const identity = await probe.stat()
    await probe.close()
    t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: Parameters<FileHandle['read']>) {
      const stat = await this.stat()
      if (!replaced && stat.ino === identity.ino && stat.dev === identity.dev) {
        replaced = true
        await rename(f.raw + '.gz', f.raw + '.opened')
        await writeFile(f.raw + '.gz', replacement, { mode: 0o600 })
      }
      return Reflect.apply(originalRead, this, args)
    })
    // The existing implementation reads the already verified inode, not its replacement pathname.
    assert.deepEqual(await f.read(), f.body)
    assert.equal(replaced, true, 'the read-time replacement must actually execute')
    t.mock.restoreAll()
    assert.deepEqual(await readFile(f.raw + '.gz'), replacement)
    assert.deepEqual(await readFile(f.raw + '.opened'), compressed)
    await assert.rejects(f.read(), code('blob_mismatch'), 'a fresh read must validate the replacement')
  } finally {
    t.mock.restoreAll()
    await f.dispose()
  }
})

for (const representation of ['raw', 'gzip', 'both'] as const) test(`private blob accepts ${representation} and prefers raw`, async () => {
  const f = await fixture()
  try {
    if (representation !== 'gzip') await writeFile(f.raw, f.body, { mode: 0o600 })
    if (representation !== 'raw') await writeFile(f.raw + '.gz', representation === 'both' ? 'invalid gzip' : gzipSync(f.body), { mode: 0o600 })
    assert.deepEqual(await f.read(), f.body)
    assert.equal(f.ref.bytes, f.body.length)
  } finally { await f.dispose() }
})

test('empty gzip uses a bounded output and still requires exactly zero bytes', async () => {
  const f = await fixture(Buffer.alloc(0))
  try {
    await writeFile(f.raw + '.gz', gzipSync(f.body), { mode: 0o600 })
    assert.deepEqual(await f.read(), Buffer.alloc(0))
    await writeFile(f.raw + '.gz', gzipSync('x'))
    await assert.rejects(f.read(), code('blob_mismatch'))
  } finally { await f.dispose() }
})

test('reference and budget validation happens before any filesystem access', async () => {
  const f = await fixture()
  try {
    await rm(join(f.dir, 'blobs'), { recursive: true })
    for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(readAgenticReplayBlob(f.dir, { ...f.ref, bytes }, 1_000_000), code('unsafe_blob'))
    }
    for (const $blob of ['../escape', 'sha256:' + 'A'.repeat(64), 'sha512:' + 'a'.repeat(64)]) {
      await assert.rejects(readAgenticReplayBlob(f.dir, { ...f.ref, $blob }, 1_000_000), code('unsafe_blob'))
    }
    for (const budget of [f.body.length - 1, -1, NaN, Infinity, 0.5]) {
      await assert.rejects(readAgenticReplayBlob(f.dir, f.ref, budget), code('timeline_blob_limit'))
    }
  } finally { await f.dispose() }
})

for (const mutation of ['garbage', 'truncated', 'crc'] as const) test(`gzip ${mutation} produces only a fixed public diagnostic`, async () => {
  const f = await fixture()
  try {
    let compressed = gzipSync(f.body)
    if (mutation === 'garbage') compressed = Buffer.from('PRIVATE_PAYLOAD_NOT_A_DIAGNOSTIC')
    if (mutation === 'truncated') compressed = compressed.subarray(0, compressed.length - 5)
    if (mutation === 'crc') compressed[compressed.length - 8] = compressed[compressed.length - 8]! ^ 1
    await writeFile(f.raw + '.gz', compressed, { mode: 0o600 })
    await assert.rejects(f.read(), error => {
      assert.equal(agenticReplayErrorCode(error), 'blob_compression_invalid')
      assert.equal((error as Error).message, 'blob_compression_invalid')
      return true
    })
  } finally { await f.dispose() }
})

for (const mutation of ['short', 'long', 'hash', 'bomb', 'members'] as const) test(`gzip ${mutation} cannot bypass expanded length or digest`, async () => {
  const f = await fixture()
  try {
    const body = mutation === 'short' ? f.body.subarray(1) : mutation === 'long' ? Buffer.concat([f.body, Buffer.from('x')])
      : mutation === 'bomb' ? Buffer.alloc(1_000_000) : Buffer.alloc(f.body.length)
    const compressed = mutation === 'members' ? Buffer.concat([gzipSync(f.body), gzipSync('x')]) : gzipSync(body)
    await writeFile(f.raw + '.gz', compressed, { mode: 0o600 })
    await assert.rejects(f.read(), code('blob_mismatch'))
  } finally { await f.dispose() }
})

test('concatenated gzip members are checked as one complete output', async () => {
  const f = await fixture()
  try {
    await writeFile(f.raw + '.gz', Buffer.concat([gzipSync(f.body.subarray(0, 5)), gzipSync(f.body.subarray(5))]), { mode: 0o600 })
    assert.deepEqual(await f.read(), f.body)
  } finally { await f.dispose() }
})

test('oversized gzip filename header is rejected by the stored-input budget', async () => {
  const f = await fixture(Buffer.alloc(0))
  try {
    const gzip = gzipSync(f.body), header = Buffer.from(gzip.subarray(0, 10))
    header[3] = 8 // FNAME; valid gzip, but its zero-terminated name exceeds the input allowance.
    await writeFile(f.raw + '.gz', Buffer.concat([header, Buffer.alloc(65_536, 65), Buffer.from([0]), gzip.subarray(10)]), { mode: 0o600 })
    await assert.rejects(f.read(), code('read_limit'))
  } finally { await f.dispose() }
})

for (const invalid of ['short', 'long', 'hash', 'mode', 'link'] as const) test(`invalid raw ${invalid} never falls back to valid gzip`, async () => {
  const f = await fixture()
  try {
    await writeFile(f.raw + '.gz', gzipSync(f.body), { mode: 0o600 })
    if (invalid === 'link') await symlink(f.raw + '.gz', f.raw)
    else {
      const bytes = invalid === 'short' ? f.body.subarray(1) : invalid === 'long' ? Buffer.concat([f.body, Buffer.from('x')])
        : invalid === 'hash' ? Buffer.alloc(f.body.length) : f.body
      await writeFile(f.raw, bytes, { mode: 0o600 })
      if (invalid === 'mode') await chmod(f.raw, 0o644)
    }
    await assert.rejects(f.read(), code(invalid === 'mode' || invalid === 'link' ? 'unsafe_path' : 'blob_mismatch'))
  } finally { await f.dispose() }
})

for (const unsafe of ['file-link', 'shard-link', 'file-mode', 'shard-mode'] as const) test(`gzip rejects ${unsafe}`, async () => {
  const f = await fixture()
  try {
    await writeFile(f.raw + '.gz', gzipSync(f.body), { mode: 0o600 })
    if (unsafe === 'file-link') {
      await rename(f.raw + '.gz', f.raw + '.saved')
      await symlink(f.raw + '.saved', f.raw + '.gz')
    } else if (unsafe === 'shard-link') {
      await rename(f.shard, f.shard + '-saved')
      await symlink(f.shard + '-saved', f.shard)
    } else await chmod(unsafe === 'file-mode' ? f.raw + '.gz' : f.shard, 0o755)
    await assert.rejects(f.read(), code('unsafe_path'))
  } finally { await f.dispose() }
})
