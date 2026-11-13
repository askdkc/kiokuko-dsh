import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { readAgenticReplayPage, scanAgenticReplayTrace, agenticReplayDiskBytes } from '../../../src/dsh/agenticreplay-files.js'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { AgenticReplayError } from '../../../src/dsh/agenticreplay-types.js'

test('gzip expanded bytes enforce exact page and scan budgets and preserve continuation', async () => {
  const f = await compressedCopy()
  try {
    const budget = f.rawEvents.length + f.ref.bytes
    const exact = await readAgenticReplayPage(f.dir, 0, -1, 200, budget)
    assert.equal(exact.done, true)
    assert.equal(exact.readBytes, budget)
    assert.deepEqual(exact.events, f.events)
    assert.equal((await scanAgenticReplayTrace(f.dir, f.id, budget, 200)).exportInputBytes, budget)
    await assert.rejects(scanAgenticReplayTrace(f.dir, f.id, budget - 1, 200), errorCode('export_input_limit'))

    const cache = new Map<string, number>()
    const first = await readAgenticReplayPage(f.dir, 0, -1, 200, budget - 1, cache)
    const prefix = Buffer.byteLength(f.events.slice(0, 2).map(event => JSON.stringify(event) + '\n').join(''))
    assert.deepEqual(first.events, f.events.slice(0, 2))
    assert.equal(first.offset, prefix)
    assert.equal(first.previousSeq, 1)
    assert.equal(first.done, false)
    assert.equal(cache.size, 0)
    const remainingBudget = 1 + f.rawEvents.length - prefix + f.ref.bytes
    await assert.rejects(readAgenticReplayPage(f.dir, prefix, 1, 200, remainingBudget - 1, cache), errorCode('timeline_blob_limit'))
    assert.equal(cache.size, 0)
    const second = await readAgenticReplayPage(f.dir, prefix, 1, 200, remainingBudget, cache)
    assert.deepEqual([...first.events, ...second.events], f.events)
    assert.equal(second.offset, f.rawEvents.length)
    assert.equal(second.previousSeq, 3)
    assert.equal(second.done, true)
    assert.equal(second.readBytes, remainingBudget)
    assert.deepEqual(cache, new Map([[f.ref.$blob, f.ref.bytes]]))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('duplicate gzip references share validation across pages but fresh reads revalidate', async () => {
  const f = await compressedCopy()
  try {
    f.events[3] = { ...f.events[2], seq: 3 }
    const jsonl = f.events.map(event => JSON.stringify(event) + '\n').join('')
    await writeFile(join(f.dir, 'events.jsonl'), jsonl)
    const cache = new Map<string, number>()
    const first = await readAgenticReplayPage(f.dir, 0, -1, 3, 1_000_000, cache)
    assert.equal(first.readBytes, Buffer.byteLength(jsonl) + f.ref.bytes)
    assert.equal(first.done, false)
    const second = await readAgenticReplayPage(f.dir, first.offset, first.previousSeq, 1, 1_000_000, cache)
    assert.deepEqual(second.events, [f.events[3]])
    assert.equal(second.readBytes, 1 + Buffer.byteLength(jsonl) - first.offset)
    assert.equal(second.done, true)
    assert.deepEqual(cache, new Map([[f.ref.$blob, f.ref.bytes]]))
    const together = await readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000)
    assert.equal(together.blobs.size, 1)
    assert.equal(together.readBytes, Buffer.byteLength(jsonl) + f.ref.bytes)
    await writeFile(f.raw + '.gz', Buffer.from('corrupt gzip'))
    await assert.rejects(readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000), errorCode('blob_compression_invalid'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('failed gzip validation never populates cache and repaired bytes are validated on retry', async () => {
  const f = await compressedCopy()
  try {
    const cache = new Map<string, number>()
    for (const [stored, code] of [
      [Buffer.from('invalid gzip'), 'blob_compression_invalid'],
      [gzipSync(Buffer.alloc(f.ref.bytes, 120)), 'blob_mismatch'],
    ] as const) {
      await writeFile(f.raw + '.gz', stored)
      await assert.rejects(readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000, cache), errorCode(code))
      assert.equal(cache.size, 0)
    }
    await writeFile(f.raw + '.gz', gzipSync(f.bytes))
    assert.equal((await readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000, cache)).done, true)
    assert.deepEqual(cache, new Map([[f.ref.$blob, f.ref.bytes]]))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('conflicting declared sizes reject a duplicate gzip digest within and across pages', async () => {
  const f = await compressedCopy()
  try {
    f.events[3] = { ...f.events[2], seq: 3, payload: { ...f.ref, bytes: f.ref.bytes + 1 } }
    await writeFile(join(f.dir, 'events.jsonl'), f.events.map(event => JSON.stringify(event) + '\n').join(''))
    await assert.rejects(readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000), errorCode('blob_mismatch'))
    const cache = new Map<string, number>()
    const first = await readAgenticReplayPage(f.dir, 0, -1, 3, 1_000_000, cache)
    await assert.rejects(readAgenticReplayPage(f.dir, first.offset, first.previousSeq, 1, 1_000_000, cache), errorCode('blob_mismatch'))
    assert.deepEqual(cache, new Map([[f.ref.$blob, f.ref.bytes]]))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('mixed raw and gzip blobs preserve unique scan counts and expanded input accounting', async () => {
  const f = await compressedCopy()
  try {
    const rawBytes = Buffer.from('{"text":"second raw blob"}')
    const digest = 'sha256:' + createHash('sha256').update(rawBytes).digest('hex')
    const raw = blobPath(f.dir, digest)
    await mkdir(join(f.dir, 'blobs', digest.slice(7, 9)), { recursive: true, mode: 0o700 })
    await writeFile(raw, rawBytes, { mode: 0o600 })
    // A corrupt gzip sibling must not override the valid raw representation.
    await writeFile(raw + '.gz', Buffer.from('invalid gzip'), { mode: 0o600 })
    f.events.splice(3, 0, { ...f.events[2], payload: { ...f.ref, $blob: digest, bytes: rawBytes.length } }, { ...f.events[2] })
    f.events.forEach((event, seq) => { event.seq = seq })
    const jsonl = f.events.map(event => JSON.stringify(event) + '\n').join('')
    await writeFile(join(f.dir, 'events.jsonl'), jsonl)
    const manifestPath = join(f.dir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.counts.events = f.events.length
    manifest.counts.blobs = 2
    manifest.integrity.blob_count = 2
    manifest.integrity.events_sha256 = createHash('sha256').update(jsonl).digest('hex')
    await writeFile(manifestPath, JSON.stringify(manifest))
    const budget = Buffer.byteLength(jsonl) + f.ref.bytes + rawBytes.length
    const page = await readAgenticReplayPage(f.dir, 0, -1, 200, budget)
    assert.deepEqual(page.events, f.events)
    assert.equal(page.done, true)
    assert.equal(page.readBytes, budget)
    assert.deepEqual(page.blobs, new Map([[f.ref.$blob, f.ref.bytes], [digest, rawBytes.length]]))
    const scan = await scanAgenticReplayTrace(f.dir, f.id, budget, 200)
    assert.equal(scan.eventCount, 6)
    assert.equal(scan.exportInputBytes, budget)
    await assert.rejects(scanAgenticReplayTrace(f.dir, f.id, budget - 1, 200), errorCode('export_input_limit'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

function blobPath(dir: string, digest: string) {
  const hex = digest.slice(7)
  return join(dir, 'blobs', hex.slice(0, 2), hex)
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof AgenticReplayError && error.code === code
}

async function compressedCopy() {
  const f = await legacyCopy()
  const rawEvents = await readFile(join(f.dir, 'events.jsonl'))
  const events = rawEvents.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  const ref = events[2].payload as { $blob: string; bytes: number; media_type: string }
  const raw = blobPath(f.dir, ref.$blob)
  const bytes = await readFile(raw)
  await writeFile(raw + '.gz', gzipSync(bytes), { mode: 0o600 })
  await rm(raw)
  return { ...f, rawEvents, events, ref, raw, bytes }
}

async function legacyCopy() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gzip-'))
  const dir = join(root, 'trace')
  await cp(new URL('../../fixtures/agenticreplay-0.1.9/trace', import.meta.url), dir, { recursive: true })
  await chmod(dir, 0o700)
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600)
  }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  return { root, dir, id: manifest.run_id as string }
}

test('legacy gzip-only blobs preserve page, scan and expanded budgets without changing the fixture', async () => {
  const f = await legacyCopy()
  try {
    const before = await readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000)
    const scan = await scanAgenticReplayTrace(f.dir, f.id, 1_000_000, 200)
    const disk = await agenticReplayDiskBytes(f.dir, 1_000_000)
    assert.equal(before.blobs.size, 1)
    for (const [digest] of before.blobs) {
      const hex = digest.slice(7), raw = join(f.dir, 'blobs', hex.slice(0, 2), hex)
      await writeFile(raw + '.gz', gzipSync(await readFile(raw)), { mode: 0o600 })
      await rm(raw)
    }
    const after = await readAgenticReplayPage(f.dir, 0, -1, 200, 1_000_000)
    assert.deepEqual(after, before)
    assert.deepEqual(await scanAgenticReplayTrace(f.dir, f.id, 1_000_000, 200), scan)
    assert.ok(await agenticReplayDiskBytes(f.dir, 1_000_000) < disk)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
