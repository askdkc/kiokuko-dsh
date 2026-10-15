import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readAgenticReplayManifest, readAgenticReplayPage, resolveAgenticReplayEventsFile } from './agenticreplay-files.js'
import { checkPrivatePath, readPrivateFile, scrubAgenticReplayText, projectAgenticReplayJson } from './agenticreplay-security.js'
import type { TraceEvent } from './agenticreplay-libraries.js'
import { AgenticReplayError } from './agenticreplay-types.js'
import type { ReplayMemoryProposal } from '../memory/replay-review.js'

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const clean = (v: unknown, max = 2048) => { if (typeof v !== 'string') return ''; const text = scrubAgenticReplayText(v).replace(/[\p{Cf}]/gu, ''); return text.length > max ? text.slice(0, max) + ' [excerpt truncated]' : text }
const texts = (v: unknown) => Array.isArray(v) ? v.filter(b => object(b).type === 'text').map(b => clean(object(b).text, 8192)).join('\n') : ''
interface Observed { event: TraceEvent; payload: Record<string, unknown>; payloadHash: string; ref: string }
export interface ReplayEvidenceLimits { maxEvents?: number; maxBytes?: number; maxMilliseconds?: number; maxAttempts?: number }
export interface ReplayEvidenceIdentity { directory: string; runId: string; workspace: string; taskId: string; sessionId: string; nativeCalls?: readonly {callId:string;sessionSeq:number}[]; request?: { text: string; evidenceRefs: string[] } }

/** Read bounded pages and content-addressed public payloads. No model call, durable draft or write. */
export async function extractDshReplayMemory(input: ReplayEvidenceIdentity, limits: ReplayEvidenceLimits = {}): Promise<ReplayMemoryProposal> {
  const maxEvents = Math.min(10000, Math.max(1, limits.maxEvents ?? 10000))
  const maxBytes = Math.min(32 * 1024 * 1024, Math.max(1024, limits.maxBytes ?? 8 * 1024 * 1024))
  const deadline = performance.now() + Math.min(30000, Math.max(1, limits.maxMilliseconds ?? 5000))
  const manifest = await readAgenticReplayManifest(input.directory, input.runId)
  const eventFile = await resolveAgenticReplayEventsFile(input.directory)
  const before = await checkPrivatePath(eventFile, false)
  const observed: Observed[] = [], gaps: string[] = []
  const validated = new Map<string, number>(), materialized = new Map<string, Record<string, unknown>>()
  let offset = 0, seq = -1, bytes = 0, done = false
  const digest = createHash('sha256')
  if (!manifest.ended_at || !manifest.integrity || !manifest.counts) gaps.push('trace is unsealed; capture completeness is unknown')
  while (!done && seq + 1 < maxEvents && bytes < maxBytes && performance.now() < deadline) {
    let page: Awaited<ReturnType<typeof readAgenticReplayPage>>
    try { page = await readAgenticReplayPage(input.directory, offset, seq, Math.min(100, maxEvents - (seq + 1)), maxBytes - bytes, validated) }
    catch (error) {
      if (error instanceof AgenticReplayError && ['timeline_line_limit', 'timeline_blob_limit'].includes(error.code)) { gaps.push('memory input byte budget reached'); break }
      throw error
    }
    if (!page.events.length && !page.done) throw new AgenticReplayError('trace_read_no_progress')
    bytes += page.readBytes; digest.update(page.raw); offset = page.offset; seq = page.previousSeq; done = page.done
    for (const event of page.events) {
      // All records are hashed, but private reasoning/model output never enters the proposal.
      if (!['model.request', 'tool.call', 'tool.result', 'note'].includes(event.type)) continue
      let payload = object(event.payload), payloadHash = hash(JSON.stringify(payload))
      if (typeof payload.$blob === 'string') {
        const ref = payload.$blob, hex = ref.slice(7), size = validated.get(ref)
        if (!/^sha256:[0-9a-f]{64}$/u.test(ref) || size === undefined) throw new AgenticReplayError('unsafe_blob')
        payloadHash = hex
        const cached = materialized.get(ref)
        if (cached) payload = cached
        else {
          await checkPrivatePath(join(input.directory, 'blobs'), true)
          await checkPrivatePath(join(input.directory, 'blobs', hex.slice(0, 2)), true)
          const data = await readPrivateFile(join(input.directory, 'blobs', hex.slice(0, 2), hex), size)
          if (data.length !== size || hash(data) !== hex) throw new AgenticReplayError('blob_mismatch')
          payload = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)))
          materialized.set(ref, payload)
        }
      }
      observed.push({ event, payload, payloadHash, ref: `agenticreplay:${input.runId}:${event.seq}` })
    }
    // Page count, not selected public records, owns the limit.
    if (seq + 1 >= maxEvents && !done) break
  }
  const eventsRead = seq + 1
  if (!done) gaps.push('only an observed prefix was read; digest covers that prefix')
  if (await resolveAgenticReplayEventsFile(input.directory) !== eventFile) throw new AgenticReplayError('file_changed')
  const after = await checkPrivatePath(eventFile, false)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) gaps.push('trace changed while being read')
  const eventsSha256 = digest.digest('hex')
  if (done && manifest.integrity?.events_sha256 && manifest.integrity.events_sha256 !== eventsSha256) throw new AgenticReplayError('trace_integrity_mismatch')
  if (done && manifest.counts && manifest.counts.events !== eventsRead) throw new AgenticReplayError('trace_integrity_mismatch')
  const incomplete = !done || gaps.length > 0
  const totalEvents = manifest.counts?.events ?? (done && before.size === after.size ? eventsRead : null)
  const proposal = projectReplayObservations(observed, input, Math.min(256, limits.maxAttempts ?? 128))
  proposal.source.traces = [{ runId: input.runId, eventsSha256, eventsRead, totalEvents, digestScope: done ? 'complete' : 'observed_prefix', complete: !incomplete, gaps }]
  return proposal
}

/** Pure projection: pairing is exact identity/causality; transport success is not task verification. */
export function projectReplayObservations(events: readonly Observed[], input: Omit<ReplayEvidenceIdentity, 'directory'>, maxAttempts = 128): ReplayMemoryProposal {
  const requests = new Map<string, string>(), gaps: string[] = ['observational trace only: no exact replay, filesystem snapshot or independent causal verification']
  if (!input.request) for (const row of events) {
    if (row.event.type !== 'model.request' || !Array.isArray(row.payload.messages)) continue
    for (const message of row.payload.messages) {
      const value = object(message)
      if (value.role !== 'user') continue
      const text = clean(typeof value.content === 'string' ? value.content : texts(value.content), 4096)
      if (text && requests.size < 16) requests.set(text, row.ref)
    }
  }
  const attempts: ReplayMemoryProposal['attempts'] = []
  const allCalls = events.filter(row => row.event.type === 'tool.call')
  const calls = allCalls.filter(row => (input.nativeCalls ? input.nativeCalls.some(call=>call.callId===row.event.attrs?.callId&&call.sessionSeq===row.event.attrs?.nativeCallSeq) : row.event.attrs?.taskId === undefined || row.event.attrs.taskId === input.taskId))
  for (const call of calls.slice(0, maxAttempts)) {
    const attrs = call.event.attrs ?? {}, attemptId = typeof attrs.attemptId === 'string' ? attrs.attemptId : undefined
    const limitations: string[] = ['tool outcome alone does not establish task success or causal effectiveness']
    const taskId = input.nativeCalls || attrs.taskId === input.taskId ? input.taskId : null
    if (taskId === null) limitations.push('unassigned: this session trace does not bind the call to the current task')
    const results = events.filter(row => row.event.type === 'tool.result' && (attemptId !== undefined
      ? row.event.attrs?.attemptId === attemptId && (row.event.causes?.length ? row.event.causes.includes(call.event.seq) : allCalls.filter(other => other.event.attrs?.attemptId === attemptId).length === 1)
      : row.event.causes?.includes(call.event.seq)))
    const result = results.length === 1 ? results[0] : undefined
    if (!result) limitations.push(results.length ? 'ambiguous matching results' : 'result missing')
    let args = call.payload
    if (args.format === 'dsh.tool.arguments.v1' && args.encoding === 'json-text' && typeof args.text === 'string') {
      try { args = object(JSON.parse(args.text)) } catch { limitations.push('arguments are invalid JSON') }
    }
    const command = clean(args.command ?? args.cmd ?? args.code, 4096)
    let arguments_: unknown
    try { arguments_ = projectAgenticReplayJson(args, 16384) } catch { limitations.push('argument payload exceeds memory preview bound') }
    const output = result ? texts(result.payload.content) : ''
    const native = object(result?.event.attrs?.process_result)
    const exit = Number.isSafeInteger(native.exitCode) ? Number(native.exitCode) : undefined
    const signal = clean(native.signal, 80)
    const decision = events.find(row => row.event.type === 'note' && (attemptId !== undefined ? row.event.attrs?.attemptId === attemptId && (allCalls.filter(other => other.event.attrs?.attemptId === attemptId).length === 1 || row.event.causes?.includes(call.event.seq)) : row.event.causes?.includes(call.event.seq)) && ['deny', 'denied', 'reject', 'blocked'].includes(String(row.event.attrs?.decision)))
    const cancelled = native.aborted === true || native.cancelled === true || !!signal
    const failed = result?.event.attrs?.is_error === true || native.timedOut === true || (exit !== undefined && exit !== 0)
    const outcome = decision ? 'unknown' : cancelled ? 'cancelled' : failed ? 'failed' : exit === 0 ? 'succeeded' : 'unknown'
    const execution = decision ? 'denied' : exit !== undefined ? 'completed' : 'unknown'
    if (decision) limitations.push('native decision denied dispatch; no execution is proved')
    if (exit === undefined) limitations.push('structured process completion is unavailable')
    if (call.payload.content_omitted || call.event.attrs?.content_omitted || !Object.keys(call.payload).length) limitations.push('call content was not captured')
    if (result?.payload.content_omitted || result?.event.attrs?.content_omitted) limitations.push('result content was omitted')
    attempts.push({ attemptId: clean(attemptId ?? call.ref, 256), taskId, tool: clean(attrs.name, 100) || 'unknown', ...(command ? { command } : {}),
      ...(arguments_ === undefined ? {} : { arguments: arguments_ }), callRef: call.ref, ...(result ? { resultRef: result.ref } : {}), outcome, execution,
      ...(exit === undefined ? {} : { exitCode: exit }), ...(signal ? { signal } : {}),
      ...(output ? { outputExcerpt: clean(output) } : {}), payloadHashes: [call.payloadHash, ...(result ? [result.payloadHash] : [])], limitations })
  }
  if (calls.length > maxAttempts) gaps.push(`only ${maxAttempts} of ${calls.length} tool calls represented`)
  if (!input.request) gaps.push('user-role text may include host-injected context; exact human request identity was not captured')
  const request = input.request ? { text: clean(input.request.text, 8192), evidenceRefs: input.request.evidenceRefs } : { text: [...requests.keys()].join('\n').slice(0, 8192), evidenceRefs: [...new Set(requests.values())] }
  if (!request.text) gaps.push('request text unavailable')
  const languages: ReplayMemoryProposal['languages'] = []
  for (const [name, pattern] of [['TypeScript', /(?:\.tsx?\b|\btsc\b)/u], ['JavaScript', /(?:\.[cm]?js\b|\bnode\b)/u], ['Python', /(?:\.py\b|\bpython3?\b)/u], ['Rust', /(?:\.rs\b|\bcargo\b)/u], ['Lisp', /(?:\.lisp\b|\bsbcl\b|lisp_eval)/u]] as const) {
    const refs = attempts.filter(attempt => pattern.test(`${attempt.tool} ${attempt.command ?? ''}`)).map(attempt => attempt.callRef)
    if (refs.length) languages.push({ name, basis: 'inferred', evidenceRefs: refs })
  }
  const findings: ReplayMemoryProposal['findings'] = attempts.filter(a => a.outcome !== 'unknown').map(a => ({
    taskId: a.taskId ?? null, kind: a.outcome === 'succeeded' ? 'worked' : a.outcome === 'failed' ? 'failed' : 'key_point', text: `${a.tool}: observed ${a.outcome}${a.exitCode === undefined ? ' tool result' : ` process exit ${a.exitCode}`}. Task-level effectiveness and causes remain unverified.`,
    basis: 'observed', evidenceRefs: [a.callRef, ...(a.resultRef ? [a.resultRef] : [])] }))
  for (const text of gaps) findings.push({ kind: 'key_point', text, basis: 'observed', evidenceRefs: [] })
  return { schemaVersion: 1, proposalId: randomUUID(), revision: 1,
    source: { workspace: input.workspace, taskId: input.taskId, sessionId: input.sessionId, traces: [] }, request, languages, attempts, findings,
    tags: ['agenticreplay', ...languages.map(language => language.name.toLowerCase())], keywords: replayKeywords(`${request.text} ${attempts.map(a => a.command ?? a.tool).join(' ')}`) }
}
export function replayKeywords(text: string): string[] {
  const normalized = clean(text, 16384).normalize('NFKC').toLowerCase()
  const words = [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(normalized)].filter(row => row.isWordLike).map(row => row.segment)
  const identifiers = normalized.match(/[a-z0-9_][a-z0-9_.-]{1,63}/gu) ?? []
  const stop = new Set(['the', 'and', 'this', 'that', 'with', 'from', 'for', 'are', 'を', 'の', 'に', 'が', 'は', 'と', 'です', 'して', 'する', 'こと'])
  return [...new Set([...identifiers, ...words].filter(word => word.length > 1 && word.length <= 64 && !stop.has(word)))].slice(0, 64)
}
