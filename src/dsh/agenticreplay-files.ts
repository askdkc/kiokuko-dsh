import { createHash } from 'node:crypto'
import { readAgenticReplayBlob } from './agenticreplay-blob.js'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAgenticReplayLibrary, type Manifest, type TraceEvent } from './agenticreplay-libraries.js'
import { AgenticReplayError } from './agenticreplay-types.js'
import { checkPrivatePath, openPrivateFile, readPrivateFile } from './agenticreplay-security.js'

export async function readAgenticReplayManifest(dir: string, runId: string): Promise<Manifest> {
  const assertManifest: (value: unknown) => asserts value is Manifest = (await loadAgenticReplayLibrary('schema')).assertManifest
  const value: unknown = JSON.parse((await readPrivateFile(join(dir, 'manifest.json'), 65_536)).toString('utf8'))
  assertManifest(value)
  if (value.run_id !== runId) throw new AgenticReplayError('manifest_mismatch')
  return value
}
export async function resolveAgenticReplayEventsFile(dir: string): Promise<string> {
  const candidates: string[] = []
  for (const name of ['events.jsonl', 'event.jsonl']) {
    const file = join(dir, name)
    try { await checkPrivatePath(file, false); candidates.push(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (candidates.length !== 1) throw new AgenticReplayError('event_file_ambiguous_or_missing')
  return candidates[0]!
}
/** Offset reader: at most one page of JSONL, never reads/skips the prefix. */
export async function readAgenticReplayPage(dir: string, offset: number, previousSeq: number, maxEvents: number, maxBytes: number,
  validatedBlobs = new Map<string, number>()) {
  const schema = await loadAgenticReplayLibrary('schema')
  const assertEvent: (value: unknown) => asserts value is TraceEvent = schema.assertEvent
  const isBlobRef = schema.isBlobRef
  const handle = await openPrivateFile(await resolveAgenticReplayEventsFile(dir))
  try {
    const stat = await handle.stat()
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size || !Number.isSafeInteger(previousSeq)
      || (offset === 0 ? previousSeq !== -1 : previousSeq < 0)) throw new AgenticReplayError('invalid_cursor')
    let readBytes = 0
    if (offset > 0) {
      const boundary = Buffer.alloc(1)
      await handle.read(boundary, 0, 1, offset - 1); readBytes++
      if (boundary[0] !== 10) throw new AgenticReplayError('invalid_cursor')
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
        if (read.bytesRead === 0) throw new AgenticReplayError('file_changed')
        readBytes += read.bytesRead
        buffer = Buffer.concat([buffer, chunk.subarray(0, read.bytesRead)])
        end = buffer.indexOf(10, used)
      }
      if (end === -1) {
        if (offset + buffer.length === stat.size) throw new AgenticReplayError('truncated_jsonl')
        if (events.length === 0) throw new AgenticReplayError('timeline_line_limit')
        break
      }
      const event: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(used, end)))
      assertEvent(event)
      if (event.seq !== previousSeq + events.length + 1) throw new AgenticReplayError('invalid_cursor')
      if (isBlobRef(event.payload)) {
        const ref = event.payload
        const knownBytes = validatedBlobs.get(ref.$blob)
        if (knownBytes !== undefined && knownBytes !== ref.bytes) throw new AgenticReplayError('blob_mismatch')
        if (knownBytes === undefined) {
          if (readBytes + blobBytes + ref.bytes > maxBytes) {
            if (events.length === 0) throw new AgenticReplayError('timeline_blob_limit')
            break
          }
          const bytes = await readAgenticReplayBlob(dir, ref, maxBytes - readBytes - blobBytes)
          blobBytes += bytes.length
          validatedBlobs.set(ref.$blob, ref.bytes)
        }
        blobs.set(ref.$blob, ref.bytes)
      }
      events.push(event); used = end + 1
    }
    if ((await handle.stat()).size !== stat.size) throw new AgenticReplayError('file_changed')
    return { events, offset: offset + used, previousSeq: previousSeq + events.length, done: offset + used === stat.size, bytes: used, blobs,
      raw: buffer.subarray(0, used), readBytes: readBytes + blobBytes }
  } finally { await handle.close() }
}
export interface AgenticReplayPrefixScanLimits {
  readonly maxEvents: number
  readonly maxBytes: number
  readonly maxPageEvents: number
  readonly maxPageBytes: number
}
/** Why a bounded diagnostic scan stopped; only `eof` means the prefix reached the current end. */
export type AgenticReplayPrefixStop = 'eof' | 'torn_tail' | 'corrupt' | 'sequence_gap' | 'changed' | 'limit'
export interface AgenticReplayPrefixScan {
  readonly verifiedEvents: number
  readonly lastSeq: number
  readonly stop: AgenticReplayPrefixStop
}
/**
 * Diagnostic-only prefix reader. It reuses the strict page parser and keeps the
 * count of fully validated events before the first damage or bound. It never
 * relaxes the complete-export parser and never returns event bodies or blobs.
 */
export async function scanAgenticReplayVerifiedPrefix(
  dir: string,
  limits: AgenticReplayPrefixScanLimits,
): Promise<AgenticReplayPrefixScan> {
  const bounded = (value: number): boolean => Number.isSafeInteger(value) && value >= 1
  if (!bounded(limits.maxEvents) || !bounded(limits.maxBytes)
    || !bounded(limits.maxPageEvents) || !bounded(limits.maxPageBytes))
    return { verifiedEvents: 0, lastSeq: -1, stop: 'limit' }
  const file = await checkPrivatePath(await resolveAgenticReplayEventsFile(dir), false)
  const stop = (reason: AgenticReplayPrefixStop, verifiedEvents: number, lastSeq: number): AgenticReplayPrefixScan =>
    ({ verifiedEvents, lastSeq, stop: reason })
  if (file.size > limits.maxBytes) return stop('limit', 0, -1)
  let offset = 0, seq = -1, verified = 0, spent = 0
  let pageEvents = limits.maxPageEvents
  while (verified < limits.maxEvents) {
    const remaining = limits.maxBytes - spent
    if (remaining < 1) return stop('limit', verified, seq)
    let page
    try {
      page = await readAgenticReplayPage(dir, offset, seq,
        Math.min(pageEvents, limits.maxEvents - verified),
        Math.min(limits.maxPageBytes, remaining))
    } catch (error) {
      // A multi-event page reports one damaged line by failing the whole page.
      // Re-read the same offset one event at a time so the verified prefix survives.
      const recoverable = !(error instanceof AgenticReplayError) || error.code !== 'unsafe_path'
      if (recoverable && pageEvents > 1) { pageEvents = 1; continue }
      if (!(error instanceof AgenticReplayError)) return stop('corrupt', verified, seq)
      switch (error.code) {
        case 'truncated_jsonl': return stop('torn_tail', verified, seq)
        case 'invalid_cursor': return stop('sequence_gap', verified, seq)
        case 'file_changed': return stop('changed', verified, seq)
        case 'timeline_line_limit':
        case 'timeline_blob_limit': return stop('limit', verified, seq)
        case 'blob_mismatch': return stop('corrupt', verified, seq)
        default: throw error
      }
    }
    spent += page.readBytes
    if (page.events.length > 0) {
      verified += page.events.length
      seq = page.previousSeq
      offset = page.offset
    }
    if (page.done) return stop('eof', verified, seq)
    if (page.events.length === 0) return stop('limit', verified, seq)
  }
  return stop('limit', verified, seq)
}
/** Only the known run directory is walked, with fixed maximum depth and byte budget. */
export async function agenticReplayDiskBytes(dir: string, maxBytes: number): Promise<number> {
  let total = 0
  let entries = 0
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 3) throw new AgenticReplayError('unexpected_trace_file')
    for (const name of await readdir(current)) {
      if (++entries > 100_000) throw new AgenticReplayError('trace_file_limit')
      const target = join(current, name)
      const { lstat } = await import('node:fs/promises')
      const stat = await lstat(target)
      await checkPrivatePath(target, stat.isDirectory())
      if (stat.isDirectory()) await walk(target, depth + 1)
      else total += stat.size
      if (total > maxBytes) throw new AgenticReplayError('trace_limit')
    }
  }
  await walk(dir, 0)
  return total
}
export async function scanAgenticReplayTrace(dir: string, runId: string, maxInputBytes: number, maxEvents: number) {
  const file = await checkPrivatePath(await resolveAgenticReplayEventsFile(dir), false)
  if (file.size > maxInputBytes) throw new AgenticReplayError('export_input_limit')
  const manifest = await readAgenticReplayManifest(dir, runId)
  if (!manifest.ended_at || !manifest.counts || !manifest.integrity) throw new AgenticReplayError('trace_not_completed')
  let offset = 0, seq = -1, total = file.size
  const blobs = new Map<string, number>()
  const validatedBlobs = new Map<string, number>()
  const hash = createHash('sha256')
  do {
    const page = await readAgenticReplayPage(dir, offset, seq, Math.min(200, maxEvents + 1), Math.min(maxInputBytes + 1, 16_777_216), validatedBlobs)
    offset = page.offset; seq = page.previousSeq
    hash.update(page.raw)
    if (seq + 1 > maxEvents) throw new AgenticReplayError('export_event_limit')
    for (const [ref, bytes] of page.blobs) {
      if (!blobs.has(ref)) { total += bytes; blobs.set(ref, bytes) }
    }
    if (total > maxInputBytes) throw new AgenticReplayError('export_input_limit')
    if (page.done) break
  } while (true)
  if (manifest.counts.events !== seq + 1 || manifest.counts.blobs !== blobs.size || manifest.integrity.blob_count !== blobs.size
    || manifest.integrity.events_sha256 !== hash.digest('hex')) throw new AgenticReplayError('trace_integrity_mismatch')
  return { eventCount: seq + 1, exportInputBytes: total, manifest }
}
