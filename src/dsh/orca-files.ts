import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Manifest, TraceEvent } from '@orcareplay/schema'
import { OrcaError } from './orca-types.js'
import { checkPrivatePath, openPrivateFile, readPrivateFile } from './orca-security.js'

export async function readOrcaManifest(dir: string, runId: string): Promise<Manifest> {
  const assertManifest: (value: unknown) => asserts value is Manifest = (await import('@orcareplay/schema')).assertManifest
  const value: unknown = JSON.parse((await readPrivateFile(join(dir, 'manifest.json'), 65_536)).toString('utf8'))
  assertManifest(value)
  if (value.run_id !== runId) throw new OrcaError('manifest_mismatch')
  return value
}
/** Offset reader: at most one page of JSONL, never reads/skips the prefix. */
export async function readOrcaPage(dir: string, offset: number, previousSeq: number, maxEvents: number, maxBytes: number,
  validatedBlobs = new Map<string, number>()) {
  const schema = await import('@orcareplay/schema')
  const assertEvent: (value: unknown) => asserts value is TraceEvent = schema.assertEvent
  const isBlobRef = schema.isBlobRef
  const handle = await openPrivateFile(join(dir, 'events.jsonl'))
  try {
    const stat = await handle.stat()
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size || !Number.isSafeInteger(previousSeq)
      || (offset === 0 ? previousSeq !== -1 : previousSeq < 0)) throw new OrcaError('invalid_cursor')
    let readBytes = 0
    if (offset > 0) {
      const boundary = Buffer.alloc(1)
      await handle.read(boundary, 0, 1, offset - 1); readBytes++
      if (boundary[0] !== 10) throw new OrcaError('invalid_cursor')
    }
    let buffer: Buffer = Buffer.alloc(0)
    const events: TraceEvent[] = []
    let used = 0, blobBytes = 0
    const blobs = new Map<string, number>()
    while (offset + used < stat.size && events.length < maxEvents) {
      let end = buffer.indexOf(10, used)
      while (end === -1 && offset + buffer.length < stat.size) {
        const available = maxBytes - readBytes - blobBytes
        if (available <= 0) break
        const chunk = Buffer.alloc(Math.min(4096, available, stat.size - offset - buffer.length))
        const read = await handle.read(chunk, 0, chunk.length, offset + buffer.length)
        if (read.bytesRead === 0) throw new OrcaError('file_changed')
        readBytes += read.bytesRead
        buffer = Buffer.concat([buffer, chunk.subarray(0, read.bytesRead)])
        end = buffer.indexOf(10, used)
      }
      if (end === -1) {
        if (offset + buffer.length === stat.size) throw new OrcaError('truncated_jsonl')
        if (events.length === 0) throw new OrcaError('timeline_line_limit')
        break
      }
      const event: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(used, end)))
      assertEvent(event)
      if (event.seq !== previousSeq + events.length + 1) throw new OrcaError('invalid_cursor')
      if (isBlobRef(event.payload)) {
        const ref = event.payload
        const knownBytes = validatedBlobs.get(ref.$blob)
        if (knownBytes !== undefined && knownBytes !== ref.bytes) throw new OrcaError('blob_mismatch')
        if (knownBytes === undefined) {
          if (readBytes + blobBytes + ref.bytes > maxBytes) {
            if (events.length === 0) throw new OrcaError('timeline_blob_limit')
            break
          }
          const hex = ref.$blob.slice(7)
          if (!/^[0-9a-f]{64}$/u.test(hex)) throw new OrcaError('unsafe_blob')
          await checkPrivatePath(join(dir, 'blobs'), true)
          await checkPrivatePath(join(dir, 'blobs', hex.slice(0, 2)), true)
          const bytes = await readPrivateFile(join(dir, 'blobs', hex.slice(0, 2), hex), ref.bytes)
          if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== hex) throw new OrcaError('blob_mismatch')
          blobBytes += ref.bytes
          validatedBlobs.set(ref.$blob, ref.bytes)
        }
        blobs.set(ref.$blob, ref.bytes)
      }
      events.push(event); used = end + 1
    }
    if ((await handle.stat()).size !== stat.size) throw new OrcaError('file_changed')
    return { events, offset: offset + used, previousSeq: previousSeq + events.length, done: offset + used === stat.size, bytes: used, blobs,
      raw: buffer.subarray(0, used), readBytes: readBytes + blobBytes }
  } finally { await handle.close() }
}
/** Only the known run directory is walked, with fixed maximum depth and byte budget. */
export async function orcaDiskBytes(dir: string, maxBytes: number): Promise<number> {
  let total = 0
  let entries = 0
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 3) throw new OrcaError('unexpected_trace_file')
    for (const name of await readdir(current)) {
      if (++entries > 100_000) throw new OrcaError('trace_file_limit')
      const target = join(current, name)
      const { lstat } = await import('node:fs/promises')
      const stat = await lstat(target)
      await checkPrivatePath(target, stat.isDirectory())
      if (stat.isDirectory()) await walk(target, depth + 1)
      else total += stat.size
      if (total > maxBytes) throw new OrcaError('trace_limit')
    }
  }
  await walk(dir, 0)
  return total
}
export async function scanOrcaTrace(dir: string, runId: string, maxInputBytes: number, maxEvents: number) {
  const file = await checkPrivatePath(join(dir, 'events.jsonl'), false)
  if (file.size > maxInputBytes) throw new OrcaError('export_input_limit')
  const manifest = await readOrcaManifest(dir, runId)
  if (!manifest.ended_at || !manifest.counts || !manifest.integrity) throw new OrcaError('trace_not_completed')
  let offset = 0, seq = -1, total = file.size
  const blobs = new Map<string, number>()
  const validatedBlobs = new Map<string, number>()
  const hash = createHash('sha256')
  do {
    const page = await readOrcaPage(dir, offset, seq, Math.min(200, maxEvents + 1), Math.min(maxInputBytes + 1, 16_777_216), validatedBlobs)
    offset = page.offset; seq = page.previousSeq
    hash.update(page.raw)
    if (seq + 1 > maxEvents) throw new OrcaError('export_event_limit')
    for (const [ref, bytes] of page.blobs) {
      if (!blobs.has(ref)) { total += bytes; blobs.set(ref, bytes) }
    }
    if (total > maxInputBytes) throw new OrcaError('export_input_limit')
    if (page.done) break
  } while (true)
  if (manifest.counts.events !== seq + 1 || manifest.counts.blobs !== blobs.size || manifest.integrity.blob_count !== blobs.size
    || manifest.integrity.events_sha256 !== hash.digest('hex')) throw new OrcaError('trace_integrity_mismatch')
  return { eventCount: seq + 1, exportInputBytes: total, manifest }
}
