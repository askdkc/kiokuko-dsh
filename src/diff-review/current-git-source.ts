import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DiffReviewError, sha256, type DiffFile, type DiffHunk, type DiffLayer, type ReviewMode } from './schema.js'
import { exclusionReason, sanitizeFile } from './redaction.js'

export interface SubprocessService {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]; cwd: string
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number; signal: AbortSignal; env: NodeJS.ProcessEnv
  }): { done: PromiseLike<{ exitCode: number | null }>; collected: { stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }; stderr?: { readFrom(offset: number): { text: string } } } }
}

export interface GitLimits { maxFiles: number; maxFileBytes: number; maxSnapshotBytes: number; timeoutMs: number }
interface GitResult { code: number | null; output: string }
interface StatusEntry { path: string; oldPath?: string; x: string; y: string }

export class GitReader {
  private executable: Promise<string> | undefined
  constructor(private readonly subprocess: SubprocessService, private readonly root: string, private readonly limits: GitLimits) {}

  private async run(args: readonly string[], signal: AbortSignal, maxBytes = this.limits.maxSnapshotBytes): Promise<GitResult> {
    const executable = await (this.executable ??= this.subprocess.resolveExecutable('git', {}, signal))
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const bounded = AbortSignal.any([signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [executable, '-c', 'core.quotePath=false', ...args], cwd: this.root,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 4096 } },
      graceMs: 2000, signal: bounded,
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_EXTERNAL_DIFF: '', GIT_DIFF_OPTS: '' },
    })
    let outcome: { exitCode: number | null }
    try { outcome = await handle.done }
    catch {
      if (bounded.aborted) throw new DiffReviewError(timeout.aborted ? 'git_timeout' : 'cancelled', timeout.aborted ? 503 : 409)
      throw new DiffReviewError('git_read_failed', 503)
    }
    if (bounded.aborted) throw new DiffReviewError(timeout.aborted ? 'git_timeout' : 'cancelled', timeout.aborted ? 503 : 409)
    const output = handle.collected.stdout?.readFrom(0)
    if (output?.lossy) throw new DiffReviewError('diff_too_large', 422)
    return { code: outcome.exitCode, output: output?.text ?? '' }
  }

  private async required(args: readonly string[], signal: AbortSignal, maxBytes?: number): Promise<string> {
    const result = await this.run(args, signal, maxBytes)
    if (result.code !== 0) throw new DiffReviewError('git_read_failed', 503)
    return result.output
  }

  async available(signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.run(['rev-parse', '--show-toplevel'], signal, 8192)
      if (result.code !== 0) return false
      return (await realpath(result.output.replace(/\n$/u, ''))) === this.root
    } catch (error) {
      if (error instanceof DiffReviewError && error.code === 'cancelled') throw error
      return false
    }
  }

  async status(signal: AbortSignal): Promise<StatusEntry[]> {
    const output = await this.required(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'], signal, 128 * 1024)
    const fields = output.split('\0')
    const result: StatusEntry[] = []
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      if (!field) continue
      if (field.length < 4 || field[2] !== ' ') throw new DiffReviewError('invalid_git_status', 503)
      const x = field[0]!, y = field[1]!, path = field.slice(3)
      if (!safeRelativePath(path)) throw new DiffReviewError('invalid_git_path', 409)
      let oldPath: string | undefined
      if ('RC'.includes(x) || 'RC'.includes(y)) {
        oldPath = fields[++i]
        if (!oldPath || !safeRelativePath(oldPath)) throw new DiffReviewError('invalid_git_path', 409)
      }
      result.push({ x, y, path, ...(oldPath ? { oldPath } : {}) })
    }
    return result
  }

  async fingerprint(signal: AbortSignal): Promise<string> {
    const [status, staged, unstaged, stagedPatch, unstagedPatch, head] = await Promise.all([
      this.required(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'], signal, 128 * 1024),
      this.required(['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--no-textconv'], signal, 256 * 1024),
      this.required(['diff', '--raw', '-z', '--no-ext-diff', '--no-textconv'], signal, 256 * 1024),
      this.required(['diff', '--cached', '--root', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0'], signal),
      this.required(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0'], signal),
      this.run(['rev-parse', '--verify', 'HEAD'], signal, 128),
    ])
    return sha256(JSON.stringify([status, staged, unstaged, stagedPatch, unstagedPatch, head.code === 0 ? head.output.trim() : null]))
  }

  async matchesCapturedFiles(files: readonly DiffFile[]): Promise<boolean> {
    for (const file of files) {
      if (file.layer !== 'untracked' || !file.newPath || !file.newDigest) continue
      const current = await this.readWorking(file.newPath)
      if (!current || sha256(current) !== file.newDigest) return false
    }
    return true
  }

  async matchesWorkingDigest(path: string, digest: string): Promise<boolean> {
    if (!safeRelativePath(path)) return false
    const current = await this.readWorking(path)
    return current !== undefined && sha256(current) === digest
  }

  async capture(mode: ReviewMode, selectedUntracked: readonly string[], signal: AbortSignal): Promise<{ files: DiffFile[]; total: number; headOid?: string; indexDigest: string }> {
    if (!await this.available(signal)) throw new DiffReviewError('repo_unavailable', 422)
    const before = await this.fingerprint(signal)
    const entries = await this.status(signal)
    const selected = new Set(selectedUntracked)
    if (selected.size !== selectedUntracked.length || [...selected].some(path => !safeRelativePath(path) || !entries.some(e => e.x === '?' && e.path === path))) {
      throw new DiffReviewError('invalid_untracked_selection', 400)
    }
    const candidates: { entry: StatusEntry; layer: DiffLayer }[] = []
    for (const entry of entries) {
      if (entry.x === '?' && selected.has(entry.path)) candidates.push({ entry, layer: 'untracked' })
      if (entry.x === 'U' || entry.y === 'U' || entry.x === 'A' && entry.y === 'A' || entry.x === 'D' && entry.y === 'D') {
        if (mode === 'current' || mode === 'staged' && entry.x !== ' ' || mode === 'unstaged' && entry.y !== ' ') {
          candidates.push({ entry, layer: mode === 'unstaged' ? 'unstaged' : 'staged' })
        }
        continue
      }
      if ((mode === 'current' || mode === 'staged') && entry.x !== ' ' && entry.x !== '?') candidates.push({ entry, layer: 'staged' })
      if ((mode === 'current' || mode === 'unstaged') && entry.y !== ' ' && entry.y !== '?') candidates.push({ entry, layer: 'unstaged' })
    }
    const files: DiffFile[] = []
    for (const candidate of candidates.slice(0, this.limits.maxFiles)) {
      files.push(await this.captureFile(candidate.entry, candidate.layer, signal))
      if (Buffer.byteLength(JSON.stringify(files)) > this.limits.maxSnapshotBytes) throw new DiffReviewError('diff_too_large', 422)
    }
    if (before !== await this.fingerprint(signal)) throw new DiffReviewError('repository_changed', 409)
    for (const file of files) {
      if ((file.layer !== 'unstaged' && file.layer !== 'untracked') || !file.newPath || !file.newDigest) continue
      const current = await this.readWorking(file.newPath)
      if (!current || sha256(current) !== file.newDigest) throw new DiffReviewError('repository_changed', 409)
    }
    const head = await this.run(['rev-parse', '--verify', 'HEAD'], signal, 128)
    return { files, total: candidates.length, ...(head.code === 0 ? { headOid: head.output.trim() } : {}), indexDigest: before }
  }

  private async captureFile(entry: StatusEntry, layer: DiffLayer, signal: AbortSignal): Promise<DiffFile> {
    const path = entry.path
    const displayPath = path
    const base: DiffFile = { fileId: randomUUID(), layer, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), newPath: path, displayPath, kind: 'text', hunks: [] }
    const secretPath = exclusionReason(path)
    if (secretPath) return sanitizeFile({ ...base, kind: 'excluded', reason: secretPath })
    if (entry.x === 'U' || entry.y === 'U' || entry.x === 'A' && entry.y === 'A' || entry.x === 'D' && entry.y === 'D') return { ...base, kind: 'conflict', reason: 'unmerged' }
    if (layer === 'untracked') {
      const content = await this.readWorking(path)
      if (content === undefined) return { ...base, kind: 'symlink', reason: 'non_regular_file' }
      if (content.length > this.limits.maxFileBytes) return { ...base, kind: 'oversized', reason: 'file_limit' }
      if (content.includes(0)) return { ...base, kind: 'binary', reason: 'binary' }
      let decoded: string
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content) }
      catch { return { ...base, kind: 'binary', reason: 'invalid_text' } }
      const lines = decoded.split('\n').map(line => `+${line}`)
      if (lines.at(-1) === '+') lines.pop()
      const hunk: DiffHunk = { id: sha256(lines.join('\n')).slice(0, 16), oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }
      return sanitizeFile({ ...base, newDigest: sha256(content), hunks: [hunk], patch: `@@ -0,0 +1,${lines.length} @@\n${lines.join('\n')}` })
    }
    const args = ['diff', ...(layer === 'staged' ? ['--cached', '--root'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', ...(entry.oldPath ? [entry.oldPath] : []), path]
    let patch: string
    try { patch = await this.required(args, signal, this.limits.maxFileBytes * 2) }
    catch (error) {
      if (error instanceof DiffReviewError && error.code === 'diff_too_large') return { ...base, kind: 'oversized', reason: 'patch_limit' }
      throw error
    }
    const index = await this.run(['ls-files', '--stage', '-z', '--', path], signal, 8192)
    const mode = index.code === 0 ? /^([0-7]{6}) /u.exec(index.output)?.[1] : undefined
    const oldMode = /^old mode ([0-7]{6})/mu.exec(patch)?.[1] ?? /^deleted file mode ([0-7]{6})/mu.exec(patch)?.[1]
    const newMode = /^new mode ([0-7]{6})/mu.exec(patch)?.[1] ?? /^new file mode ([0-7]{6})/mu.exec(patch)?.[1] ?? mode
    if (layer === 'unstaged') {
      const status = await lstat(join(this.root, path)).catch(() => undefined)
      if (status?.isSymbolicLink()) return { ...base, kind: 'symlink', reason: 'symlink' }
    }
    if (newMode === '120000') return { ...base, kind: 'symlink', reason: 'symlink', newMode }
    if (newMode === '160000') return { ...base, kind: 'submodule', reason: 'submodule', newMode }
    if (/^Binary files |^GIT binary patch/mu.test(patch) || patch.includes('\uFFFD')) return { ...base, kind: 'binary', reason: 'binary_or_invalid_text' }
    const hunks = parseHunks(patch)
    const kind = hunks.length === 0 ? 'mode' : 'text'
    const newContent = layer === 'staged' ? await this.readIndex(path, signal) : await this.readWorking(path)
    const oldContent = layer === 'staged' ? await this.readHead(entry.oldPath ?? path, signal) : await this.readIndex(entry.oldPath ?? path, signal)
    if ((newContent?.length ?? 0) > this.limits.maxFileBytes || (oldContent?.length ?? 0) > this.limits.maxFileBytes) return { ...base, kind: 'oversized', reason: 'file_limit' }
    if (newContent?.includes(0) || oldContent?.includes(0)) return { ...base, kind: 'binary', reason: 'binary' }
    if (exclusionReason(path, [oldContent?.toString('utf8') ?? '', newContent?.toString('utf8') ?? ''].join('\n'))) {
      return { ...base, kind: 'excluded', reason: 'secret_content', hunks: [] }
    }
    return sanitizeFile({ ...base, kind, ...(oldMode ? { oldMode } : {}), ...(newMode ? { newMode } : {}),
      ...(oldContent ? { oldDigest: sha256(oldContent) } : {}), ...(newContent ? { newDigest: sha256(newContent) } : {}), hunks, patch })
  }

  private async readWorking(path: string): Promise<Buffer | undefined> {
    const absolute = join(this.root, path)
    const parent = await realpath(dirname(absolute))
    if (parent !== this.root && !parent.startsWith(this.root + sep)) throw new DiffReviewError('path_outside_repository', 409)
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') return undefined
      throw error
    })
    if (!handle) return undefined
    try {
      const status = await handle.stat()
      if (!status.isFile()) return undefined
      if (status.size > this.limits.maxFileBytes) return Buffer.alloc(this.limits.maxFileBytes + 1)
      const buffer = Buffer.alloc(this.limits.maxFileBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, length)
        if (chunk.bytesRead === 0) break
        length += chunk.bytesRead
      }
      return buffer.subarray(0, length)
    } finally { await handle.close() }
  }

  private async readIndex(path: string, signal: AbortSignal): Promise<Buffer | undefined> {
    try {
      const value = await this.run(['show', `:${path}`], signal, this.limits.maxFileBytes + 1)
      return value.code === 0 ? Buffer.from(value.output) : undefined
    } catch (error) {
      if (error instanceof DiffReviewError && error.code === 'diff_too_large') return Buffer.alloc(this.limits.maxFileBytes + 1)
      throw error
    }
  }

  private async readHead(path: string, signal: AbortSignal): Promise<Buffer | undefined> {
    try {
      const value = await this.run(['show', `HEAD:${path}`], signal, this.limits.maxFileBytes + 1)
      return value.code === 0 ? Buffer.from(value.output) : undefined
    } catch (error) {
      if (error instanceof DiffReviewError && error.code === 'diff_too_large') return Buffer.alloc(this.limits.maxFileBytes + 1)
      throw error
    }
  }
}

export function safeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes('\0') && !path.split(/[\\/]/u).includes('..') && relative('.', path) !== ''
}

export function parseHunks(patch: string): DiffHunk[] {
  const lines = patch.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  for (const line of lines) {
    if (line.startsWith('diff --git ')) { current = undefined; continue }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (match) {
      current = { id: sha256(`${hunks.length}:${line}`).slice(0, 16), oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), lines: [] }
      hunks.push(current)
    } else if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) current.lines.push(line)
  }
  return hunks
}
