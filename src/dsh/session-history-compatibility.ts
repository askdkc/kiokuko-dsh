import { Context } from '@deepseek-ai/cordis'
import { constants } from 'node:fs'
import { link, lstat, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../serialization/validate.js'
import { decodeSessionLog, encodeSessionLog, parseJsonl, repairInformationalRecord, repairContinuationRecord, repairLegacyAbortRecord } from '../../scripts/session-history-codec.mjs'

interface Header { readonly id: string; readonly version: number; readonly cwd?: string }
interface Options { readonly signal?: AbortSignal }
interface Persistence {
  open(id: string, access: 'read' | 'write', options?: Options): Promise<{ close(): Promise<void> }>
  list(options?: Options): Promise<readonly { header: Header }[]>
  stat(id: string, options?: Options): Promise<{ header: Header; revision?: unknown } | undefined>
  resolveCurrentLog(id: string, signal?: AbortSignal): Promise<string | undefined>
  locate?(header: Header): { kind: string; path?: string }
  acquireWriteLease(header: Header): Promise<{ release(): Promise<void> }>
  persistHeader(header: Header, inheritedEventCount: number): Promise<void>
  readStoredLog(path: string, id: string, signal?: AbortSignal): Promise<{
    meta: Header; tornTruncateTo?: number; recoveredTail?: readonly unknown[]
  }>
}

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const ownership = Symbol.for('kiokuko-dsh.session-history-compatibility.v1')
export interface SessionHistoryCheck {
  readonly supported: boolean
  readonly listed: number
  readonly checked: number
  readonly repaired: number
  readonly failed: number
  readonly cancelled: boolean
  /** Bounded diagnostics contain session IDs and errors, never message bodies. */
  readonly failures: readonly { id: string; error: string }[]
  readonly enumerationError?: string
}
interface Installation { owners: number; ready: Promise<SessionHistoryCheck>; stop(): void; drain(): Promise<void> }
const unsupportedCheck: SessionHistoryCheck = { supported: false, listed: 0, checked: 0, repaired: 0, failed: 0, cancelled: false, failures: [] }

function nativeBackend(value: unknown): value is Persistence {
  if (!value || typeof value !== 'object') return false
  return ['open', 'list', 'stat', 'resolveCurrentLog', 'acquireWriteLease', 'persistHeader', 'readStoredLog']
    .every(key => typeof (value as Record<string, unknown>)[key] === 'function')
}

function refusalPath(error: unknown): string | undefined {
  const refusal = error as { name?: string; location?: { kind?: string; path?: unknown } } | undefined
  return refusal?.name === 'SessionFormatUnsupportedError' && refusal.location?.kind === 'jsonl'
    && typeof refusal.location.path === 'string'
    && ['session.jsonl.zstd', 'session.jsonl', 'session.v3.jsonl.zstd', 'session.v3.jsonl'].includes(basename(refusal.location.path)) ? refusal.location.path : undefined
}

/** Validate with the running backend implementation, including its current codec and identity checks. */
async function validateCandidate(backend: Persistence, header: Header, candidate: Buffer, compression: string, version: 0 | 3, signal?: AbortSignal): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-history-validation-'))
  const scope = new Context()
  const implementation = Object.getPrototypeOf(backend).constructor
  let fiber: ReturnType<Context['plugin']> | undefined
  try {
    signal?.throwIfAborted()
    fiber = scope.plugin(implementation, { root, compression })
    await fiber
    const validator = scope.get('sessionPersistence') as Persistence
    // This header only locates a native validation artifact. The candidate's
    // end-seed marker supplies its actual inherited boundary during decoding.
    await validator.persistHeader(header, 0)
    const path = await validator.resolveCurrentLog(header.id, signal)
    if (!path) throw new Error('Native history validator did not materialize its header')
    const inputPath = version === 0 ? join(dirname(path), basename(path).replace('.v3.', '.')) : path
    if (version === 0) await rm(path)
    const file = await open(inputPath, version === 0 ? 'wx' : 'w')
    try { await file.writeFile(candidate); await file.sync() } finally { await file.close() }
    if (version === 0) {
      // Let this exact native implementation migrate and publish the candidate
      // in isolation. No private format catalog or reconstructed events.
      const migrated = await validator.open(header.id, 'write', signal ? { signal } : undefined)
      await migrated.close()
    }
    const restored = await validator.readStoredLog(path, header.id, signal)
    if (restored.tornTruncateTo !== undefined || restored.recoveredTail?.length) {
      throw new Error('Legacy history compatibility cannot discard a damaged tail')
    }
    if (canonicalJson(restored.meta) !== canonicalJson(header)) throw new Error('Legacy history header changed during validation')
    return version === 0 ? await readFile(path) : candidate
  } finally {
    try { await fiber?.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
}

/** A backup is never replaced, including after an interrupted first attempt. */
async function retainBackup(path: string, original: Buffer, mode: number): Promise<void> {
  const backup = `${path}.bak`
  let file
  try { file = await open(backup, 'wx', mode) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const status = await lstat(backup)
    if (!status.isFile() || status.isSymbolicLink() || !(await readFile(backup)).equals(original)) {
      throw new Error('Existing session backup differs; refusing to overwrite it')
    }
    return
  }
  try { await file.writeFile(original); await file.sync() } finally { await file.close() }
}

/** Repair the exact rejected artifact under DSH's lock; historical v0 sources stay immutable. */
async function repairHistory(backend: Persistence, id: string, rejectedPath: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const version = ['session.jsonl', 'session.jsonl.zstd'].includes(basename(rejectedPath)) ? 0 : 3
  const snapshot = await backend.stat(id, signal ? { signal } : undefined)
  if (!snapshot || snapshot.header.id !== id || snapshot.header.version !== 3) throw new Error('Legacy session identity mismatch')
  if (version === 0 && snapshot.revision === undefined) throw new Error('Legacy source revision is unavailable')
  const current = await backend.resolveCurrentLog(id, signal)
  const location = version === 0 ? backend.locate?.(snapshot.header) : undefined
  const target = version === 0 && location?.kind === 'jsonl' ? location.path : current
  if (!target || !['session.v3.jsonl', 'session.v3.jsonl.zstd'].includes(basename(target))) throw new Error('Native current-generation location is unavailable')
  const path = version === 0 ? join(dirname(target), basename(target).replace('.v3.', '.')) : target
  if (path !== rejectedPath || (version === 0 && current !== undefined)) throw new Error('Legacy compatibility requires the exact native source artifact')
  const lease = await backend.acquireWriteLease(snapshot.header)
  try {
    signal?.throwIfAborted()
    const parent = await realpath(dirname(path))
    const status = await lstat(path)
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_COMPRESSED_BYTES) {
      throw new Error('Legacy history must be a regular file within the compatibility size limit')
    }
    const original = await readFile(path)
    if (original.length > MAX_COMPRESSED_BYTES) throw new Error('Legacy history exceeds the compatibility size limit')
    const compressed = path.endsWith('.zstd')
    const parsed = parseJsonl(compressed ? decodeSessionLog(original, MAX_EXPANDED_BYTES) : original)
    const physicalHeader = parsed.records[0] as { type?: string; id?: string; version?: number }
    if (physicalHeader?.type !== 'session' || physicalHeader.id !== id || physicalHeader.version !== version) throw new Error('Legacy physical header mismatch')
    let changed = false
    const lines = parsed.records.map((record, index) => {
      if (index === 0) return parsed.lines[index]!
      const informational = repairInformationalRecord(record)
      const compatible = version === 0 ? repairLegacyAbortRecord(repairContinuationRecord(informational)) : informational
      if (compatible === record) return parsed.lines[index]!
      changed = true
      return JSON.stringify(compatible)
    })
    if (!changed) return false
    console.info(`[kiokuko-dsh] Repairing history for ${JSON.stringify(id)}`)
    const plaintext = Buffer.from(`${lines.join('\n')}\n`)
    const candidate = await validateCandidate(backend, snapshot.header, compressed ? encodeSessionLog(plaintext) : plaintext, compressed ? 'zstd' : 'none', version, signal)
    signal?.throwIfAborted()
    if (await backend.resolveCurrentLog(id, signal) !== current
      || (version === 0 && (await backend.stat(id, signal ? { signal } : undefined))?.revision !== snapshot.revision)
      || await realpath(dirname(path)) !== parent
      || !(await readFile(path)).equals(original)) throw new Error('Legacy history changed before replacement')
    await retainBackup(path, original, status.mode & 0o777)
    const temporary = `${path}.kiokuko-${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, status.mode & 0o777)
    try {
      try { await file.writeFile(candidate); await file.sync() } finally { await file.close() }
      signal?.throwIfAborted()
      const current = await lstat(path)
      if (current.ino !== status.ino || current.dev !== status.dev || await realpath(dirname(path)) !== parent
        || !(await readFile(path)).equals(original)) throw new Error('Legacy history changed while staging compatibility update')
      // Publish a new generation without replacing the historical source or
      // overwriting a concurrently created successor.
      if (version === 0) await link(temporary, target)
      else await rename(temporary, path)
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await rm(temporary, { force: true }) }
    console.info(`[kiokuko-dsh] Repaired history for ${JSON.stringify(id)}`)
    return true
  } finally { await lease.release() }
}

/** Check every native session ID once per plugin load, including first load after an update. */
async function checkStoredSessionIds(backend: Persistence, repairedIds: ReadonlySet<string>, signal: AbortSignal): Promise<SessionHistoryCheck> {
  const result = { supported: true, listed: 0, checked: 0, repaired: 0, failed: 0, cancelled: false,
    failures: [] as { id: string; error: string }[], enumerationError: undefined as string | undefined }
  console.info('[kiokuko-dsh] Checking stored session IDs')
  try {
    const snapshots = await backend.list({ signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
    const ids = [...new Set(snapshots.map(snapshot => snapshot.header.id))]
    result.listed = ids.length
    for (const id of ids) {
      if (signal.aborted) break
      try {
        const handle = await backend.open(id, 'read', { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
        // Native open validates the complete stored history. No message content
        // is rendered, exported, or added to a model's context by this check.
        await handle.close()
        if (repairedIds.has(id)) result.repaired++
      } catch (error) {
        if (signal.aborted) break
        result.failed++
        if (result.failures.length < 20) result.failures.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
      result.checked++
    }
  } catch (error) {
    if (!signal.aborted) result.enumerationError = error instanceof Error ? error.message : String(error)
  }
  result.cancelled = signal.aborted
  console.info(`[kiokuko-dsh] Session ID check: ${result.checked}/${result.listed} checked, ${result.repaired} repaired, ${result.failed} failed${result.cancelled ? ', cancelled' : ''}`)
  if (result.enumerationError) console.warn('[kiokuko-dsh] Session ID enumeration failed:', result.enumerationError)
  for (const failure of result.failures) console.warn(`[kiokuko-dsh] Session ID check failed for ${JSON.stringify(failure.id)}: ${failure.error}`)
  const { enumerationError, ...summary } = result
  return { ...summary, ...(enumerationError === undefined ? {} : { enumerationError }) }
}

/** Own startup validation and the reversible native-open adapter until plugin unload. */
export function mountSessionHistoryCompatibility(ctx: Context): { ready: Promise<SessionHistoryCheck>; stop(): void; dispose(): Promise<void> } {
  if (typeof ctx.get !== 'function') return { ready: Promise.resolve(unsupportedCheck), stop() {}, async dispose() {} }
  const backend = ctx.get('sessionPersistence', false) as Persistence & { [ownership]?: Installation }
  if (!nativeBackend(backend)) return { ready: Promise.resolve(unsupportedCheck), stop() {}, async dispose() {} }
  let installation = backend[ownership]
  if (!installation) {
    const original = backend.open
    const descriptor = Object.getOwnPropertyDescriptor(backend, 'open')
    const pending = new Map<string, Promise<void>>()
    const repairedIds = new Set<string>()
    const startup = new AbortController()
    let active = true
    const wrapped: Persistence['open'] = async function (this: Persistence, id, access, options) {
      try { return await original.call(this, id, access, options) } catch (error) {
        const path = refusalPath(error)
        if (!active || !path) throw error
        options?.signal?.throwIfAborted()
        const operation = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
          if (!active) throw error
          return repairHistory(backend, id, path, options?.signal).then(changed => { if (changed) repairedIds.add(id) })
        })
        pending.set(id, operation)
        try { await operation } catch (cause) {
          options?.signal?.throwIfAborted()
          const detail = cause instanceof Error ? cause.message : String(cause)
          throw new Error(`Kiokuko legacy history compatibility failed (raw log: ${path}): ${detail}; original history retained or backed up`, { cause })
        } finally { if (pending.get(id) === operation) pending.delete(id) }
        options?.signal?.throwIfAborted()
        return original.call(this, id, access, options)
      }
    }
    // The microtask begins only after the adapter and shared owner are installed.
    const ready = Promise.resolve().then(() => checkStoredSessionIds(backend, repairedIds, startup.signal))
    installation = { owners: 0, ready, stop() {
      active = false
      startup.abort(new Error('Kiokuko history check stopped on plugin unload'))
      if (Object.getOwnPropertyDescriptor(backend, 'open')?.value === wrapped) {
        if (descriptor) Object.defineProperty(backend, 'open', descriptor)
        else delete (backend as Partial<Persistence>).open
      }
      delete backend[ownership]
    }, async drain() { await ready; await Promise.allSettled([...pending.values()]) } }
    Object.defineProperty(backend, 'open', { configurable: true, writable: true, value: wrapped })
    backend[ownership] = installation
  }
  const owned = installation
  owned.owners++
  let stopped = false
  const stop = () => { if (!stopped) { stopped = true; if (--owned.owners === 0) owned.stop() } }
  return { ready: owned.ready, stop, async dispose() { stop(); if (owned.owners === 0) await owned.drain() } }
}
