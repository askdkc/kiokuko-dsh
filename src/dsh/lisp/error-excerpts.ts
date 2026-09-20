import { stripVTControlCharacters } from 'node:util'

const MAX_ANCHORS = 3
export const MAX_SCAN_BYTES = 1024 * 1024
export const MAX_MATCH_LINE_BYTES = 8 * 1024
export const MAX_DIAGNOSTIC_BYTES = 4 * 1024
type Stream = 'stdout' | 'stderr'
export interface ExcerptSource {
  text: string
  /** Original UTF-16 ranges, end exclusive. */
  visible: readonly (readonly [number, number])[]
}
export interface DiagnosticExcerpt {
  kind: 'typescript'
  startLine: number
  endLine: number
  text: string
  inspect: {
    tool: 'lisp_inspect'
    resultOperationId: string
    section: 'result'
    pointer: '/value/json/stdout' | '/value/json/stderr'
    offset: number
    limit: 2000
  }
}
interface Line { start: number; end: number; bodyEnd: number; offset: number; number: number; diagnostic: boolean }
interface Anchor { stream: Stream; line: Line; before: Line[]; after: Line[]; first: Line; last: Line }
interface Selection { diagnostics: Partial<Record<Stream, DiagnosticExcerpt[]>>; inspect: DiagnosticExcerpt['inspect'] | undefined; bytes: number }
const streams = ['stdout', 'stderr'] as const
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Recognize only English TypeScript CLI diagnostic headers, never their meaning. */
function isDiagnostic(body: string): boolean {
  if (Buffer.byteLength(body, 'utf8') > MAX_MATCH_LINE_BYTES) return false
  const plain = stripVTControlCharacters(body)
  return /^(?:.+\([1-9][0-9]*,[1-9][0-9]*\): |.+:[1-9][0-9]*:[1-9][0-9]* - |)error TS[0-9]+:/u.test(plain)
}

/** Forward-only scan; retain positions, not a copy or index of the entire log. */
function* lines(text: string): Generator<Line> {
  let start = 0, offset = 0, number = 1
  while (start < text.length) {
    const lf = text.indexOf('\n', start), end = lf < 0 ? text.length : lf + 1
    const bodyEnd = lf < 0 ? end : lf > start && text[lf - 1] === '\r' ? lf - 1 : lf
    yield { start, end, bodyEnd, offset, number, diagnostic: isDiagnostic(text.slice(start, bodyEnd)) }
    // Count code points without allocating Array.from(text).
    for (let i = start; i < end; offset++) i += text.codePointAt(i)! > 0xffff ? 2 : 1
    start = end; number++
  }
}

/** Seven line positions suffice for an anchor's two preceding/four following lines. */
function* candidates(stream: Stream, source: ExcerptSource): Generator<Anchor> {
  if (Buffer.byteLength(source.text, 'utf8') > MAX_SCAN_BYTES) return
  const iterator = lines(source.text), before: Line[] = [], pending: Line[] = []
  let done = false
  while (true) {
    while (!done && pending.length < 5) {
      const next = iterator.next()
      if (next.done) done = true
      else pending.push(next.value)
    }
    const line = pending.shift()
    if (!line) return
    if (line.diagnostic && !source.visible.some(([start, end]) => start <= line.start && end >= line.bodyEnd)) {
      yield { stream, line, before: [...before].reverse(), after: [...pending], first: line, last: line }
    }
    before.push(line)
    if (before.length > 2) before.shift()
  }
}

/** Normalize at most three ranges and measure the complete diagnostic payload. */
function selection(anchors: readonly Anchor[], sources: Partial<Record<Stream, ExcerptSource>>, operationId: string): Selection {
  const diagnostics: Selection['diagnostics'] = {}
  for (const stream of streams) {
    const ranges = anchors.filter(a => a.stream === stream).map(a => ({ first: a.first, last: a.last })).sort((a, b) => a.first.start - b.first.start)
    const merged: typeof ranges = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && range.first.start <= previous.last.end) {
        if (range.last.end > previous.last.end) previous.last = range.last
      } else merged.push(range)
    }
    if (merged.length) diagnostics[stream] = merged.map(({ first, last }) => ({
      kind: 'typescript', startLine: first.number, endLine: last.number,
      text: sources[stream]!.text.slice(first.start, last.end),
      inspect: { tool: 'lisp_inspect', resultOperationId: operationId, section: 'result',
        pointer: `/value/json/${stream}`, offset: first.offset, limit: 2000 },
    }))
  }
  const first = anchors[0]
  const inspect = first && diagnostics[first.stream]!.find(e => e.startLine <= first.line.number && e.endLine >= first.line.number)!.inspect
  const bytes = streams.reduce((sum, stream) => sum + (diagnostics[stream] ? jsonBytes({ diagnostics: diagnostics[stream] }) : 0), 0)
    + (inspect ? jsonBytes({ inspect }) : 0)
  return { diagnostics, inspect, bytes }
}

/** Pure, bounded selection. No result means the caller must retain its baseline. */
export function errorExcerpts(sources: Partial<Record<Stream, ExcerptSource>>, operationId: string, budget: number): Selection {
  const anchors: Anchor[] = [], limit = Math.max(0, Math.min(MAX_DIAGNOSTIC_BYTES, budget))
  let selected = selection(anchors, sources, operationId)
  if (!limit) return selected
  const iterators = streams.map(stream => sources[stream] ? candidates(stream, sources[stream]!) : [][Symbol.iterator]())
  const take = (iterator: Iterator<Anchor>): boolean => {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      const trial = selection([...anchors, next.value], sources, operationId)
      if (trial.bytes <= limit) { anchors.push(next.value); selected = trial; return true }
    }
    return false
  }
  // First offer each stream a slot, then fill remaining slots from their continuations.
  for (const iterator of iterators) take(iterator)
  for (const iterator of iterators) while (anchors.length < MAX_ANCHORS && take(iterator)) { /* bounded by anchor count */ }
  const stopped = anchors.map(() => ({ before: false, after: false }))
  for (let distance = 1; distance <= 4; distance++) {
    for (const [index, anchor] of anchors.entries()) {
      for (const direction of ['before', 'after'] as const) {
        if (stopped[index]![direction] || (direction === 'before' && distance > 2)) continue
        const line = anchor[direction][distance - 1]
        if (!line || (line.diagnostic && !anchors.some(a => a.stream === anchor.stream && a.line.start === line.start))) {
          stopped[index]![direction] = true; continue
        }
        const key = direction === 'before' ? 'first' : 'last', previous = anchor[key]
        anchor[key] = line
        const trial = selection(anchors, sources, operationId)
        if (trial.bytes <= limit) selected = trial
        else { anchor[key] = previous; stopped[index]![direction] = true }
      }
    }
  }
  return selected
}
