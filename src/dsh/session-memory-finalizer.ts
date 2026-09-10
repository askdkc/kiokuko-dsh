import { EVOLUTION_OBSERVATION_EVENT, observationMatchesResult, type EvolutionObservation, type EvolutionObservationBinding } from './evolution-observation.js'
import { MemoryEvolutionConfig, evidenceReferences, supportingEvidenceDigest, episodeSignature, episodeSignals, parseEpisodeDraft, type EpisodeEvidence, type EpisodeDraft, type EvolutionConfig } from '../memory/evolution/contracts.js'
import { configureEvolution, saveEpisode, scheduleEvolution, evolutionSettings } from '../memory/evolution/store.js'
import { EvolutionWorker } from '../memory/evolution/worker.js'
import { DeepMemoryFinalizer } from '../deep-thinker/memory-finalizer.js'
import { DeepStore } from '../deep-thinker/store.js'
import { createHash } from 'node:crypto'
import type { SqliteDatabase } from '../db/adapter.js'
import { TransactionCommitUncertainError, withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { recordEntryInTransaction, type EntryRecord } from '../memory/entries.js'
import { buildStructuredScope } from '../memory/structured-memory.js'
import { canonicalContentHash, canonicalJson, containsDisallowedTextCharacters, normalizeTextLineEndings, type EntryKind, type JsonObject } from '../serialization/validate.js'
import type { DshRuntime } from './runtime.js'
import { buildDshPromptCacheLayout, type DshPromptCacheLayout } from './prompt-cache.js'
import { redactDshSourceText } from './message-sources.js'
import { buildFinalizationRequest, FINALIZATION_EVIDENCE_MAX_BYTES, FINALIZATION_STREAM_MAX_BYTES } from './finalization-request.js'
import { finalizationObservationScope, normalizeDshUsage, requestSize, modelLabel, type FinalizationInputMode, type EfficiencyObservation } from './efficiency.js'

export const DSH_MEMORY_CAPSULE_MAX_BYTES = 64 * 1024
const MAX_OUTPUT_TOKENS = 16_384
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024
const DEFAULT_EVIDENCE_BYTES = 256 * 1024
const MAX_EVIDENCE_CANDIDATES = 4_096
const MAX_ERROR_LENGTH = 2_000
const MAX_ATTEMPTS = 3
const FINALIZATION_TIMEOUT_MS = 5 * 60_000

export interface DshLogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly start: number; readonly end: number }
}

export interface DshSessionLogSnapshot {
  readonly session: { readonly id: string; readonly createdAt?: number; readonly cwd?: string }
  readonly inheritedEventCount: number
  readonly events: readonly DshLogEvent[]
}

export interface DshSessionQuery {
  readSession(sessionId: string): PromiseLike<DshSessionLogSnapshot>
  /** Preferred bounded reader. Legacy DSH adapters may omit it. */
  streamSession?(sessionId: string): PromiseLike<{
    readonly session: DshSessionLogSnapshot['session']
    readonly inheritedEventCount: number
    readonly events: AsyncIterable<DshLogEvent>
  }>
  cachePromptLayout?(layout: DshPromptCacheLayout): PromiseLike<boolean>
}

export interface DshSessionEventSource {
  snapshotEvents(): readonly DshLogEvent[]
}

export interface DshLlm {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
    readonly messages: readonly unknown[]
    readonly system?: string
    readonly tools?: readonly unknown[]
    readonly temperature?: number
    readonly maxTokens?: number
    readonly signal?: AbortSignal
    readonly sessionId?: string
    readonly purpose?: 'compaction' | 'session-title'
  }): AsyncIterable<unknown>
}

export interface DshMemoryFinalizerOptions {
  readonly onDeepFinalized?: (sessionId: string) => PromiseLike<unknown>
  readonly memoryEvolution?: EvolutionConfig
  readonly inputMode?: FinalizationInputMode
  readonly onObservation?: (observation: EfficiencyObservation) => void | PromiseLike<void>
  readonly runtime: Pick<DshRuntime, 'withDatabase'>
  readonly sessionQuery?: DshSessionQuery
  readonly llm?: DshLlm
  readonly now?: () => string
  readonly maximumAttempts?: number
  readonly timeoutMs?: number
  /** Best-effort cache retention transition after the Core commit succeeds. */
  readonly onFinalized?: (sessionId: string) => void | PromiseLike<void>
}

export interface ScheduleDshMemoryFinalizationInput {
  readonly runId: string
  readonly workspace: string
  readonly dshSessionId: string
  readonly sourceEndSeq: number
}

export interface BindDshRunLogStartInput {
  readonly runId: string
  readonly workspace: string
  readonly dshSessionId: string
  readonly sourceStartSeq: number
  readonly sourceStartTurn: number
}

export interface DshMemoryCapsuleItem {
  readonly kind: EntryKind
  readonly title: string
  readonly body: string
  readonly summary: string | null
  readonly confidence: number
  readonly tags: readonly string[]
}

export interface DshMemoryCapsule {
  readonly schemaVersion: 1
  readonly memories: readonly DshMemoryCapsuleItem[]
}

interface FinalizationJob extends Record<string, unknown> {
  readonly extractionVersion: 1 | 2
  readonly outcome: 'completed' | 'failed'
  readonly inputMode: FinalizationInputMode
  readonly runId: string
  readonly workspace: string
  readonly dshSessionId: string
  readonly sourceStartSeq: number
  readonly sourceEndSeq: number
  readonly attemptCount: number
  readonly scheduledAt: string
}

interface RequestEnvelope {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly system?: string
  readonly tools?: readonly unknown[]
  readonly contextWindow?: number
}

interface ModelUsage {
  reasoningTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface FinalizationAttempt {
  observation?: EfficiencyObservation
  usage: ModelUsage
}

interface SummaryResult {
  readonly capsule: DshMemoryCapsule
  readonly capsuleJson: string
  readonly usage: ModelUsage
  readonly envelope: RequestEnvelope
  readonly episode?: unknown
}

interface EvidenceCandidate {
  readonly seq: number
  readonly type: string
  readonly weight: number
  readonly text: string
}

export interface PreparedFinalizationLog {
  readonly messages: readonly unknown[]
  readonly evidence: string
  readonly envelope: RequestEnvelope
  readonly digest: string
  readonly eventCount: number
  /** Target-run surface AND off-surface evidence, only collected for the opt-in mode. */
  readonly episodeEvidence?: readonly EpisodeEvidence[]
  readonly boundedEvidence?: string
}

const ENTRY_KINDS = new Set<EntryKind>(['fact', 'decision', 'lesson', 'preference', 'reference'])

function validatedSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a non-negative safe integer`)
  }
  return value
}

function validatedTurn(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a positive safe integer`)
  }
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedError(error: unknown): { code: string; message: string } {
  const item = record(error)
  const code = typeof item?.code === 'string' && item.code.length > 0 ? item.code : 'FINALIZATION_FAILED'
  const raw = error instanceof Error ? error.message : String(error)
  return { code: code.slice(0, 128), message: raw.slice(0, MAX_ERROR_LENGTH) }
}

function validateIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a bounded non-empty string`)
  }
  return value
}

export function dshTurnBoundarySeq(
  session: DshSessionEventSource,
  turn: number,
  boundary: 'start' | 'end',
): number {
  const checkedTurn = validatedTurn(turn, 'turn')
  const type = `turn/${boundary}`
  const matches = session.snapshotEvents().filter((event) => (
    event.type === type && record(event.data)?.turn === checkedTurn
  ))
  if (matches.length !== 1) {
    throw new KiokukoError('INTEGRITY_ERROR', `DSH turn ${checkedTurn} has ${matches.length} ${type} boundaries`)
  }
  return validatedSequence(matches[0]!.seq, `${type} sequence`)
}

function surfaceNodes(events: readonly DshLogEvent[]): number[] {
  const nodes: number[] = []
  for (const event of events) {
    if (event.surfaceOp === undefined) continue
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      continue
    }
    const start = nodes.indexOf(event.surfaceOp.start)
    const end = nodes.indexOf(event.surfaceOp.end)
    if (start < 0 || end < start) {
      throw new KiokukoError('INTEGRITY_ERROR', 'DSH session surface replacement is inconsistent')
    }
    nodes.splice(start, end - start + 1, event.seq)
  }
  return nodes
}

function messageForSurfaceEvent(event: DshLogEvent): unknown | undefined {
  const data = record(event.data)
  if (event.type === 'user/message') return data
  if (event.type === 'assistant/message') return data?.message
  if (event.type === 'tool/result') return data?.message
  return undefined
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  const visit = (block: unknown): void => {
    const item = record(block)
    if (item === undefined) return
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'tool-call') {
      if (typeof item.name === 'string') parts.push(item.name)
      if (typeof item.arguments === 'string') parts.push(item.arguments)
    } else if (item.type === 'tool-result' && Array.isArray(item.content)) {
      for (const child of item.content) visit(child)
    }
    // Reasoning, images, and plugin-private blocks are deliberately excluded.
  }
  for (const block of value) visit(block)
  return parts.map((part) => part.trim()).filter(Boolean).join('\n')
}

function genericText(value: unknown, maximumStrings = 256): string {
  const result: string[] = []
  const visit = (item: unknown, depth: number): void => {
    if (result.length >= maximumStrings || depth > 12) return
    if (typeof item === 'string') {
      if (item.trim().length > 0) result.push(item)
      return
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    const object = record(item)
    if (object === undefined) return
    for (const [key, child] of Object.entries(object)) {
      if (/^(?:reasoning|rawOutput|replayState)$/u.test(key)) continue
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  return result.map((part) => part.trim()).filter(Boolean).join('\n')
}

function eventText(event: DshLogEvent): string {
  const data = record(event.data)
  if (event.type === 'user/message') return contentText(data?.content)
  if (event.type === 'assistant/message') return contentText(record(data?.message)?.content)
  if (event.type === 'tool/call') {
    return [data?.name, data?.arguments].filter((item): item is string => typeof item === 'string').join('\n')
  }
  if (event.type === 'tool/result') {
    const error = record(data?.error)
    return [contentText(record(data?.message)?.content), error?.name, error?.code]
      .filter((item): item is string => typeof item === 'string' && item.length > 0).join('\n')
  }
  if (event.type === 'todo/write') return genericText(data?.todos)
  if (event.type === 'compaction/summary') {
    return typeof data?.summary === 'string' ? data.summary : contentText(data?.summary)
  }
  if (event.type === EVOLUTION_OBSERVATION_EVENT) return ''
  if (event.type === 'turn/end') return genericText(data?.reason)
  if (event.type === 'goal/change') return genericText(data)
  if (/^(?:turn|step)\/(?:start|end)$/u.test(event.type)
    || event.type === 'assistant/chunk'
    || event.type === 'request/header'
    || event.type === 'request/context'
    || event.type === 'session/end-seed'
    || event.type === 'compaction/start'
    || event.type === 'compaction/end') return ''
  return genericText(data)
}

function evidenceWeight(event: DshLogEvent): number {
  if (event.type === 'user/message') return 100
  if (event.type === 'goal/change') return 98
  if (event.type === 'turn/end') return /error|blocked|aborted/iu.test(eventText(event)) ? 97 : 20
  if (event.type === 'compaction/summary') return 94
  if (event.type === 'tool/result') return record(record(event.data)?.error) === undefined ? 80 : 96
  if (event.type === 'assistant/message') return 78
  if (event.type === 'todo/write') return 72
  if (event.type === 'tool/call') return 65
  return 50
}

function worseThan(left: EvidenceCandidate, right: EvidenceCandidate): boolean {
  return left.weight < right.weight || left.weight === right.weight && left.seq < right.seq
}

function heapPush(heap: EvidenceCandidate[], item: EvidenceCandidate): void {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (!worseThan(heap[index]!, heap[parent]!)) break
    ;[heap[index], heap[parent]] = [heap[parent]!, heap[index]!]
    index = parent
  }
}

function heapReplaceWorst(heap: EvidenceCandidate[], item: EvidenceCandidate): void {
  heap[0] = item
  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let worst = index
    if (left < heap.length && worseThan(heap[left]!, heap[worst]!)) worst = left
    if (right < heap.length && worseThan(heap[right]!, heap[worst]!)) worst = right
    if (worst === index) return
    ;[heap[index], heap[worst]] = [heap[worst]!, heap[index]!]
    index = worst
  }
}

function selectEvidence(events: readonly DshLogEvent[], currentSurface: ReadonlySet<number>): EvidenceCandidate[] {
  const heap: EvidenceCandidate[] = []
  for (const event of events) {
    if (currentSurface.has(event.seq)) continue
    considerEvidence(heap, event)
  }
  return heap.sort((left, right) => right.weight - left.weight || right.seq - left.seq)
}

function considerEvidence(heap: EvidenceCandidate[], event: DshLogEvent): void {
  const weight = evidenceWeight(event)
  if (heap.length >= MAX_EVIDENCE_CANDIDATES) {
    const worst = heap[0]!
    if (weight < worst.weight || weight === worst.weight && event.seq <= worst.seq) return
  }
  const text = eventText(event).trim()
  if (text.length === 0) return
  const candidate = { seq: event.seq, type: event.type, weight, text }
  if (heap.length < MAX_EVIDENCE_CANDIDATES) heapPush(heap, candidate)
  else heapReplaceWorst(heap, candidate)
}

function takeUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let result = ''
  let bytes = 0
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8')
    if (bytes + size > maximumBytes) break
    result += point
    bytes += size
  }
  return result
}

function evidenceDocument(candidates: readonly EvidenceCandidate[], maximumBytes: number): string {
  if (maximumBytes <= 0) return ''
  const selected: EvidenceCandidate[] = []
  let remaining = maximumBytes
  for (const candidate of candidates) {
    const prefix = `[weight=${candidate.weight} seq=${candidate.seq} type=${candidate.type}]\n`
    const overhead = Buffer.byteLength(`${prefix}\n\n`, 'utf8')
    if (overhead >= remaining) continue
    const body = takeUtf8(candidate.text, remaining - overhead)
    if (body.length === 0) continue
    selected.push({ ...candidate, text: body })
    remaining -= overhead + Buffer.byteLength(body, 'utf8')
    if (remaining < 128) break
  }
  return selected.sort((left, right) => left.seq - right.seq)
    .map((item) => `[weight=${item.weight} seq=${item.seq} type=${item.type}]\n${item.text}`)
    .join('\n\n')
}

function latestEnvelope(events: readonly DshLogEvent[]): RequestEnvelope {
  let header: Record<string, unknown> | undefined
  let contextWindow: number | undefined
  for (const event of events) {
    const data = record(event.data)
    if (event.type === 'request/header') header = record(data?.header)
    if (event.type === 'request/context' && Number.isSafeInteger(data?.contextWindow) && (data?.contextWindow as number) > 0) {
      contextWindow = data?.contextWindow as number
    }
  }
  const config = record(header?.config)
  if (typeof config?.provider !== 'string' || config.provider.length === 0
    || typeof config.model !== 'string' || config.model.length === 0) {
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'The completed DSH log has no model request header for memory finalization')
  }
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(typeof header?.system === 'string' ? { system: header.system } : {}),
    ...(Array.isArray(header?.tools) ? { tools: header.tools } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

function latestInputUsage(events: readonly DshLogEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'assistant/message') continue
    const usage = record(record(event.data)?.usage)
    if (usage === undefined) continue
    const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .map((key) => usage[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    if (fields.length > 0) return fields.reduce((sum, value) => sum + value, 0)
  }
  return undefined
}

function evidenceBudget(envelope: RequestEnvelope, events: readonly DshLogEvent[]): number {
  if (envelope.contextWindow === undefined) return DEFAULT_EVIDENCE_BYTES
  const inputTokens = latestInputUsage(events)
  if (inputTokens === undefined) return Math.min(MAX_EVIDENCE_BYTES, Math.floor(envelope.contextWindow * 0.25))
  const remainingTokens = Math.max(0, envelope.contextWindow - inputTokens - MAX_OUTPUT_TOKENS - 4_096)
  // Two UTF-8 bytes per remaining token is conservative for mixed Japanese,
  // code, and English evidence. DSH's current surface already fitted the same
  // provider/model request; only this additional evidence consumes the margin.
  return Math.min(MAX_EVIDENCE_BYTES, remainingTokens * 2)
}

function boundedSessionEvents(
  events: readonly DshLogEvent[],
  sourceStartSeq: number,
  sourceEndSeq: number,
): { readonly throughEnd: readonly DshLogEvent[]; readonly target: readonly DshLogEvent[] } {
  const start = validatedSequence(sourceStartSeq, 'sourceStartSeq')
  const end = validatedSequence(sourceEndSeq, 'sourceEndSeq')
  if (end < start) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization log range is reversed')
  const startIndexes: number[] = []
  const endIndexes: number[] = []
  events.forEach((event, index) => {
    if (event.seq === start) startIndexes.push(index)
    if (event.seq === end) endIndexes.push(index)
  })
  if (startIndexes.length !== 1 || endIndexes.length !== 1 || endIndexes[0]! < startIndexes[0]!) {
    throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization log range is absent or ambiguous')
  }
  const startIndex = startIndexes[0]!
  const endIndex = endIndexes[0]!
  const target = events.slice(startIndex, endIndex + 1)
  if (target[0]?.type !== 'turn/start' || target.at(-1)?.type !== 'turn/end') {
    throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization range is not bounded by a complete turn sequence')
  }
  return { throughEnd: events.slice(0, endIndex + 1), target }
}

export function parseCapsule(raw: string): { capsule: DshMemoryCapsule; capsuleJson: string; episode?: unknown } {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch (cause) {
    const error = new KiokukoError('VALIDATION_ERROR', 'DSH memory finalizer returned invalid JSON')
    Object.defineProperty(error, 'cause', { value: cause })
    throw error
  }
  const root = record(parsed)
  if ((root?.schemaVersion !== 1 && root?.schemaVersion !== 2) || !Array.isArray(root.memories) || root.memories.length > 20
    || Object.keys(root).some((key) => key !== 'schemaVersion' && key !== 'memories' && !(root.schemaVersion === 2 && key === 'episode'))) {
    throw new KiokukoError('VALIDATION_ERROR', 'DSH memory finalizer returned an invalid capsule envelope')
  }
  if (Buffer.byteLength(canonicalJson(root), 'utf8') > DSH_MEMORY_CAPSULE_MAX_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'DSH memory capsule exceeds 65536 UTF-8 bytes')
  const memories = root.memories.map((value, index): DshMemoryCapsuleItem => {
    const item = record(value)
    if (item === undefined || typeof item.kind !== 'string' || !ENTRY_KINDS.has(item.kind as EntryKind)) {
      throw new KiokukoError('VALIDATION_ERROR', `DSH memory capsule item ${index} has an invalid kind`)
    }
    const itemFields = new Set(['kind', 'title', 'body', 'summary', 'confidence', 'tags'])
    if (Object.keys(item).some((key) => !itemFields.has(key))) {
      throw new KiokukoError('VALIDATION_ERROR', `DSH memory capsule item ${index} has unknown fields`)
    }
    const title = typeof item.title === 'string' ? normalizeTextLineEndings(item.title).trim() : ''
    const body = typeof item.body === 'string' ? normalizeTextLineEndings(item.body).trim() : ''
    const summary = item.summary === null ? null : typeof item.summary === 'string' ? normalizeTextLineEndings(item.summary).trim() : undefined
    if (title.length === 0 || title.length > 200 || body.length === 0 || summary === undefined || (summary?.length ?? 0) > 2_000
      || containsDisallowedTextCharacters(title, true) || containsDisallowedTextCharacters(body, true)
      || summary !== null && containsDisallowedTextCharacters(summary, true)) {
      throw new KiokukoError('VALIDATION_ERROR', `DSH memory capsule item ${index} has invalid text`)
    }
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new KiokukoError('VALIDATION_ERROR', `DSH memory capsule item ${index} has invalid confidence`)
    }
    if (!Array.isArray(item.tags) || item.tags.length > 20
      || item.tags.some((tag) => typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 100 || containsDisallowedTextCharacters(tag))) {
      throw new KiokukoError('VALIDATION_ERROR', `DSH memory capsule item ${index} has invalid tags`)
    }
    return Object.freeze({
      kind: item.kind as EntryKind,
      title,
      body,
      summary,
      confidence: item.confidence,
      tags: Object.freeze([...new Set(item.tags as string[])]),
    })
  })
  const capsule = Object.freeze({ schemaVersion: 1 as const, memories: Object.freeze(memories) })
  const capsuleJson = canonicalJson(capsule)
  if (Buffer.byteLength(capsuleJson, 'utf8') > DSH_MEMORY_CAPSULE_MAX_BYTES) {
    throw new KiokukoError('VALIDATION_ERROR', 'DSH memory capsule exceeds 65536 UTF-8 bytes')
  }
  return { capsule, capsuleJson, ...(root.schemaVersion === 2 && root.episode !== undefined ? { episode: root.episode } : {}) }
}

function logDigest(events: readonly DshLogEvent[]): string {
  const hash = createHash('sha256')
  for (const event of events) hash.update(canonicalJson(event), 'utf8').update('\n')
  return hash.digest('hex')
}

function validStreamEvent(event: DshLogEvent): void {
  if (typeof event !== 'object' || event === null || typeof event.type !== 'string' || event.type.length === 0
    || !Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isFinite(event.time)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization stream contains an invalid event')
  }
}

async function* arrayEvents(events: readonly DshLogEvent[]): AsyncIterable<DshLogEvent> {
  for (const event of events) yield event
}

/** One-pass log reduction. Memory is bounded by current surface plus top-K evidence. */
export async function reduceDshFinalizationLog(
  events: AsyncIterable<DshLogEvent>,
  sourceStartSeq: number,
  sourceEndSeq: number,
  inputMode: FinalizationInputMode = 'prefix_reuse',
  identity?: EvolutionObservationBinding,
): Promise<PreparedFinalizationLog> {
  const start = validatedSequence(sourceStartSeq, 'sourceStartSeq')
  const end = validatedSequence(sourceEndSeq, 'sourceEndSeq')
  if (end < start) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization log range is reversed')
  const nodes: number[] = []
  const surfaceEvents = new Map<number, DshLogEvent>()
  const evidenceHeap: EvidenceCandidate[] = []
  const boundedHeap: EvidenceCandidate[] = []
  const boundedLatest = new Map<string, EvidenceCandidate>()
  const episodeEvidence: EpisodeEvidence[] = []
  const nativeCalls = new Map<string, {name:string;seq:number}>()
  const nativeProofs = new Map<string, EvolutionObservation>()
  const digest = createHash('sha256')
  let latestHeader: DshLogEvent | undefined
  let latestContext: DshLogEvent | undefined
  let latestUsage: DshLogEvent | undefined
  let previousSeq = -1
  let sawStart = false
  let sawEnd = false
  let firstTargetType: string | undefined
  let lastTargetType: string | undefined
  let eventCount = 0

  for await (const event of events) {
    validStreamEvent(event)
    if (event.seq <= previousSeq) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization event sequence is not strictly increasing')
    previousSeq = event.seq
    if (event.seq > end) break

    if (event.type === 'request/header') latestHeader = event
    if (event.type === 'request/context') latestContext = event
    if (event.type === 'assistant/message' && latestInputUsage([event]) !== undefined) latestUsage = event

    if (event.surfaceOp === 'append') {
      nodes.push(event.seq)
      surfaceEvents.set(event.seq, event)
    } else if (event.surfaceOp !== undefined) {
      const startIndex = nodes.indexOf(event.surfaceOp.start)
      const endIndex = nodes.indexOf(event.surfaceOp.end)
      if (startIndex < 0 || endIndex < startIndex) {
        throw new KiokukoError('INTEGRITY_ERROR', 'DSH session surface replacement is inconsistent')
      }
      for (const sequence of nodes.slice(startIndex, endIndex + 1)) surfaceEvents.delete(sequence)
      nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
      surfaceEvents.set(event.seq, event)
    }

    if (event.seq < start) continue
    if (event.seq === start) {
      if (sawStart) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization start sequence is ambiguous')
      sawStart = true
      firstTargetType = event.type
    }
    if (!sawStart) continue
    if (sawEnd) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization end sequence is ambiguous')
    digest.update(canonicalJson(event), 'utf8').update('\n')
    eventCount += 1
    lastTargetType = event.type
    considerEvidence(evidenceHeap, event)
    const nativeData = record(event.data)
    if (event.type === 'tool/call' && typeof nativeData?.callId === 'string' && typeof nativeData.name === 'string') {
      nativeCalls.set(nativeData.callId, {name:nativeData.name,seq:event.seq})
      if (nativeCalls.size > 256) nativeCalls.delete(nativeCalls.keys().next().value!)
    }
    if (event.type === EVOLUTION_OBSERVATION_EVENT && identity && nativeData?.schemaVersion === 1 &&
      nativeData.runId === identity.runId && nativeData.workspace === identity.workspace && nativeData.sessionId === identity.sessionId &&
      typeof nativeData.callId === 'string' && nativeCalls.get(nativeData.callId)?.seq === nativeData.callSeq &&
      (Number.isSafeInteger(nativeData.exitCode) || nativeData.exitCode === null && nativeData.failed === true) && typeof nativeData.failed === 'boolean' && (nativeData.failed || nativeData.exitCode === 0) && typeof nativeData.presentationHash === 'string') {
      nativeProofs.set(nativeData.callId, nativeData as unknown as EvolutionObservation)
      if (nativeProofs.size > 256) nativeProofs.delete(nativeProofs.keys().next().value!)
    }
    const resultCallId = record(record(nativeData?.message)?.source)?.callId ?? nativeData?.callId
    const toolName = typeof resultCallId === 'string' ? nativeCalls.get(resultCallId)?.name : undefined
    const proof = typeof resultCallId === 'string' ? nativeProofs.get(resultCallId) : undefined
    const observation = episodeEvidenceForEvent(event, toolName, proof && observationMatchesResult(proof,event.data) ? proof : undefined)
    if (event.type === 'tool/result' && typeof resultCallId === 'string') { nativeCalls.delete(resultCallId); nativeProofs.delete(resultCallId) }
    if (observation) {
      episodeEvidence.push(observation)
      // Retain a bounded tail of native observations. Truncation is explicit in the prompt.
      while (episodeEvidence.length > 64 || Buffer.byteLength(JSON.stringify(episodeEvidence)) > 24000) episodeEvidence.shift()
    }
    if (inputMode === 'bounded_evidence' && boundedEvidenceEvent(event)) {
      const text = redactDshSourceText(eventText(event))
      if (text !== null) {
        const candidate = { seq: event.seq, type: event.type, weight: evidenceWeight(event),
          text: Buffer.byteLength(text, 'utf8') <= 4096 ? text : `${takeUtf8(text, 4000)}\n[evidence excerpt truncated]` }
        boundedLatest.set(event.type, candidate)
        if (event.type === 'tool/result' && record(record(event.data)?.error) !== undefined) boundedLatest.set('last-tool-error', candidate)
        if (boundedHeap.length < MAX_EVIDENCE_CANDIDATES) heapPush(boundedHeap, candidate)
        else if (worseThan(boundedHeap[0]!, candidate)) heapReplaceWorst(boundedHeap, candidate)
      }
    }
    if (event.seq === end) sawEnd = true
  }

  if (!sawStart || !sawEnd) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization log range is absent')
  if (firstTargetType !== 'turn/start' || lastTargetType !== 'turn/end') {
    throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization range is not bounded by a complete turn sequence')
  }
  const metadata = [latestHeader, latestContext, latestUsage]
    .filter((event): event is DshLogEvent => event !== undefined)
    .sort((left, right) => left.seq - right.seq)
  const envelope = latestEnvelope(metadata)
  const current = new Set(nodes)
  const messages = nodes.flatMap((sequence) => {
    const event = surfaceEvents.get(sequence)
    const message = event === undefined ? undefined : messageForSurfaceEvent(event)
    return message === undefined ? [] : [message]
  })
  const selected = evidenceHeap
    .filter((candidate) => !current.has(candidate.seq))
    .sort((left, right) => right.weight - left.weight || right.seq - left.seq)
  return Object.freeze({
    messages: Object.freeze(messages),
    evidence: evidenceDocument(selected, evidenceBudget(envelope, metadata)),
    envelope,
    digest: digest.digest('hex'),
    eventCount,
    episodeEvidence: Object.freeze(episodeEvidence),
    ...(inputMode === 'bounded_evidence' ? { boundedEvidence: evidenceDocument(
      [...new Map([
        ...boundedLatest.values(),
        ...boundedHeap.sort((left, right) => right.weight - left.weight || right.seq - left.seq),
      ].map(candidate => [candidate.seq, candidate])).values()],
      Math.min(FINALIZATION_EVIDENCE_MAX_BYTES, Math.max(0, (envelope.contextWindow ?? 0) - MAX_OUTPUT_TOKENS - 4096)),
    ) } : {}),
  })
}

function checkedInputMode(value: unknown): FinalizationInputMode {
  if (value !== 'prefix_reuse' && value !== 'bounded_evidence') throw new KiokukoError('VALIDATION_ERROR', 'Unsupported finalization input mode')
  return value
}

function boundedEvidenceEvent(event: DshLogEvent): boolean {
  // Plugin snapshots and cross-run compaction summaries can contain earlier tasks.
  if (event.type === 'user/message') return record(record(event.data)?.source)?.kind !== 'plugin'
  return ['assistant/message', 'tool/call', 'tool/result', 'goal/change', 'todo/write', 'turn/end'].includes(event.type)
}

function usageFromChunk(chunk: Record<string, unknown>): ModelUsage | undefined {
  if (chunk.type !== 'usage') return undefined
  const usage = record(chunk.usage)
  if (usage === undefined) return undefined
  const result: ModelUsage = {}
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value
  }
  return result
}

function repositoryId(database: SqliteDatabase, workspace: string): string {
  const row = database.prepare('SELECT repository_id AS repositoryId FROM repositories WHERE workspace = ?')
    .get<{ repositoryId: string }>(workspace)
  if (row === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'DSH finalization workspace has no repository binding')
  return row.repositoryId
}

export function bindDshRunLogStartInTransaction(
  database: SqliteDatabase,
  input: BindDshRunLogStartInput,
  now: string,
): void {
  const runId = validateIdentity(input.runId, 'runId')
  const workspace = validateIdentity(input.workspace, 'workspace')
  const sessionId = validateIdentity(input.dshSessionId, 'dshSessionId')
  const sourceStartSeq = validatedSequence(input.sourceStartSeq, 'sourceStartSeq')
  const sourceStartTurn = validatedTurn(input.sourceStartTurn, 'sourceStartTurn')
  const existing = database.prepare(`
    SELECT workspace, dsh_session_id AS dshSessionId,
           source_start_seq AS sourceStartSeq, source_start_turn AS sourceStartTurn
      FROM dsh_run_log_boundaries
     WHERE run_id = ?
  `).get<{
    workspace: string
    dshSessionId: string
    sourceStartSeq: number
    sourceStartTurn: number
  }>(runId)
  if (existing !== undefined) {
    if (existing.workspace !== workspace || existing.dshSessionId !== sessionId) {
      throw new KiokukoError('CONFLICT', 'DSH run log boundary identity is immutable')
    }
    const incomingEarlier = sourceStartTurn <= existing.sourceStartTurn && sourceStartSeq <= existing.sourceStartSeq
    const incomingLater = sourceStartTurn >= existing.sourceStartTurn && sourceStartSeq >= existing.sourceStartSeq
    if (!incomingEarlier && !incomingLater) {
      throw new KiokukoError('INTEGRITY_ERROR', 'DSH run turn and sequence boundaries disagree')
    }
    if (incomingEarlier && (sourceStartTurn < existing.sourceStartTurn || sourceStartSeq < existing.sourceStartSeq)) {
      database.prepare(`
        UPDATE dsh_run_log_boundaries
           SET source_start_seq = ?, source_start_turn = ?, updated_at = ?
         WHERE run_id = ?
      `).run(sourceStartSeq, sourceStartTurn, now, runId)
    }
    return
  }
  database.prepare(`
    INSERT INTO dsh_run_log_boundaries (
      run_id, workspace, dsh_session_id, source_start_seq,
      source_start_turn, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, workspace, sessionId, sourceStartSeq, sourceStartTurn, now, now)
}

/**
 * Durable post-completion memory pipeline. It never observes `session/event`
 * and never registers a `session/flush` listener itself: DSH owns the
 * canonical log, the separate non-vetoing mirror owns bounded reads, and this
 * worker consumes that mirror only after the run has committed `completed`.
 */
export class DshMemoryFinalizer {
  readonly #deep: DeepMemoryFinalizer
  readonly #runtime: DshMemoryFinalizerOptions['runtime']
  readonly #sessionQuery: DshSessionQuery | undefined
  readonly #llm: DshLlm | undefined
  readonly #now: () => string
  readonly #maximumAttempts: number
  readonly #timeoutMs: number
  readonly #onFinalized: DshMemoryFinalizerOptions['onFinalized']
  #inputMode: FinalizationInputMode
  #onObservation: DshMemoryFinalizerOptions['onObservation']
  #evolutionConfig: EvolutionConfig
  #evolutionWorker: EvolutionWorker | undefined
  #startup: Promise<void> | undefined
  #configured = false
  #drain: Promise<void> | undefined
  #abort: AbortController | undefined
  #rerunRequested = false
  #closed = false
  #lastDrainError: unknown

  constructor(options: DshMemoryFinalizerOptions) {
    this.#deep = new DeepMemoryFinalizer(new DeepStore(options.runtime), options.llm, options.onDeepFinalized)
    this.#evolutionConfig = options.memoryEvolution ?? MemoryEvolutionConfig.parse({})
    this.#runtime = options.runtime
    this.#sessionQuery = options.sessionQuery
    this.#llm = options.llm
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#maximumAttempts = options.maximumAttempts ?? MAX_ATTEMPTS
    this.#timeoutMs = options.timeoutMs ?? FINALIZATION_TIMEOUT_MS
    this.#onFinalized = options.onFinalized
    this.#inputMode = checkedInputMode(options.inputMode ?? 'prefix_reuse')
    this.#onObservation = options.onObservation
  }

  /** Composition may configure a supplied host only before scheduling or starting it. */
  configure(inputMode: FinalizationInputMode, onObservation?: DshMemoryFinalizerOptions['onObservation']): void {
    if (this.#configured) throw new KiokukoError('CONFLICT', 'Memory finalizer configuration is already bound')
    this.#inputMode = checkedInputMode(inputMode)
    this.#onObservation = onObservation
  }

  configureMemoryEvolution(config: EvolutionConfig): void {
    if (this.#configured) throw new KiokukoError('CONFLICT', 'Evolution configuration already started')
    this.#evolutionConfig = config
  }

  get lastDrainError(): unknown { return this.#lastDrainError }

  /** Recover a process-interrupted job once, then drain pending work in background. */
  async start(): Promise<void> {
    if (this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH memory finalizer is closed')
    this.#startup ??= this.#startOnce()
    await this.#startup
  }

  async #startOnce(): Promise<void> {
    this.#configured = true
    if (this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH memory finalizer is closed')
    await this.#runtime.withDatabase((database) => {
      database.prepare(`
        UPDATE dsh_memory_finalizations
           SET status = 'pending', updated_at = ?
         WHERE status IN ('processing', 'failed') AND attempt_count < ?
      `).run(this.#now(), this.#maximumAttempts)
    })
    await this.#runtime.withDatabase(database => configureEvolution(database, this.#evolutionConfig.mode))
    if (this.#closed) return
    this.#evolutionWorker = new EvolutionWorker({ runtime: this.#runtime, config: this.#evolutionConfig,
      ...(this.#llm === undefined ? {} : { llm: this.#llm }), now: this.#now })
    this.#evolutionWorker.kick()
    this.kick()
  }

  /** Persist the first DSH turn boundary for a run before model execution continues. */
  async bindRunStart(input: BindDshRunLogStartInput): Promise<void> {
    const now = this.#now()
    await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      bindDshRunLogStartInTransaction(database, input, now)
    }))
  }

  /** Must be called inside the same transaction that terminalizes the run. */
  scheduleInTransaction(database: SqliteDatabase, input: ScheduleDshMemoryFinalizationInput): void {
    this.#configured = true
    const runId = validateIdentity(input.runId, 'runId')
    const workspace = validateIdentity(input.workspace, 'workspace')
    const sessionId = validateIdentity(input.dshSessionId, 'dshSessionId')
    const sourceEndSeq = validatedSequence(input.sourceEndSeq, 'sourceEndSeq')
    const existing = database.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id = ?')
      .get<{ status: string }>(runId)
    if (existing !== undefined) return
    const boundary = database.prepare(`
      SELECT source_start_seq AS sourceStartSeq
        FROM dsh_run_log_boundaries
       WHERE run_id = ? AND workspace = ? AND dsh_session_id = ?
    `).get<{ sourceStartSeq: number }>(runId, workspace, sessionId)
    if (boundary === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Completed DSH run has no bound log start')
    if (sourceEndSeq < boundary.sourceStartSeq) throw new KiokukoError('INTEGRITY_ERROR', 'Completed DSH run has a reversed log range')
    const now = this.#now()
    database.prepare(`
      INSERT INTO dsh_memory_finalizations (
        run_id, workspace, dsh_session_id, source_start_seq, source_end_seq,
        status, attempt_count, input_mode, extraction_version,
        scheduled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(runId, workspace, sessionId, boundary.sourceStartSeq, sourceEndSeq, this.#inputMode, this.#evolutionConfig.mode === 'off' ? 1 : 2, now, now)
  }

  /** Schedule a background drain after the enclosing transaction commits. */
  kick(): void {
    if (this.#closed) return
    if (this.#drain !== undefined) {
      this.#rerunRequested = true
      return
    }
    const operation = this.#drainPending()
    this.#drain = operation
    void operation.catch((error) => { this.#lastDrainError = error }).finally(() => {
      if (this.#drain === operation) this.#drain = undefined
      if (this.#rerunRequested && !this.#closed) {
        this.#rerunRequested = false
        this.kick()
      }
    })
  }

  /** Await currently queued work; intended for orderly shutdown and tests. */
  async whenIdle(): Promise<void> {
    while (this.#drain !== undefined) {
      const drain = this.#drain
      await drain
      await Promise.resolve()
    }
    await this.#evolutionWorker?.whenIdle()
  }

  /** Explicitly retry one contained failure without changing DSH session state. */
  async retryFailed(runId: string): Promise<void> {
    const checked = validateIdentity(runId, 'runId')
    await this.#runtime.withDatabase((database) => {
      database.prepare(`
        UPDATE dsh_memory_finalizations
           SET status = 'pending', updated_at = ?
         WHERE run_id = ? AND status = 'failed' AND attempt_count < ?
      `).run(this.#now(), checked, this.#maximumAttempts)
    })
    this.kick()
  }

  async #claim(): Promise<FinalizationJob | undefined> {
    return this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      const row = database.prepare(`
        SELECT run_id AS runId, workspace, dsh_session_id AS dshSessionId,
               source_start_seq AS sourceStartSeq, source_end_seq AS sourceEndSeq,
               attempt_count AS attemptCount, scheduled_at AS scheduledAt, input_mode AS inputMode, extraction_version AS extractionVersion,
               (SELECT status FROM ledger_runs r WHERE r.run_id=dsh_memory_finalizations.run_id) AS outcome
          FROM dsh_memory_finalizations
         WHERE status = 'pending' AND attempt_count < ?
         ORDER BY scheduled_at, run_id
         LIMIT 1
      `).get<FinalizationJob>(this.#maximumAttempts)
      if (row === undefined) return undefined
      const now = this.#now()
      database.prepare(`
        UPDATE dsh_memory_finalizations
           SET status = 'processing', attempt_count = attempt_count + 1,
               started_at = ?, last_error_code = NULL,
               last_error_message = NULL, updated_at = ?
         WHERE run_id = ? AND status = 'pending'
      `).run(now, now, row.runId)
      return { ...row, attemptCount: row.attemptCount + 1 }
    }))
  }

  async #drainPending(): Promise<void> {
    while (!this.#closed) {
      const job = await this.#claim()
      if (job === undefined) { if (await this.#deep.processNext()) continue; return }
      await this.#process(job)
    }
  }

  async #summarize(job: FinalizationJob, prepared: PreparedFinalizationLog, signal: AbortSignal, attempt: FinalizationAttempt): Promise<SummaryResult> {
    if (this.#llm === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH LLM service is unavailable for memory finalization')
    const { envelope } = prepared
    const built = buildFinalizationRequest(job, prepared, signal)
    const request = built.request
    try { if (this.#onObservation !== undefined) attempt.observation = {
      callId: `finalization:${job.runId}:${job.attemptCount}`, sessionId: job.dshSessionId, runId: job.runId,
      task: 'memory-finalization', attempt: job.attemptCount, provider: modelLabel(envelope.provider), model: modelLabel(envelope.model),
      request: requestSize(request), usage: normalizeDshUsage(undefined), status: 'unknown', durationMs: 0,
      inputMode: built.inputMode, ...(built.fallback === undefined ? {} : { fallback: built.fallback }),
    } } catch { /* Optional request measurement cannot reject extraction. */ }
    const cacheLayout = buildDshPromptCacheLayout({
      provider: envelope.provider,
      model: envelope.model,
      ...(envelope.reasoningEffort === undefined ? {} : { reasoning: envelope.reasoningEffort }),
      toolSchema: request.tools ?? [],
      memoryRevision: String(job.sourceEndSeq),
      phase: 'compaction',
      fragments: [
        { kind: 'system', id: 'dsh-system', value: request.system ?? '' },
        { kind: 'tool_schema', id: 'dsh-tools', value: request.tools ?? [] },
      ],
    })
    try { await this.#sessionQuery?.cachePromptLayout?.(cacheLayout) } catch { /* local cache is non-vetoing */ }
    let text = ''
    let textBytes = 0
    let usage: ModelUsage = {}
    let finish: Record<string, unknown> | undefined
    for await (const value of this.#llm.stream(request)) {
      const chunk = record(value)
      if (chunk === undefined) continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        textBytes += Buffer.byteLength(chunk.text, 'utf8')
        if (textBytes > FINALIZATION_STREAM_MAX_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'DSH memory finalization stream exceeds its byte limit')
        text += chunk.text
      }
      const measured = usageFromChunk(chunk)
      if (measured !== undefined) { usage = measured; attempt.usage = measured }
      if (chunk.type === 'finish') finish = chunk
    }
    const reason = record(finish?.reason)
    if (finish === undefined || reason?.kind !== 'stop') {
      throw new KiokukoError('SERVICE_UNAVAILABLE', `DSH memory finalizer did not stop normally (${String(reason?.kind ?? 'missing-finish')})`)
    }
    return { ...parseCapsule(text), usage, envelope }
  }

  async #process(job: FinalizationJob): Promise<void> {
    const controller = new AbortController()
    const attempt: FinalizationAttempt = { usage: {} }
    const started = performance.now()
    let completed = false
    let commitUncertain = false
    this.#abort = controller
    const timer = setTimeout(() => controller.abort(new KiokukoError('SERVICE_UNAVAILABLE', 'DSH memory finalization timed out')), this.#timeoutMs)
    try {
      if (this.#sessionQuery === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session query service is unavailable for memory finalization')
      const streamed = this.#sessionQuery.streamSession === undefined
        ? undefined
        : await this.#sessionQuery.streamSession(job.dshSessionId)
      const snapshot = streamed === undefined ? await this.#sessionQuery.readSession(job.dshSessionId) : undefined
      const session = streamed?.session ?? snapshot!.session
      if (session.id !== job.dshSessionId) throw new KiokukoError('INTEGRITY_ERROR', 'DSH session query returned another session')
      const prepared = await reduceDshFinalizationLog(
        streamed?.events ?? arrayEvents(snapshot!.events),
        job.sourceStartSeq,
        job.sourceEndSeq,
        job.inputMode,
        {runId:job.runId,workspace:job.workspace,sessionId:job.dshSessionId},
      )
      const extractEpisode = job.extractionVersion === 2 && await this.#runtime.withDatabase(database => evolutionSettings(database).mode !== 'off')
      const requestJob = extractEpisode ? job : { ...job, extractionVersion: 1 as const }
      const result = await finalizationObservationScope.run(true, () => this.#summarize(requestJob, prepared, controller.signal, attempt))
      let episode: EpisodeDraft | undefined
      let episodeError: string | undefined
      if (extractEpisode) {
        try { episode = parseEpisodeDraft(result.episode, prepared.episodeEvidence ?? []) }
        catch { episodeError = 'invalid_or_missing_episode' }
      }
      const now = this.#now()
      await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
        const current = database.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id = ?')
          .get<{ status: string }>(job.runId)
        if (current?.status === 'completed') return
        if (current?.status !== 'processing') throw new KiokukoError('CONFLICT', 'DSH memory finalization job is no longer claimed')
        const sourceRepositoryId = repositoryId(database, job.workspace)
        const scope = buildStructuredScope({
          visibility: 'project', retrievalScope: 'project-only', repositoryId: sourceRepositoryId,
        })
        const provenance: JsonObject = {
          type: 'dsh-session-finalization',
          reference: `dsh-session:${job.dshSessionId}?seq=${job.sourceStartSeq}-${job.sourceEndSeq}#sha256:${prepared.digest}`,
          sourceRepositoryId,
          sourceWorkspace: job.workspace,
          runId: job.runId,
          clientKind: 'dsh',
          timestamp: now,
        }
        const saved: EntryRecord[] = result.capsule.memories.map((memory) => recordEntryInTransaction(database, {
          workspace: job.workspace,
          kind: memory.kind,
          status: 'candidate',
          title: memory.title,
          body: memory.body,
          summary: memory.summary,
          scope,
          provenance,
          trustLevel: 'user_asserted',
          confidence: memory.confidence,
          tags: [...new Set(['dsh', 'session-finalization', ...memory.tags])],
          createdBy: 'kiokuko-dsh-finalizer',
          actor: 'kiokuko-dsh-finalizer',
        }, { now }))
        const link = database.prepare(`
          INSERT INTO dsh_memory_finalization_entries (run_id, entry_id, ordinal, created_at)
          VALUES (?, ?, ?, ?)
        `)
        saved.forEach((entry, ordinal) => link.run(job.runId, entry.id, ordinal, now))
        if (episode && evolutionSettings(database).mode !== 'off') {
          database.exec('SAVEPOINT evolution_episode')
          try {
            const evidence = [...(prepared.episodeEvidence ?? [])]
            saveEpisode(database, {
              runId: job.runId, workspace: job.workspace, sessionId: job.dshSessionId,
              start: job.sourceStartSeq, end: job.sourceEndSeq, logDigest: prepared.digest, outcome: job.outcome,
              evidenceDigest: supportingEvidenceDigest(episode, evidence),
              signature: episodeSignature(job.workspace, episode), draft: episode, evidence: evidenceReferences(evidence),
              sources: saved.map(e => ({ entryId: e.id, revision: e.revision, hash: e.contentHash })),
              ...episodeSignals(episode, evidence),
            }, now, evidence)
            scheduleEvolution(database, job.runId, { ...result.envelope, sessionId: job.dshSessionId }, now)
            database.exec('RELEASE evolution_episode')
          } catch {
            database.exec('ROLLBACK TO evolution_episode')
            database.exec('RELEASE evolution_episode')
            episodeError = 'episode_persistence_rejected'
          }
        }
        if (episodeError) database.prepare('UPDATE dsh_memory_finalizations SET episode_error=? WHERE run_id=?').run(episodeError, job.runId)
        database.prepare(`
          UPDATE dsh_memory_finalizations
             SET status = 'completed', log_event_count = ?,
                 log_digest = ?, capsule_hash = ?, capsule_bytes = ?, provider = ?, model = ?,
                 input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
                 completed_at = ?, updated_at = ?
           WHERE run_id = ? AND status = 'processing'
        `).run(
          prepared.eventCount,
          prepared.digest,
          canonicalContentHash(result.capsule),
          Buffer.byteLength(result.capsuleJson, 'utf8'),
          result.envelope.provider,
          result.envelope.model,
          result.usage.inputTokens ?? null,
          result.usage.outputTokens ?? null,
          result.usage.cacheReadTokens ?? null,
          result.usage.cacheWriteTokens ?? null,
          now,
          now,
          job.runId,
        )
      }))
      completed = true
      this.#evolutionWorker?.kick()
      try { await this.#onFinalized?.(job.dshSessionId) } catch { /* cache retention is non-vetoing */ }
    } catch (error) {
      if (error instanceof TransactionCommitUncertainError) {
        commitUncertain = true
        this.#lastDrainError = error
        return
      }
      const failure = boundedError(error)
      try {
        await this.#runtime.withDatabase((database) => {
          database.prepare(`
            UPDATE dsh_memory_finalizations
               SET status = 'failed', last_error_code = ?, last_error_message = ?, updated_at = ?
             WHERE run_id = ? AND status = 'processing'
          `).run(failure.code, failure.message, this.#now(), job.runId)
        })
      } catch (markError) {
        this.#lastDrainError = new AggregateError([error, markError], 'DSH memory finalization and failure recording both failed')
      }
    } finally {
      clearTimeout(timer)
      if (attempt.observation !== undefined) {
        const observation = { ...attempt.observation, usage: normalizeDshUsage(attempt.usage),
          status: completed ? 'completed' as const : commitUncertain ? 'unknown' as const : controller.signal.aborted ? 'cancelled' as const : 'failed' as const,
          durationMs: performance.now() - started }
        // Do not await optional sinks: telemetry must not delay native shutdown or retry.
        try { void Promise.resolve(this.#onObservation?.(observation)).catch(() => undefined) } catch { /* non-vetoing */ }
      }
      if (this.#abort === controller) this.#abort = undefined
    }
  }

  /** Stop accepting work, abort the current auxiliary call, and drain cleanup. */
  async dispose(): Promise<void> {
    this.#deep.abort()
    if (this.#closed) return
    this.#closed = true
    this.#abort?.abort(new KiokukoError('SERVICE_UNAVAILABLE', 'DSH memory finalizer is closing'))
    await this.#drain
    await this.#evolutionWorker?.dispose()
  }
}

/** Only native evidence is eligible; plugin snapshots and assistant assertions are excluded. */
export function episodeEvidenceForEvent(event: DshLogEvent, boundToolName?: string, proof?: EvolutionObservation): EpisodeEvidence | undefined {
  const data = record(event.data)
  if (!data || record(data.source)?.kind === 'plugin' || record(record(data.message)?.source)?.kind === 'plugin') return undefined
  const kind = event.type === 'user/message' ? 'user' : event.type === 'tool/call' ? 'action' : event.type === 'tool/result' ? 'result' : undefined
  if (!kind || kind === 'result' && boundToolName === undefined) return undefined
  // Memory/control tools must not recycle previous knowledge into new supporting evidence.
  if (/kiok|memory|recall|enno|memos|curator|task_prepare|task_context_read/i.test(String(boundToolName ?? data.name ?? ''))) return undefined
  const text = redactDshSourceText(eventText(event))
  if (!text || text.length > 4000) return undefined
  const execution = record(data.result) ?? record(data.meta) ?? record(record(data.message)?.output) ?? data
  const exitCode = execution.exitCode ?? execution.exit_code
  const content = record(data.message)?.content
  const toolError = Array.isArray(content) && content.some(block => record(block)?.type === 'tool-result' && record(block)?.isError === true)
  const outcome = kind !== 'result' ? 'unknown' : proof ? proof.failed ? 'failed' : 'passed' : toolError || record(data.error) !== undefined || execution.timedOut === true || execution.aborted === true || execution.signal !== undefined && execution.signal !== null || Number.isSafeInteger(exitCode) && exitCode !== 0
    ? 'failed' : exitCode === 0 ? 'passed' : 'unknown'
  return { seq: event.seq, kind, text, outcome }
}
