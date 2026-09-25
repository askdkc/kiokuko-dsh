import { lstat, open, realpath, unlink } from 'node:fs/promises'
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

function matchesNativeLocation(location: { kind: string; path?: string }, path: string): boolean {
  if (location.kind !== 'jsonl' || !location.path || !isAbsolute(path)) return false
  if (location.path === path) return ['session.v3.jsonl', 'session.v3.jsonl.zstd'].includes(basename(path))
  return dirname(location.path) === dirname(path)
    && ['session.v3.jsonl', 'session.v3.jsonl.zstd'].includes(basename(location.path))
    && ['session.jsonl', 'session.jsonl.zstd'].includes(basename(path))
}

/** Delete only the exact native artifact still rejected for this session ID. */
async function removeMismatchHistory(backend: MismatchCleanupBackend, id: string, path: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  const listed = (await backend.list()).filter(row => row.header.id === id)
  if (listed.length === 0) return false // An interrupted earlier attempt already removed it.
  if (listed.length !== 1) throw new Error('Session listing changed')
  const header = listed[0]!.header
  if (!matchesNativeLocation(backend.locate(header), path)) throw new Error('Native log location changed')
  const root = await realpath(backend.root)
  const parent = await realpath(dirname(path))
  if (!parent.startsWith(`${root}${sep}`)) throw new Error('Session log is outside the native store')
  const lease = await backend.acquireWriteLease(header)
  try {
    signal.throwIfAborted()
    const currentRows = (await backend.list()).filter(row => row.header.id === id)
    if (currentRows.length === 0) return false // Another mounted cleanup already removed it.
    if (currentRows.length !== 1 || currentRows[0]!.header.id !== header.id) throw new Error('Session listing changed')
    if (!matchesNativeLocation(backend.locate(currentRows[0]!.header), path)) throw new Error('Native log location changed')
    const currentLog = await backend.resolveCurrentLog(id)
    if (basename(path).startsWith('session.v3.') ? currentLog !== path : currentLog !== undefined) {
      throw new Error('Native log generation changed')
    }
    const current = await backend.stat(id)
    if (current?.header.id === id && current.header.version === 3) throw new Error('Session identity now matches; refusing cleanup')
    const source = await lstat(path)
    if (!source.isFile() || source.isSymbolicLink()) throw new Error('Session log is not a regular file')
    if (await realpath(dirname(path)) !== parent || !matchesNativeLocation(backend.locate(header), path)) {
      throw new Error('Session log location changed')
    }
    const latest = await lstat(path)
    if (latest.dev !== source.dev || latest.ino !== source.ino) throw new Error('Session log changed during cleanup')
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
  for (const { id, path } of check.mismatches) {
    if (signal.aborted) return
    try {
      if (await removeMismatchHistory(backend, id, path, signal)) {
        console.info(`[kiokuko-dsh] [info] Removed mismatched session history for ${JSON.stringify(id)}`)
      }
    } catch (error) {
      if (signal.aborted) return
      console.warn(`[kiokuko-dsh] [warn] Mismatched session history cleanup failed for ${JSON.stringify(id)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
