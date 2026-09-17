/** Model presentation only. The operation journal retains the complete result. */
export const RESULT_BYTES = 16 * 1024
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

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
  for (const [characters, items] of [[4000, 25], [1000, 10], [200, 3], [0, 0]] as const) {
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
    if (Buffer.byteLength(json) <= RESULT_BYTES) return json
  }
  // Exceptionally large control metadata is preferable to hiding a failure or identity.
  return JSON.stringify({ ...core, truncated: true, inspect: { tool: 'lisp_inspect', resultOperationId: core.operationId ?? null, section: 'result', offset: 0, limit: 2000 } })
}
