import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { SessionFormatCodec, SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { decodeSessionLog, parseJsonl } from '../../scripts/session-history-codec.mjs'
import { cloneBoundaryJson } from '../serialization/boundary-json.js'
import { canonicalJson } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import type { DshLogEvent, DshSessionLogSnapshot } from './session-memory-finalizer.js'

interface Header { readonly id: string; readonly version: number; readonly cwd?: string; readonly createdAt?: number }
interface Snapshot { readonly header: Header; readonly revision?: unknown }
interface HistoricalStore {
  stat(id: string): Promise<Snapshot | undefined>
  resolveCurrentLog(id: string): Promise<string | undefined>
  locate(header: Header): { readonly kind: string; readonly path?: string }
}

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_LOG_BYTES = 32 * 1024 * 1024
const codecs: ReadonlyMap<number, SessionFormatCodec> = new Map<number, SessionFormatCodec>([
  [0, releasedV0SessionFormatCodec], [1, releasedV1SessionFormatCodec], [2, releasedV2SessionFormatCodec],
])

function integrity(message: string): KiokukoError { return new KiokukoError('INTEGRITY_ERROR', message) }
function tooLarge(): KiokukoError {
  return new KiokukoError('VALIDATION_ERROR', 'historical DSH log exceeds the bounded import limit', {
    httpStatus: 413, code: 'legacy_log_too_large',
  })
}

/** Physical decoding only: retain historical coordinates and untrusted payloads, never restore runnable state. */
function decodeHistoricalLookup(bytes: Buffer, compressed: boolean, version: number, expected: Header): DshSessionLogSnapshot {
  let plaintext: Buffer
  try { plaintext = compressed ? decodeSessionLog(bytes, MAX_LOG_BYTES) : bytes } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge()
    throw error
  }
  if (plaintext.length > MAX_LOG_BYTES) throw tooLarge()
  const { records } = parseJsonl(plaintext)
  const codec = codecs.get(version)
  if (!codec) throw integrity('Unsupported historical lookup generation')
  const decoder = codec.createDecoder(records[0], 'strict')
  if (decoder.header.version !== version || canonicalJson({ ...decoder.header, version: expected.version }) !== canonicalJson(expected)) {
    throw integrity('Historical lookup header does not match the native session identity')
  }
  const events: DshLogEvent[] = []
  let logicalBytes = 0
  const context: SessionFormatMigrationContext = {
    emitEvent(event: SessionFormatEvent) {
      // Older physical codecs validate sequencing but defer event vocabulary
      // and some envelope checks to migration. A lookup admits JSON data only.
      if (typeof event.type !== 'string' || event.type.length === 0 || event.type === 'session'
        || event.seq !== events.length || !Number.isSafeInteger(event.time)
        || !Object.hasOwn(event, 'data')) throw integrity('Invalid historical lookup event envelope')
      const detached = cloneBoundaryJson(event, { failure: () => integrity('Invalid historical lookup event JSON') })
      logicalBytes += Buffer.byteLength(JSON.stringify(detached), 'utf8') + 1
      if (logicalBytes > MAX_LOG_BYTES) throw tooLarge()
      events.push(detached as unknown as DshLogEvent)
    },
    emitRun(run) { for (const event of run.expand()) context.emitEvent(event) },
  }
  for (const record of records.slice(1)) decoder.decodeRow(record, context)
  const inheritedEventCount = decoder.finish(context)
  return { session: decoder.header, inheritedEventCount, events }
}

/** Read one bounded immutable snapshot; a growing/replaced file is not a partial success. */
async function readHistoricalFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw integrity('Historical lookup requires a regular file')
    if (before.size > MAX_FILE_BYTES) throw tooLarge()
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const after = await file.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs || current.ino !== before.ino || current.dev !== before.dev
      || current.isSymbolicLink()) throw integrity('Historical lookup source changed while reading')
    return buffer.subarray(0, length)
  } finally { await file.close() }
}

/**
 * Look up an authoritative pre-v3 stored log using the native store's identity
 * and revision checks. Call only for cold sessions. No migration, resume,
 * native writes, or fallback past an existing current generation is allowed.
 */
export async function readHistoricalDshSession(value: unknown, sessionId: string): Promise<DshSessionLogSnapshot | undefined> {
  if (!value || typeof value !== 'object'
    || !['stat', 'resolveCurrentLog', 'locate'].every(key => typeof (value as Record<string, unknown>)[key] === 'function')) return undefined
  const store = value as HistoricalStore
  const before = await store.stat(sessionId)
  if (!before || await store.resolveCurrentLog(sessionId) !== undefined) return undefined
  if (before.header.id !== sessionId || before.header.version !== 3 || before.revision === undefined) {
    throw integrity('Historical lookup requires a native identity and revision')
  }
  const location = store.locate(before.header)
  if (location.kind !== 'jsonl' || !location.path || !isAbsolute(location.path)) return undefined
  const name = basename(location.path)
  if (name !== 'session.v3.jsonl' && name !== 'session.v3.jsonl.zstd') return undefined
  const suffix = name.endsWith('.zstd') ? '.jsonl.zstd' : '.jsonl'
  let selected: { path: string; version: number } | undefined
  for (const version of [2, 1, 0]) {
    const path = join(dirname(location.path), `session${version === 0 ? '' : `.v${version}`}${suffix}`)
    try {
      const status = await lstat(path)
      if (!status.isFile() || status.isSymbolicLink()) throw integrity('Historical lookup requires a regular source file')
      selected = { path, version }
      break
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (!selected) throw integrity('Native historical session source is unavailable')
  const bytes = await readHistoricalFile(selected.path)
  const result = decodeHistoricalLookup(bytes, suffix.endsWith('.zstd'), selected.version, before.header)
  const after = await store.stat(sessionId)
  if (!after || canonicalJson(after) !== canonicalJson(before) || await store.resolveCurrentLog(sessionId) !== undefined) {
    throw integrity('Native historical session revision changed during lookup')
  }
  return result
}
