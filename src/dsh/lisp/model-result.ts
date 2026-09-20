import { identifier } from './contracts.js'
import { errorExcerpts, MAX_DIAGNOSTIC_BYTES, type ExcerptSource } from './error-excerpts.js'

/** Model presentation only. The operation journal retains the complete result. */
export const RESULT_BYTES = 16 * 1024
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const levels = [[4000, 25], [1000, 10], [200, 3], [0, 0]] as const
const streams = ['stdout', 'stderr'] as const

/** Add evidence only after fixing the baseline's outcomes and the preview budget. */
function withDiagnostics(source: RecordValue, rest: RecordValue, core: RecordValue, baseline: RecordValue, baselineJson: string): string {
  const value = source.value, result = record(value) ? value.json : undefined
  if (!record(result) || !Object.hasOwn(result, 'code') || !Number.isSafeInteger(result.code) || result.code === 0
    || !streams.every(key => Object.hasOwn(result, key) && typeof result[key] === 'string')
    || ('state' in result && result.state !== 'FAILED') || !identifier.safeParse(source.operationId).success) return baselineJson
  const baselineValue = record(baseline.value) ? baseline.value : {}, baselineResult = record(baselineValue.json) ? baselineValue.json : {}
  if (streams.every(key => baselineResult[key] === result[key])) return baselineJson
  const protectedResult: RecordValue = { code: result.code }
  if ('state' in result) protectedResult.state = result.state
  for (const key of ['target', 'script']) {
    if (typeof result[key] === 'string' && Array.from(result[key]).length <= 200) protectedResult[key] = result[key]
  }
  const protectedPages: RecordValue = {}
  for (const key of ['changes', 'operations', 'nextOffset']) if (Object.hasOwn(baseline, key)) protectedPages[key] = baseline[key]
  const candidates = levels.map(([characters, items]) => {
    const omitted: string[] = []
    const data = boundedData(rest, characters, items, omitted, '') as RecordValue
    const renderedValue = record(data.value) ? data.value : {}, renderedResult = record(renderedValue.json) ? renderedValue.json : {}
    const logs: RecordValue = {}, sources: Partial<Record<typeof streams[number], ExcerptSource>> = {}
    for (const key of streams) {
      const text = result[key] as string
      if (baselineResult[key] === text) logs[key] = text
      else {
        const log = boundedData(text, characters, items, omitted, `/value/json/${key}`) as string | RecordValue
        logs[key] = log
        if (record(log)) sources[key] = { text, visible: [[0, (log.preview as string).length], [text.length - (log.tail as string).length, text.length]] }
      }
    }
    // These paths refer to the stored source, even if generic item limits hid its parents.
    const logPointers = streams.filter(key => sources[key]).map(key => `/value/json/${key}`)
    const pagePointers = Array.isArray(baseline.omitted) ? baseline.omitted.filter(p => p === '/changes' || p === '/operations') : []
    const candidate = { ...core, ...data, ...protectedPages,
      value: { ...renderedValue, json: { ...renderedResult, ...protectedResult, ...logs } },
      truncated: true, omitted: [...new Set([...logPointers, ...pagePointers, ...omitted])].slice(0, 30) }
    return { candidate, sources, bytes: Buffer.byteLength(JSON.stringify(candidate)) }
  })
  const budget = Math.max(0, Math.min(MAX_DIAGNOSTIC_BYTES, RESULT_BYTES - Math.min(...candidates.map(c => c.bytes))))
  if (!budget) return baselineJson
  const chosen = candidates.find(c => c.bytes + budget <= RESULT_BYTES)
  if (!chosen) return baselineJson
  const excerpts = errorExcerpts(chosen.sources, source.operationId as string, budget)
  if (!excerpts.inspect) return baselineJson
  const json = chosen.candidate.value.json
  for (const key of streams) if (excerpts.diagnostics[key]) json[key] = { ...json[key] as RecordValue, diagnostics: excerpts.diagnostics[key] }
  const rendered = JSON.stringify({ ...chosen.candidate, inspect: excerpts.inspect })
  return Buffer.byteLength(rendered) <= RESULT_BYTES ? rendered : baselineJson
}

function inspectionPointer(omitted: readonly string[]): string {
  let pointer = omitted.find(p => p.endsWith('/stderr')) ?? omitted.find(p => p.endsWith('/stdout')) ?? omitted[0] ?? ''
  // A long user-defined key may exceed the input contract: select its parent,
  // never manufacture a pointer which the advertised tool would reject.
  while (pointer.length > 1024) pointer = pointer.slice(0, pointer.lastIndexOf('/'))
  return pointer
}

function boundedData(value: unknown, characters: number, items: number, omitted: string[], path: string): unknown {
  if (typeof value === 'string') {
    const chars = Array.from(value)
    if (chars.length <= characters) return value
    omitted.push(path)
    const head = Math.ceil(characters / 2), tail = Math.floor(characters / 2)
    return { preview: chars.slice(0, head).join(''), tail: tail ? chars.slice(-tail).join('') : '', characters: chars.length }
  }
  if (Array.isArray(value)) {
    if (value.length > items) omitted.push(path)
    return value.slice(0, items).map((item, i) => boundedData(item, characters, items, omitted, `${path}/${i}`))
  }
  if (record(value)) {
    const entries = Object.entries(value)
    if (entries.length > items) omitted.push(path)
    return Object.fromEntries(entries.slice(0, items).map(([key, item]) => [key, boundedData(item, characters, items, omitted, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)]))
  }
  return value
}

/** Preserve outcome metadata even when source, verifier output or values are large. */
export function renderResult(value: unknown): string {
  if (!record(value)) return JSON.stringify(boundedData(value, 2000, 10, [], 'value'))
  const source = record(value.result) && value.replay === true ? { ...value.result, ...value, result: undefined } : value
  const core: RecordValue = {}
  for (const key of ['ok', 'operationId', 'generation', 'state', 'code', 'message', 'reason', 'recovery', 'replay',
    'resultOperationId', 'section', 'pointer', 'offset', 'nextOffset', 'totalCharacters', 'operationCount', 'pendingCount', 'pendingStates']) {
    if (source[key] !== undefined) core[key] = source[key]
  }
  const rest = { ...source }
  for (const key of Object.keys(core)) delete rest[key]
  if (value.replay === true) delete rest.result
  if (Array.isArray(rest.proposals)) { core.proposalCount = rest.proposals.length; delete rest.proposals }
  const changes = Array.isArray(rest.changes) ? rest.changes : undefined
  delete rest.changes
  const operations = Array.isArray(rest.operations) && typeof core.offset === 'number' ? rest.operations : undefined
  if (operations) delete rest.operations
  if (changes) {
    const states: Record<string, number> = {}
    for (const change of changes) if (record(change) && typeof change.state === 'string') states[change.state] = (states[change.state] ?? 0) + 1
    core.changeSummary = { total: changes.length, states }
  }
  if (record(rest.value) && rest.value.json !== undefined && rest.value.json !== null) {
    const { printed: _printed, ...unique } = rest.value
    rest.value = unique
  }
  for (const [characters, items] of levels) {
    const omitted: string[] = []
    const data = boundedData(rest, characters, items, omitted, '') as RecordValue
    // Never truncate an individual outcome or its error reason: paginate whole items.
    const page = changes?.slice(0, items)
    const operationPage = operations?.slice(0, items)
    if (changes && page!.length < changes.length) omitted.push('/changes')
    if (operations && operationPage!.length < operations.length) omitted.push('/operations')
    const result = { ...core, ...data, ...(page ? { changes: page } : {}), ...(operationPage ? {
      operations: operationPage, nextOffset: operationPage.length < operations!.length ? Number(core.offset) + operationPage.length : core.nextOffset,
    } : {}), ...(omitted.length ? {
      truncated: true, omitted: [...new Set(omitted)].slice(0, 30),
      ...(typeof core.operationId === 'string' ? { inspect: { tool: 'lisp_inspect', resultOperationId: core.operationId,
        section: 'result', pointer: inspectionPointer(omitted), offset: 0, limit: 2000 } }
        : { detail: 'Use the returned pagination fields or the human diagnostics command; do not repeat execution.' }),
    } : {}) }
    const json = JSON.stringify(result)
    if (Buffer.byteLength(json) <= RESULT_BYTES) return withDiagnostics(source, rest, core, result, json)
  }
  // Exceptionally large control metadata is preferable to hiding a failure or identity.
  return JSON.stringify({ ...core, truncated: true, inspect: { tool: 'lisp_inspect', resultOperationId: core.operationId ?? null, section: 'result', offset: 0, limit: 2000 } })
}
