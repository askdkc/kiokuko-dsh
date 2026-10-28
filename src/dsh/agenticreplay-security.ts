import { loadAgenticReplayLibrary, type SchemaLibrary } from './agenticreplay-libraries.js'
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, opendir } from 'node:fs/promises'
import path from 'node:path'
import { AgenticReplayError } from './agenticreplay-types.js'

export const AGENTICREPLAY_RUN_ID = /^run_[0-9a-f]{6,32}$/u
export const workspaceKey = (root: string): string => createHash('sha256').update(root).digest('hex')
function isCredentialName(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/gu, '$1_$2').replace(/[- \t]+/gu, '_').toLowerCase()
    .replace(/(^|_)apikey$/u, '$1api_key').replace(/(^|_)accesstoken$/u, '$1access_token')
  return /(?:^|_)(?:api_key|access_key_id|secret_access_key|password|access_token|token|secret|authorization|cookie|set_cookie)$/u.test(normalized)
}
/** Return the closing quote or line boundary; escaped delimiters are part of the value. */
function quotedValueEnd(text: string, start: number, escaped = false): number {
  if (escaped) {
    let end = start + 2
    while (end < text.length && !/[\r\n]/u.test(text[end]!)) {
      if (text[end] === '\\') {
        const run = end
        while (text[end] === '\\') end++
        // One JSON escape layer: a delimiter has 4k+1 slashes, an inner escaped quote 4k+3.
        if (text[end] === '"' && (end - run) % 4 === 1) return end - 1
      }
      end++
    }
    return end
  }
  const quote = text[start]
  let end = start + 1
  while (end < text.length && text[end] !== '\r' && text[end] !== '\n') {
    if (text[end] === quote) break
    if (text[end] === '\\' && end + 1 < text.length && !/[\r\n]/u.test(text[end + 1]!)) end++
    end++
  }
  return end
}
function scrubCredentialUrl(url: string): string {
  const authorityStart = url.indexOf('://') + 3
  const authorityEnd = url.slice(authorityStart).search(/[/?#]/u)
  const end = authorityEnd < 0 ? url.length : authorityStart + authorityEnd
  const authority = url.slice(authorityStart, end), at = authority.lastIndexOf('@'), colon = authority.indexOf(':')
  if (at >= 0 && colon >= 0 && colon < at) url = url.slice(0, authorityStart + colon + 1) + '[REDACTED]' + url.slice(authorityStart + at)
  const query = url.indexOf('?'), fragment = url.indexOf('#')
  if (query < 0 || fragment >= 0 && fragment < query) return url
  const queryEnd = fragment < 0 ? url.length : fragment
  return url.slice(0, query) + url.slice(query, queryEnd).replace(/([?&](?:api_key|api-key|apikey|access_token|access-token|accesstoken|token|password|secret)=)[^&#]*/giu, '$1[REDACTED]') + url.slice(queryEnd)
}
/** One pass owns URL spans and assignment boundaries; the caller's text is never mutated. */
export function scrubAgenticReplayText(text: string): string {
  text = text.replace(/^([ \t]*(?:authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]*/gimu, '$1[REDACTED]')
  const tokens = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+|(?<![A-Za-z0-9_])(?:\\"([^"\\\r\n]*)\\"|"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z_][A-Za-z0-9_-]*(?:[ \t]+(?:key|token))?))[ \t]*[:=][ \t]*/giu
  const parts: string[] = []
  let copied = 0
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (name === undefined) {
      // A JSON-escaped closing quote belongs to the surrounding text, not the URL value.
      if (text[tokens.lastIndex] === '"' && text[tokens.lastIndex - 1] === '\\') tokens.lastIndex--
      parts.push(text.slice(copied, match.index), scrubCredentialUrl(text.slice(match.index, tokens.lastIndex))); copied = tokens.lastIndex
      continue
    }
    // An ordinary name owns no span: URLs inside quoted names still need their own rule.
    if (!isCredentialName(name)) { tokens.lastIndex = match.index + 1; continue }
    const start = tokens.lastIndex, escaped = text.startsWith('\\"', start), quote = escaped ? '\\"' : text[start], quoted = escaped || quote === '"' || quote === "'"
    let end = start
    if (quoted) end = quotedValueEnd(text, start, escaped)
    else if (/authorization$/iu.test(name)) {
      while (end < text.length && !/[\r\n]/u.test(text[end]!)) end++
    } else while (end < text.length && !/[\s,;}&#]/u.test(text[end]!)) end++
    parts.push(text.slice(copied, start), quoted ? quote + '[REDACTED]' : '[REDACTED]')
    copied = end; tokens.lastIndex = quoted && quote !== undefined && text.startsWith(quote,end) ? end + quote.length : end
  }
  parts.push(text.slice(copied))
  return parts.join('').replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gu, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED]')
}
/** Budget is charged before copying or escaping. Runtime objects/accessors are rejected. */
export function projectAgenticReplayJson(value: unknown, maxBytes: number): unknown {
  let remaining = maxBytes
  const seen = new Set<object>()
  function charge(n: number) { remaining -= n; if (remaining < 0) throw new AgenticReplayError('queue_limit') }
  // Bound working UTF-16 storage before scanning/redacting, then account for the
  // actual JSON UTF-8 representation without allocating an escaped copy. A
  // blanket length * 6 wrongly discarded ordinary sub-budget request bodies.
  function textCost(text: string): number {
    const storage = text.length * 2
    if (storage > remaining) throw new AgenticReplayError('queue_limit')
    let encoded = 2 // JSON quotes
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) encoded += 2
      else if (code < 32) encoded += 6
      else if (code < 128) encoded++
      else if (code < 2048) encoded += 2
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { encoded += 4; index++ }
      else encoded += code >= 0xd800 && code <= 0xdfff ? 6 : 3
      if (encoded > remaining) throw new AgenticReplayError('queue_limit')
    }
    return Math.max(storage, encoded)
  }
  function projectText(text: string): string {
    const inputCost = textCost(text) // reject over-budget input before copying
    const output = scrubAgenticReplayText(text)
    charge(Math.max(inputCost, textCost(output))) // short secrets may expand
    return output
  }
  function visit(item: unknown, depth: number): unknown {
    charge(16)
    if (depth > 32) throw new AgenticReplayError('projection_depth')
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : null
    if (typeof item === 'string') return projectText(item)
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
        charge(16)
        const safeKey = projectText(key)
        if (/authorization|cookie|credential|api.?key|password|secret|token|replayState|signal|context/iu.test(key) || isCredentialName(key)) continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !('value' in descriptor)) continue
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
const gitignoreWrites = new Map<string, Promise<void>>()
/** Append protection without replacing user content. Serialize sessions sharing a store. */
export async function ensureAgenticReplayGitignore(root: string): Promise<void> {
  const previous = gitignoreWrites.get(root) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(async () => {
    const target = path.join(root, '.gitignore')
    try {
      // Do not follow links or block opening a FIFO supplied as .gitignore.
      const handle = await open(target, constants.O_RDONLY | constants.O_CREAT
        | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK, 0o644)
      try {
        const stat = await handle.stat()
        const limit = 1_048_576
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit
          || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error('unsafe gitignore')
        const buffer = Buffer.alloc(stat.size + 1)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead !== stat.size) throw new Error('gitignore changed')
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const lines = text.split(/\r?\n/u)
        let rule = -1
        for (let index = 0; index < lines.length; index++) {
          if (/^(?:\/)?\.agenticreplay\/?\s*$/u.test(lines[index]!)) rule = index
        }
        // A later negation can override an earlier rule. Append after it.
        const current = await lstat(target)
        if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev
          || (await handle.stat()).size !== stat.size) throw new Error('gitignore changed')
        if (rule >= 0 && !lines.slice(rule + 1).some(line => line.startsWith('!'))) return
        const newline = text.includes('\r\n') ? '\r\n' : '\n'
        const writer = await open(target, constants.O_WRONLY | constants.O_APPEND
          | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK)
        try {
          const opened = await writer.stat()
          if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size
            || opened.nlink !== 1) throw new Error('gitignore changed')
          await writer.writeFile(`${text && !text.endsWith('\n') ? newline : ''}.agenticreplay/${newline}`)
          await writer.sync()
        } finally { await writer.close() }
      } finally { await handle.close() }
    } catch { throw new AgenticReplayError('gitignore_protection_failed') }
  })
  gitignoreWrites.set(root, pending)
  try { await pending } finally { if (gitignoreWrites.get(root) === pending) gitignoreWrites.delete(root) }
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
  await ensureAgenticReplayGitignore(root)
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
/** The stable run ID is separate from the writer's mutable directory basename. */
export function agenticReplayRunIdFromDirectory(name: string): string | undefined {
  if (AGENTICREPLAY_RUN_ID.test(name)) return name
  if (name.length > 255) return undefined
  const suffix = /^\d{14}-[a-z0-9-]+-([0-9a-f]{6,32})$/u.exec(name)?.[1]
  return suffix === undefined ? undefined : `run_${suffix}`
}
export async function checkedRunDir(root: string, runId: string): Promise<string> {
  if (!AGENTICREPLAY_RUN_ID.test(runId) || !path.isAbsolute(root) || await realpath(root) !== root) throw new AgenticReplayError('trace_not_found')
  const runs=path.join(root,'.agenticreplay','runs')
  for(const parent of [path.join(root,'.agenticreplay'),runs])await checkPrivatePath(parent,true)
  const core=await loadAgenticReplayLibrary('core')
  const identify=core.runIdFromDirectory ?? agenticReplayRunIdFromDirectory
  const schema: SchemaLibrary=await loadAgenticReplayLibrary('schema')
  const directory=await opendir(runs), valid:string[]=[]
  let entries=0
  try {
    for(let entry=await directory.read();entry!==null;entry=await directory.read()) {
      if(++entries>4096)throw new AgenticReplayError('discovery_limit')
      if(identify(entry.name)!==runId)continue
      const candidate=path.join(runs,entry.name)
      await checkPrivatePath(candidate,true)
      let bytes:Buffer
      try {bytes=await readPrivateFile(path.join(candidate,'manifest.json'),65_536)}
      catch(error){
        // The exact legacy name is an exclusive ID reservation. Ignore only a completely empty claim.
        if(entry.name!==runId||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error
        const claim=await opendir(candidate)
        try{if(await claim.read()!==null)throw new AgenticReplayError('trace_integrity_mismatch')}finally{await claim.close()}
        continue
      }
      const manifest:unknown=JSON.parse(bytes.toString('utf8'))
      schema.assertManifest(manifest)
      if(manifest.run_id!==runId)throw new AgenticReplayError('manifest_mismatch')
      valid.push(candidate)
      if(valid.length>1)throw new AgenticReplayError('trace_ambiguous')
    }
  } finally {await directory.close()}
  if(valid.length!==1)throw new AgenticReplayError('trace_not_found')
  await checkPrivatePath(runs,true);await checkPrivatePath(valid[0]!,true)
  return valid[0]!
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
