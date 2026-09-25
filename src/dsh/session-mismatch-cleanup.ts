import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, sep } from 'node:path'
import type { SessionHistoryCheck } from './session-history-compatibility.js'

interface Header { readonly id: string; readonly version: number }
export interface MismatchCleanupBackend {
  readonly root: string
  list(): Promise<readonly { header: Header }[]>
  stat(id: string): Promise<{ header: Header } | undefined>
  locate(header: Header): { kind: string; path?: string }
  resolveCurrentLog(id: string): Promise<string | undefined>
  acquireWriteLease(header: Header): Promise<{ release(): Promise<void> }>
}

export function supportsMismatchCleanup(value: unknown): value is MismatchCleanupBackend {
  if (!value || typeof value !== 'object' || typeof (value as { root?: unknown }).root !== 'string') return false
  return ['list', 'stat', 'locate', 'resolveCurrentLog', 'acquireWriteLease']
    .every(key => typeof (value as Record<string, unknown>)[key] === 'function')
}

function matchesNativeLocation(location: { kind: string; path?: string }, header: Header, path: string): boolean {
  if (location.kind !== 'jsonl' || !location.path || !isAbsolute(path)) return false
  const current = /^session\.v(3|4)\.jsonl(\.zstd)?$/u.exec(basename(location.path))
  const source = /^session(?:\.v(3))?\.jsonl(\.zstd)?$/u.exec(basename(path))
  return current !== null && source !== null && Number(current[1]) === header.version
    && dirname(location.path) === dirname(path) && current[2] === source[2]
    && Number(source[1] ?? 0) <= header.version
}

/** Match DSH's highest-generation selection without reading session contents. */
async function isSelectedGeneration(path: string): Promise<boolean> {
  const name = basename(path)
  const selectedVersion = name === 'session.jsonl' || name === 'session.jsonl.zstd'
    ? 0 : Number(/^session\.v(3)\.jsonl(?:\.zstd)?$/u.exec(name)?.[1])
  if (!Number.isInteger(selectedVersion)) return false
  const compressed = name.endsWith('.zstd')
  let latest = -1
  for (const entry of await readdir(dirname(path), { withFileTypes: true })) {
    const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u.exec(entry.name)
    if (!match) continue
    if (Boolean(match[2]) !== compressed || !entry.isFile()) return false
    latest = Math.max(latest, Number(match[1] ?? 0))
  }
  return latest === selectedVersion
}

function matchesScannedFile(file: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, identity: SessionHistoryCheck['mismatches'][number]['identity']): boolean {
  return String(file.dev) === identity.dev && String(file.ino) === identity.ino
    && String(file.size) === identity.size && String(file.mtimeNs) === identity.mtimeNs
    && String(file.ctimeNs) === identity.ctimeNs
}

/** Delete only the exact native artifact still rejected for this session ID. */
async function removeMismatchHistory(backend: MismatchCleanupBackend, mismatch: SessionHistoryCheck['mismatches'][number], signal: AbortSignal): Promise<boolean> {
  const { id, path, identity } = mismatch
  signal.throwIfAborted()
  const listed = (await backend.list()).filter(row => row.header.id === id)
  if (listed.length === 0) return false // An interrupted earlier attempt already removed it.
  if (listed.length !== 1) throw new Error('Session listing changed')
  const header = listed[0]!.header
  if (!matchesNativeLocation(backend.locate(header), header, path)) throw new Error('Native log location changed')
  const root = await realpath(backend.root)
  const parent = await realpath(dirname(path))
  if (!parent.startsWith(`${root}${sep}`)) throw new Error('Session log is outside the native store')
  const lease = await backend.acquireWriteLease(header)
  try {
    signal.throwIfAborted()
    const currentRows = (await backend.list()).filter(row => row.header.id === id)
    if (currentRows.length === 0) return false // Another mounted cleanup already removed it.
    if (currentRows.length !== 1 || currentRows[0]!.header.version !== header.version) throw new Error('Session listing changed')
    if (!matchesNativeLocation(backend.locate(currentRows[0]!.header), header, path)) throw new Error('Native log location changed')
    if (!await isSelectedGeneration(path)) throw new Error('Native log generation changed')
    const currentLog = await backend.resolveCurrentLog(id)
    if (basename(path).startsWith(`session.v${header.version}.`) ? currentLog !== path : currentLog !== undefined) {
      throw new Error('Native log generation changed')
    }
    const current = await backend.stat(id)
    if (current && (current.header.id !== id || current.header.version !== header.version)) throw new Error('Session identity changed')
    if (current && header.version === 3) throw new Error('Session identity now matches; refusing cleanup')
    const source = await lstat(path, { bigint: true })
    if (!source.isFile() || source.isSymbolicLink() || !matchesScannedFile(source, identity)) {
      throw new Error('Session log changed since the compatibility check')
    }
    if (await realpath(dirname(path)) !== parent || !matchesNativeLocation(backend.locate(header), header, path)
      || !await isSelectedGeneration(path)) {
      throw new Error('Session log location changed')
    }
    const latest = await lstat(path, { bigint: true })
    if (!matchesScannedFile(latest, identity)) throw new Error('Session log changed during cleanup')
    signal.throwIfAborted()
    await unlink(path)
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    return true
  } finally { await lease.release() }
}

/** Startup cleanup is restart-safe: each candidate is independently revalidated. */
export async function cleanupSessionMismatches(backend: MismatchCleanupBackend, check: SessionHistoryCheck, signal: AbortSignal): Promise<void> {
  if (!check.supported || check.cancelled || check.enumerationError) return
  for (const mismatch of check.mismatches) {
    if (signal.aborted) return
    try {
      if (await removeMismatchHistory(backend, mismatch, signal)) {
        console.info(`[kiokuko-dsh] [info] Removed mismatched session history for ${JSON.stringify(mismatch.id)}`)
      }
    } catch (error) {
      if (signal.aborted) return
      console.warn(`[kiokuko-dsh] [warn] Mismatched session history cleanup failed for ${JSON.stringify(mismatch.id)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
