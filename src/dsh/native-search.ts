/** Plugin-owned search: a grep replacement this plugin provides and owns.
 *
 * The native DSH grep reports a missing path as a ripgrep failure (grep search failed (exit 2): rg: ... IO error).
 * This tool owns its traversal and its errors: a missing path is a plain actionable message, a bad pattern names the
 * pattern, and every cap is explicit. Registration is scoped to the calling agent, where a scoped tool shadows the
 * same-named global one, so a session keeps exactly one grep and no harness change is needed.
 * @module kiokuko-dsh/native-search
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

/** Tool name; the scoped registration deliberately shadows the native global grep. */
export const NATIVE_SEARCH_TOOL = 'grep'
export const MAX_SEARCH_MATCHES = 200
export const MAX_SEARCH_LINE_LENGTH = 400
export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
export const MAX_SEARCH_FILES = 20_000
export const BINARY_SNIFF_BYTES = 8192
/** Directories never traversed by default; a VCS store is not a content source. */
export const SKIPPED_DIRECTORIES: readonly string[] = ['.git', 'node_modules', '.hg', '.svn', '.venv', '__pycache__', '.cache']

export interface SearchMatch { readonly path: string; readonly line: number; readonly text: string }
export interface SearchOutcome { readonly matches: readonly SearchMatch[]; readonly truncated: boolean; readonly scannedFiles: number }

/** Compile one JavaScript regular expression, naming the pattern on failure. */
export function compilePattern(pattern: string): RegExp {
  try { return new RegExp(pattern, 'u') } catch (error) {
    throw new Error('grep pattern rejected: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/** Translate one glob (star, double-star, question mark, {a,b}) into an anchored path matcher. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]!
    if (character === '*') {
      if (glob[index + 1] === '*') { source += '.*'; index += 1 } else source += '[^/]*'
      continue
    }
    if (character === '?') { source += '[^/]'; continue }
    if (character === '{') { source += '(?:'; continue }
    if (character === '}') { source += ')'; continue }
    if (character === ',') { source += '|'; continue }
    source += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp('^' + source + '$', 'u')
}

/** Match a glob against the search-relative path, or against the basename when the glob has no separator. */
export function includeMatcher(glob: string): (relativePath: string) => boolean {
  const matcher = globToRegExp(glob)
  return glob.includes('/') ? (relativePath: string) => matcher.test(relativePath) : (relativePath: string) => matcher.test(basename(relativePath))
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

function displayPath(root: string, target: string): string {
  const relativePath = relative(root, target)
  return (relativePath === '' ? basename(target) : relativePath).split(sep).join('/')
}

function shorten(line: string): string {
  return line.length > MAX_SEARCH_LINE_LENGTH ? line.slice(0, MAX_SEARCH_LINE_LENGTH) + '... (line truncated)' : line
}

/** Search one file. Returns false when the match cap ended the search early. */
export function searchFile(file: string, pattern: RegExp, display: string, matches: SearchMatch[], cap: number): boolean {
  let bytes: Buffer
  try { bytes = readFileSync(file) } catch { return true }
  if (bytes.length > MAX_SEARCH_FILE_BYTES || isBinary(bytes)) return true
  const lines = bytes.toString('utf8').split(String.fromCharCode(10))
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/u, '')
    if (!pattern.test(line)) continue
    matches.push({ path: display, line: index + 1, text: shorten(line) })
    if (matches.length >= cap) return false
  }
  return true
}

/** Walk one directory tree in a stable order. Returns false when a cap ended the search early. */
export function searchDirectory(root: string, pattern: RegExp, include: ((relativePath: string) => boolean) | undefined, matches: SearchMatch[], cap: number, files: { scanned: number }, aborted?: () => boolean): boolean {
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (aborted?.() === true) return false
    const directory = stack.pop()!
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.includes(entry.name)) stack.push(full); continue }
      if (!entry.isFile()) continue
      const relativePath = displayPath(root, full)
      if (include !== undefined && !include(relativePath)) continue
      if (files.scanned >= MAX_SEARCH_FILES) return false
      files.scanned += 1
      if (!searchFile(full, pattern, relativePath, matches, cap)) return false
    }
  }
  return true
}

/** Model-facing text: one path:line: text row per match, plus an explicit cap notice. */
export function formatSearchOutcome(outcome: SearchOutcome): string {
  if (outcome.matches.length === 0) return outcome.truncated ? 'No matches in the scanned prefix (the scan cap was reached).' : 'No matches'
  const rows = outcome.matches.map(match => match.path + ':' + match.line + ': ' + match.text)
  const header = 'Found ' + outcome.matches.length + ' match' + (outcome.matches.length === 1 ? '' : 'es') + ' in ' + outcome.scannedFiles + ' file' + (outcome.scannedFiles === 1 ? '' : 's')
  return outcome.truncated
    ? header + ' (capped; narrow the pattern or the path to see the rest)' + String.fromCharCode(10) + rows.join(String.fromCharCode(10))
    : header + String.fromCharCode(10) + rows.join(String.fromCharCode(10))
}

export interface SearchInput { readonly pattern?: unknown; readonly path?: unknown; readonly include?: unknown }
export interface SearchExecution { readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }; readonly signal?: AbortSignal }

/** Run one search. Every failure mode is this plugin's own message, never a raw ripgrep exit. */
export function runGrep(args: SearchInput, execution: SearchExecution): SearchOutcome {
  const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
  if (pattern.length === 0) throw new Error('grep requires a non-empty pattern')
  const requested = typeof args?.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : undefined
  const includeRaw = typeof args?.include === 'string' && args.include.trim().length > 0 ? args.include.trim() : undefined
  const root = execution.agent?.session?.header?.cwd
  const workspace = typeof root === 'string' && root.length > 0 ? root : process.cwd()
  const target = resolve(workspace, requested ?? '.')
  const name = JSON.stringify(requested ?? displayPath(workspace, target))
  const regex = compilePattern(pattern)
  const include = includeRaw === undefined ? undefined : includeMatcher(includeRaw)
  let status
  try { status = statSync(target) } catch {
    throw new Error('cannot search ' + name + ': not found - check the path, or omit the path to search the whole workspace')
  }
  const matches: SearchMatch[] = []
  const files = { scanned: 0 }
  const signal = execution.signal
  const aborted = signal === undefined ? undefined : () => signal.aborted
  let truncated = false
  if (status.isDirectory()) truncated = !searchDirectory(target, regex, include, matches, MAX_SEARCH_MATCHES, files, aborted)
  else if (status.isFile()) { files.scanned = 1; truncated = !searchFile(target, regex, displayPath(workspace, target), matches, MAX_SEARCH_MATCHES) }
  else throw new Error('cannot search ' + name + ': not a regular file or directory')
  return { matches, truncated, scannedFiles: files.scanned }
}

/** The scoped tool definition. The tool registry requires output.render. */
export function createGrepDefinition(): Record<string, unknown> {
  return {
    name: NATIVE_SEARCH_TOOL,
    description: 'Search file contents with a JavaScript regular expression. Returns path:line:text rows grouped in file order. '
      + 'A missing path reports cannot search "<path>": not found instead of a search failure; omit the path to search the whole session workspace.',
    modelFacing: true,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (JavaScript syntax).' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace.' },
        include: { type: 'string', description: 'Glob filter such as *.ts or src/**/*.ts.' },
      },
      required: ['pattern'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        matches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } }, required: ['path', 'line', 'text'] } },
        truncated: { type: 'boolean' }, scannedFiles: { type: 'integer' },
      }, required: ['matches', 'truncated', 'scannedFiles'] },
      render: (_args: unknown, value: SearchOutcome) => [{ type: 'text', text: formatSearchOutcome(value) }],
    },
    async execute(args: SearchInput, execution: SearchExecution) { return runGrep(args, execution) },
  }
}

interface SearchMountContext {
  on(name: string, listener: (...args: any[]) => unknown, options?: { global?: boolean }): () => void
}

/** Register the scoped grep for every agent session, shadowing the native global tool. */
export function mountNativeSearch(context: SearchMountContext): () => void {
  const registrations = new Map<object, () => void>()
  const release = (agent: unknown): void => {
    if (typeof agent !== 'object' || agent === null) return
    const dispose = registrations.get(agent)
    if (dispose === undefined) return
    registrations.delete(agent)
    dispose()
  }
  const started = context.on('agent/session-start', (payload: { agent?: any }) => {
    const agent = payload?.agent
    const tools = agent?.ctx?.get?.('tools', false)
    if (typeof agent !== 'object' || agent === null || typeof tools?.register !== 'function' || registrations.has(agent)) return
    try { registrations.set(agent, tools.register(createGrepDefinition())) } catch { /* keep the native surface when a scope refuses the registration */ }
  }, { global: true })
  const disposed = context.on('agent/disposed', (payload: { agent?: unknown }) => { release(payload?.agent) }, { global: true })
  return () => { started(); disposed(); for (const dispose of registrations.values()) dispose(); registrations.clear() }
}
