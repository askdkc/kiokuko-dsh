import { loadAgenticReplayLibrary } from './agenticreplay-libraries.js'
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { AgenticReplayError } from './agenticreplay-types.js'

export const AGENTICREPLAY_RUN_ID = /^run_[0-9a-f]{6,32}$/u
export const workspaceKey = (root: string): string => createHash('sha256').update(root).digest('hex')
export function scrubAgenticReplayText(text: string): string {
  return text.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gu, '[REDACTED]')
    .replace(/\b(?:authorization|cookie|set-cookie|api[-_ ]?key|password|access[-_ ]?token|secret)\s*[:=]\s*[^\r\n,;}]+/giu, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED]')
}
/** Budget is charged before copying or escaping. Runtime objects/accessors are rejected. */
export function projectAgenticReplayJson(value: unknown, maxBytes: number): unknown {
  let remaining = maxBytes
  const seen = new Set<object>()
  function charge(n: number) { remaining -= n; if (remaining < 0) throw new AgenticReplayError('queue_limit') }
  function visit(item: unknown, depth: number): unknown {
    charge(16)
    if (depth > 32) throw new AgenticReplayError('projection_depth')
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : null
    if (typeof item === 'string') { charge(item.length * 6); return scrubAgenticReplayText(item) }
    if (typeof item !== 'object') return undefined
    if (seen.has(item)) throw new AgenticReplayError('projection_cycle')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return '[runtime object omitted]'
    seen.add(item)
    try {
      if (Array.isArray(item)) {
        charge(item.length * 8)
        return item.map(v => visit(v, depth + 1))
      }
      const result: Record<string, unknown> = {}
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        charge(key.length * 6 + 16)
        if (/authorization|cookie|credential|api.?key|password|secret|token|replayState|signal|context/iu.test(key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !('value' in descriptor)) continue
        const safeKey = scrubAgenticReplayText(key)
        if (safeKey === '__proto__' || safeKey === 'constructor') continue
        result[safeKey] = visit(descriptor.value, depth + 1)
      }
      return result
    } finally { seen.delete(item) }
  }
  return visit(value, 0)
}
export async function checkPrivatePath(target: string, directory: boolean): Promise<Stats> {
  const stat = await lstat(target)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.getuid !== undefined && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new AgenticReplayError('unsafe_path')
  }
  return stat
}
export async function privateDirectory(target: string): Promise<void> {
  try { await mkdir(target, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await checkPrivatePath(target, true)
}
/** Validate every store ancestor without chmod-ing existing user directories. */
export async function prepareAgenticReplayParent(root: string): Promise<string> {
  if (!path.isAbsolute(root) || root === path.parse(root).root || root.includes('\0')) throw new AgenticReplayError('unsafe_path')
  const ancestors: string[] = []
  let current = root
  while (true) {
    try {
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgenticReplayError('unsafe_path')
      if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) throw new AgenticReplayError('unsafe_store_parent')
      if (await realpath(current) !== current) throw new AgenticReplayError('noncanonical_store_parent')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ancestors.push(current); current = path.dirname(current)
    }
  }
  for (const directory of ancestors.reverse()) await privateDirectory(directory)
  await privateDirectory(path.join(root, '.agenticreplay'))
  await privateDirectory(path.join(root, '.agenticreplay', 'runs'))
  const ignore = path.join(root, '.agenticreplay', '.gitignore')
  try { await checkPrivatePath(ignore, false) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { ensureRunsDir } = await loadAgenticReplayLibrary('core')
  await ensureRunsDir(root)
  await checkPrivatePath(ignore, false)
  return path.join(root, '.agenticreplay', 'runs')
}
export async function checkedRunDir(root: string, runId: string): Promise<string> {
  if (!AGENTICREPLAY_RUN_ID.test(runId) || !path.isAbsolute(root) || await realpath(root) !== root) throw new AgenticReplayError('trace_not_found')
  for (const directory of [path.join(root, '.agenticreplay'), path.join(root, '.agenticreplay', 'runs'), path.join(root, '.agenticreplay', 'runs', runId)]) {
    await checkPrivatePath(directory, true)
  }
  return path.join(root, '.agenticreplay', 'runs', runId)
}
export async function openPrivateFile(target: string) {
  const before = await checkPrivatePath(target, false)
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const after = await handle.stat()
  if (before.ino !== after.ino || before.dev !== after.dev) { await handle.close(); throw new AgenticReplayError('file_changed') }
  return handle
}
export async function readPrivateFile(target: string, limit: number): Promise<Buffer> {
  const handle = await openPrivateFile(target)
  try {
    const stat = await handle.stat()
    if (stat.size > limit) throw new AgenticReplayError('read_limit')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) throw new AgenticReplayError('file_changed')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}
