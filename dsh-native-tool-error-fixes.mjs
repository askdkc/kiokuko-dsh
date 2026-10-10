#!/usr/bin/env node
// One-shot fixer for two DSH native-tool error reports:
//   1) read: an offset past EOF failed hard instead of returning an empty window
//   2) grep/glob: an unreachable search path surfaced as a bare "search failed (exit 2)"
// Disposable: delete this file after applying. Run with --check first for a no-write dry run.
// Usage: node dsh-native-tool-error-fixes.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.env.DSH_ROOT ?? '/Users/dkc/Sites/Src/deepseek-harness'
const dryRun = process.argv.includes('--check')

const EDITS = [
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: "import { FsError } from '@deepseek-ai/dsh-fs'\n\n",
    to: '',
  },
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: "function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {\n  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {\n    throw new FsError(`offset ${request.offset} is out of range for \"${displayPath}\" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')\n  }\n  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }\n}",
    to: "function finish(acc: WindowAccumulator): WindowResult {\n  // A window that starts past EOF is empty, not a failure: an offset derived from an earlier\n  // revision can race a shrinking file, and the caller recovers from the exact total plus the\n  // footer hint instead of losing the read.\n  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }\n}",
  },
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: '  return finish(acc, request, displayPath)',
    to: '  return finish(acc)',
  },
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: ' * scanning to an exact total line count, and throwing `FS_NOT_FOUND` when the requested offset is\n * past EOF.',
    to: ' * scanning to an exact total line count, and returning an empty window with that total when the\n * requested offset is past EOF.',
  },
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: ' * @param displayPath - the caller-facing path used in the offset-out-of-range error.',
    to: ' * @param _displayPath - retained for call-site compatibility; a past-EOF window no longer needs it.',
  },
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: '  request: ReadWindow,\n  displayPath: string,\n): Promise<WindowResult> {',
    to: '  request: ReadWindow,\n  _displayPath: string,\n): Promise<WindowResult> {',
  },
  {
    file: 'packages/fs/tool-fs/src/read-render.ts',
    from: '  if (outcome.truncatedByBytes) {\n    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`\n  } else if (endLine < outcome.totalLines) {',
    to: '  if (outcome.truncatedByBytes) {\n    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`\n  } else if (outcome.totalLines > 0 && outcome.offset > outcome.totalLines) {\n    footer = `(End of file - total ${outcome.totalLines} lines. Requested offset ${outcome.offset} is past the last line; use an offset <= ${outcome.totalLines}.)`\n  } else if (endLine < outcome.totalLines) {',
  },
  {
    file: 'packages/fs/tool-fs/tests/read-render.spec.ts',
    from: ' * caps, per-line truncation, CRLF stripping, offset-past-EOF rejection, and the',
    to: ' * caps, per-line truncation, CRLF stripping, offset-past-EOF empty windows, and the',
  },
  {
    file: 'packages/fs/tool-fs/tests/read-render.spec.ts',
    from: "import { buildWindow, langFromPath, readMetaFromMeta, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '../src/read-render.ts'",
    to: "import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '../src/read-render.ts'",
  },
  {
    file: 'packages/fs/tool-fs/tests/read-render.spec.ts',
    from: "  it('rejects an offset past EOF', async () => {\n    await expect(buildWindow(whole('one\\ntwo'), { offset: 9, limit: 1, ...DEFAULT_CAPS }, 'f')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })\n  })",
    to: "  it('returns an empty window with the exact total when the offset is past EOF', async () => {\n    const result = await buildWindow(whole('one\\ntwo'), { offset: 9, limit: 1, ...DEFAULT_CAPS }, 'f')\n    expect(result.lines).toEqual([])\n    expect(result.totalLines).toBe(2)\n    expect(result.truncatedByBytes).toBe(false)\n  })\n\n  it('names the recoverable offset in the past-EOF footer', async () => {\n    const result = await buildWindow(whole('one\\ntwo'), { offset: 9, limit: 1, ...DEFAULT_CAPS }, 'f')\n    expect(formatReadOutput('f', { offset: 9, lines: result.lines, totalLines: result.totalLines }))\n      .toContain('(End of file - total 2 lines. Requested offset 9 is past the last line; use an offset <= 2.)')\n  })",
  },
  {
    file: 'packages/fs/tool-fs-search/src/search-core.ts',
    from: "  if (/regex parse error|error parsing glob/i.test(stderr)) {\n    return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}`, 'SEARCH_INVALID_PATTERN')\n  }\n  return new SearchError(`${toolName} search failed (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ''}`, 'SEARCH_FAILED')",
    to: "  if (/regex parse error|error parsing glob/i.test(stderr)) {\n    return new SearchError(`${toolName} pattern rejected by ripgrep: ${stderr}`, 'SEARCH_INVALID_PATTERN')\n  }\n  // An unreachable operand is a caller argument problem, not a search fault. ripgrep names the\n  // path it could not read, so keep the stable code and add the recovery the caller needs.\n  if (/IO error for operation on/.test(stderr)) {\n    return new SearchError(\n      `${toolName} could not read a requested search path: ${stderr}. `\n      + 'Check that the path exists, or omit `path` to search the session workspace.',\n      'SEARCH_FAILED',\n    )\n  }\n  return new SearchError(`${toolName} search failed (exit ${exitCode})${stderr.length > 0 ? `: ${stderr}` : ''}`, 'SEARCH_FAILED')",
  },
]

let failed = false
const contents = new Map()
for (const edit of EDITS) {
  const path = join(root, edit.file)
  let current
  try {
    current = contents.get(path) ?? readFileSync(path, 'utf8')
  } catch (error) {
    failed = true
    console.error(`UNREADABLE ${edit.file}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const first = current.indexOf(edit.from)
  const second = first === -1 ? -1 : current.indexOf(edit.from, first + 1)
  if (first === -1 || second !== -1) {
    failed = true
    console.error(`MISMATCH ${edit.file}: expected exactly one match, found ${first === -1 ? 0 : 2}+ for \"${edit.from.slice(0, 60)}...\"`)
    continue
  }
  contents.set(path, current.slice(0, first) + edit.to + current.slice(first + edit.from.length))
}
if (failed) {
  console.error('Nothing was written. Re-check the target files; the harness may already be patched.')
  process.exit(1)
}
if (dryRun) {
  console.log(`OK: ${EDITS.length} replacements match exactly in ${contents.size} files (--check: nothing written).`)
  process.exit(0)
}
for (const [path, text] of contents) {
  writeFileSync(path, text)
  console.log(`patched ${relative(root, path)}`)
}
console.log('Next: pnpm exec vitest run packages/fs/tool-fs/tests/read-render.spec.ts packages/fs/tool-fs-search/tests/integration.spec.ts')
console.log('Then: pnpm exec tsc -b packages/fs/tool-fs packages/fs/tool-fs-search')
console.log('Live GUI: pnpm run build:lib:host, then reload the harness.')
