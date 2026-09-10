import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { KiokukoError } from '../errors.js'
import { findSecretInValue } from '../memory/secrets.js'
import { assertDeepAuthority, readDeepState, type DeepAuthority, type DeepStore } from './store.js'
import type { DeepArtifact } from './core/contracts.js'

export const DEEP_READ_TOOLS = ['deep_read_file', 'deep_list_files', 'deep_search_files'] as const
const requestSchema = z.object({ path: z.string().min(1).max(4_096), startLine: z.number().int().min(1).max(1_000_000).optional(), lines: z.number().int().min(1).max(200).optional(), query: z.string().min(1).max(256).optional() }).strict()
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Reject every symlink component; open the final file without following a replacement symlink. */
export async function deepCanonicalPath(root: string, supplied: string): Promise<string> {
  if (await realpath(root) !== root) throw new KiokukoError('CONFLICT', 'Deep workspace identity changed')
  const target = path.resolve(root, supplied), relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new KiokukoError('SECURITY_REJECTION', 'Deep reads must stay inside the workspace')
  let current = root
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if ((await lstat(current)).isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', 'Deep does not follow symbolic links')
  }
  return target
}
export async function readDeepFile(root: string, supplied: string): Promise<{ path: string; text: string; sourceDigest: string }> {
  const canonical = await deepCanonicalPath(root, supplied)
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 1_048_576) throw new KiokukoError('VALIDATION_ERROR', 'Deep reads text files up to 1 MiB; choose a smaller source')
    const bytes = await handle.readFile()
    const after = await handle.stat(), current = await lstat(canonical)
    if (bytes.length > 1_048_576 || before.ino !== current.ino || before.dev !== current.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new KiokukoError('CONFLICT', 'Source changed during reading')
    await deepCanonicalPath(root, supplied)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\u0000')) throw new KiokukoError('VALIDATION_ERROR', 'Deep accepts text sources only')
    return { path: path.relative(root, canonical), text, sourceDigest: digest(bytes) }
  } finally { await handle.close() }
}

/** Bounded read-only tools registered only in the managed child's scope. */
export class DeepReadPort {
  constructor(readonly store: DeepStore) {}
  async execute(authority: DeepAuthority, name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    const input = requestSchema.parse(raw)
    signal.throwIfAborted()
    const state = await this.store.database(db => { const state = readDeepState(db, authority.runId); assertDeepAuthority(db, state, authority, this.store.now()); return state })
    if (name === 'deep_read_file') {
      const source = await readDeepFile(state.rootPath, input.path)
      const startLine = input.startLine ?? 1, lines = source.text.split('\n')
      if (startLine > lines.length) throw new KiokukoError('VALIDATION_ERROR', 'startLine is beyond the end of the file')
      const selected: string[] = []; let bytes = 0
      for (const line of lines.slice(startLine - 1, startLine - 1 + (input.lines ?? 120))) {
        if (bytes + Buffer.byteLength(line) + 1 > 16_384) break
        selected.push(line); bytes += Buffer.byteLength(line) + 1
      }
      if (!selected.length) throw new KiokukoError('VALIDATION_ERROR', 'The selected line exceeds the read limit')
      const content = selected.join('\n')
      if (findSecretInValue(content)) throw new KiokukoError('SECURITY_REJECTION', 'Secret-shaped source content was not returned or stored')
      const artifact: DeepArtifact = { id: randomUUID(), runId: state.runId, nodeId: authority.nodeId, nodeRevision: authority.nodeRevision, requirementRevision: authority.requirementRevision, path: source.path, content, digest: digest(content), sourceDigest: source.sourceDigest, startLine, endLine: startLine + selected.length - 1 }
      signal.throwIfAborted()
      await this.store.transaction(db => {
        assertDeepAuthority(db, readDeepState(db, state.runId), authority, this.store.now())
        const count = db.prepare('SELECT count(*) AS count FROM dsh_deep_artifacts WHERE run_id=?').get<{count:number}>(state.runId)!.count
        if (count >= 256) throw new KiokukoError('VALIDATION_ERROR', 'Deep artifact limit reached')
        db.prepare('INSERT INTO dsh_deep_artifacts VALUES(?,?,?,?)').run(artifact.id, state.runId, authority.nodeId, JSON.stringify(artifact))
      })
      return { artifactId: artifact.id, path: artifact.path, startLine, endLine: artifact.endLine, content, truncated: artifact.endLine < lines.length }
    }
    if (name !== 'deep_list_files' && name !== 'deep_search_files') throw new KiokukoError('SECURITY_REJECTION', 'Unknown Deep read capability')
    const directory = await deepCanonicalPath(state.rootPath, input.path)
    if (!(await lstat(directory)).isDirectory()) throw new KiokukoError('VALIDATION_ERROR', 'Choose a directory')
    if (name === 'deep_search_files' && !input.query) throw new KiokukoError('VALIDATION_ERROR', 'A literal search query is required')
    const result: unknown[] = [], queue = [directory]; let inspected = 0
    while (queue.length && inspected < 2_000 && result.length < 100) {
      signal.throwIfAborted()
      const parent = queue.shift()!
      await deepCanonicalPath(state.rootPath, parent)
      const entries = await opendir(parent)
      for await (const entry of entries) {
        if (++inspected > 2_000 || result.length >= 100) break
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.env', 'dist'].includes(entry.name)) continue
        const target = path.join(parent, entry.name), relative = path.relative(state.rootPath, target)
        if (name === 'deep_list_files') result.push({ path: relative, kind: entry.isDirectory() ? 'directory' : 'file' })
        else if (entry.isDirectory()) { if (queue.length < 100) queue.push(target) }
        else if (entry.isFile()) {
          let source: Awaited<ReturnType<typeof readDeepFile>>
          try { source = await readDeepFile(state.rootPath, relative) } catch { continue }
          if (findSecretInValue(source.text)) continue
          source.text.split('\n').forEach((line, i) => { if (line.includes(input.query!) && result.length < 100) result.push({ path: relative, line: i + 1, preview: line.slice(0, 256) }) })
        }
      }
      if (name === 'deep_list_files') break
    }
    await this.store.database(db => assertDeepAuthority(db, readDeepState(db, state.runId), authority, this.store.now()))
    return { results: result, bounded: true, instruction: 'Read relevant files with deep_read_file to obtain citable artifactIds.' }
  }
  definitions(authority: DeepAuthority) {
    return DEEP_READ_TOOLS.map(name => ({ name, description: name === 'deep_read_file' ? 'Read bounded workspace text and obtain a host-issued evidence artifactId.' : name === 'deep_list_files' ? 'List one workspace directory, excluding symlinks and generated/private directories.' : 'Search workspace text for a literal query; bounded to 2000 entries and 100 matches. Read matches to obtain evidence.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, ...(name === 'deep_read_file' ? { startLine: { type: 'integer' }, lines: { type: 'integer' } } : name === 'deep_search_files' ? { query: { type: 'string' } } : {}) }, required: name === 'deep_search_files' ? ['path', 'query'] : ['path'], additionalProperties: false },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args: unknown, execution: { signal: AbortSignal }) => this.execute(authority, name, args, execution.signal),
    }))
  }
}
