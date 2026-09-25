import { realpathSync } from 'node:fs'
import { z } from 'zod'
import { canonicalContentHash } from '../serialization/validate.js'
import { abortable } from './http-json.js'
import type { DecisionService } from './decisions/service.js'
import { activeCompaction, compactionBatch, compactionSurface, CompactionFallback, selectCandidates } from './semantic-compaction/policy.js'
import type { CompactionSession, NativeTokenMeter } from './semantic-compaction/contracts.js'

export const ModelHandoffConfig = z.object({
  mode: z.enum(['auto', 'off']).default('auto'),
  budgetMs: z.number().int().min(1).max(600000).default(30000),
}).strict()
export type ModelHandoffConfig = z.infer<typeof ModelHandoffConfig>
type Route = { provider: string; model: string; reasoningEffort?: string }
type Event = { type: string; seq: number; data: any; surfaceOp?: { op: string }; sourceEventSeqs?: readonly number[] }
type Session = CompactionSession & { snapshotEvents(): readonly Event[] }
type Agent = { id: string; session: Session; ctx?: { on(name: string, fn: (...args: any[]) => unknown, options?: unknown): () => void } }
type Host = { get(name: string, strict?: boolean): any; on(name: string, fn: (...args: any[]) => unknown): () => void }
type Outcome = { outcome: string; selectionSeq: number; classifierMs: number; summaryMs: number; savedTokens: number | null;
  classifierTokens: number | null; summaryTokens: number | null }
export type HandoffReceipt = { version: 1; selectionSeq: number; sourceDigest: string; compactionId: string; outcome: 'summarized' }
const POLICY = 'model-handoff-v1'

function route(value: unknown): Route | undefined {
  if (!value || typeof value !== 'object') return
  const item = value as Record<string, unknown>
  if (typeof item.provider !== 'string' || !item.provider || typeof item.model !== 'string' || !item.model) return
  return { provider: item.provider, model: item.model, ...(typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {}) }
}
function same(a: Route, b: Route): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}
/** Only the latest explicit selection after an effective request can initiate a handoff. */
export function pendingSelection(session: Session): { seq: number; from: Route; to: Route } | undefined {
  let effective: Route | undefined, selection: { seq: number; from: Route; to: Route } | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type === 'request/header') {
      effective = route(event.data?.header?.config)
      selection = undefined
    } else if (event.type === 'model/selection' && effective) {
      const next = route(event.data)
      if (next) selection = same(effective, next) ? undefined : { seq: event.seq, from: effective, to: next }
    }
  }
  return selection
}

/** Native selection and summary events are the durable, reloadable receipt. */
export function handoffReceipt(session: Session): HandoffReceipt | undefined {
  let selected: number | undefined, effective: Route | undefined, receipt: HandoffReceipt | undefined
  const events = session.snapshotEvents()
  for (const event of events) {
    if (event.type === 'request/header') { effective = route(event.data?.header?.config); selected = undefined }
    else if (event.type === 'model/selection') {
      const next = route(event.data)
      selected = next && effective && !same(next, effective) ? event.seq : undefined
    }
    else if (event.type === 'compaction/summary' && selected !== undefined && typeof event.data?.compactionId === 'string') {
      const id = event.data.compactionId
      if (!events.some(candidate => candidate.seq > event.seq && candidate.type === 'compaction/end'
        && candidate.data?.compactionId === id && !candidate.data?.error)
        || !events.some(candidate => candidate.seq > event.seq && candidate.type === 'user/message'
          && candidate.data?.source?.compactionId === id)) continue
      receipt = { version: 1, selectionSeq: selected, sourceDigest: canonicalContentHash({ policy: POLICY, selectionSeq: selected,
        source: event.data.shadowedSeqs?.map((seq: number) => events.find(source => source.seq === seq)),
        shadowedRange: event.data.shadowedRange }), compactionId: id, outcome: 'summarized' }
    }
  }
  return receipt
}

/** A prior shortening is durable progress; never reclassify it blindly after reload. */
export function prefilteredSelection(session: Session, selectionSeq: number): boolean {
  const events = session.snapshotEvents()
  const following = events.filter(event => event.seq > selectionSeq)
  const nextRequest = following.findIndex(event => event.type === 'request/header')
  const window = nextRequest < 0 ? following : following.slice(0, nextRequest)
  return window.some(event => event.type === 'compaction/prune' && event.data?.shadowedSeqs?.length === 1
    && window.some(replacement => replacement.seq > event.seq && replacement.type === 'tool/result'
      && replacement.surfaceOp?.op === 'replace' && replacement.sourceEventSeqs?.includes(event.data.shadowedSeqs[0])))
}

/** The native engine rejects any unbalanced range; this selector also pins recent work. */
export function handoffRange(session: Session): { start: number; end: number } | undefined {
  const nodes = session.surface.nodes
  const events = nodes.map(seq => session.eventAt(seq))
  const completed = events.flatMap((event, index) => event?.type === 'assistant/message' && event.data?.interrupted !== true ? [index] : [])
  if (completed.length < 3) return
  const recent = completed.at(-2)!
  let newestUser = -1
  for (let index = events.length - 1; index >= 0; index--) if (events[index]?.type === 'user/message' && events[index]?.data?.source?.kind === 'user') { newestUser = index; break }
  const endIndex = Math.min(recent, newestUser < 0 ? recent : newestUser) - 1
  const startIndex = events[0]?.type === 'system/message' ? 1 : 0
  if (endIndex <= startIndex) return
  // A call in the selected prefix whose result is outside it cannot be summarized safely.
  const calls = new Set<string>(), results = new Set<string>()
  for (let index = startIndex; index <= endIndex; index++) {
    const event = events[index]
    if (event?.type === 'assistant/message') for (const block of event.data?.message?.content ?? []) if (block.type === 'tool-call') calls.add(block.id)
    if (event?.type === 'tool/result') {
      const message = event.data?.message
      if (message?.role === 'tool' && message.source?.kind === 'tool' && message.toolCallId === message.source.callId)
        results.add(message.toolCallId)
      else for (const block of message?.content ?? []) if (block.type === 'tool-result') results.add(block.toolCallId)
    }
  }
  if ([...calls].some(id => !results.has(id)) || [...results].some(id => !calls.has(id))) return
  return { start: nodes[startIndex]!, end: nodes[endIndex]! }
}

/** Session history remains the source of truth; no separate handoff store is needed. */
export class ModelHandoff {
  private readonly config: ModelHandoffConfig
  private readonly disposers: (() => void)[] = []
  private readonly jobs = new Map<string, AbortController>()
  private readonly pending = new Set<Promise<void>>()
  private readonly agents = new Map<string, Agent>()
  private readonly active = new Map<string, { selectionSeq: number; signal: AbortSignal }>()
  private last: Outcome | null = null
  private stopped = false
  constructor(private readonly host: Host, private readonly decisions: DecisionService, private readonly root: string, input: z.input<typeof ModelHandoffConfig> = {}) {
    this.config = ModelHandoffConfig.parse(input)
    this.disposers.push(host.on('agent/created', ({ agent }: { agent: Agent }) => this.attach(agent)))
    this.disposers.push(host.on('agent/disposed', ({ agent }: { agent: Agent }) => { this.jobs.get(agent.session.id)?.abort(); this.agents.delete(agent.session.id) }))
    this.disposers.push(host.on('session/event', (session: Session, event: Event) => {
      if (event.type === 'model/selection') this.jobs.get(session.id)?.abort()
    }))
    this.disposers.push(host.on('llm/stream', (request: any, next: () => AsyncIterable<unknown>) => {
      if (request.purpose !== 'compaction') return next()
      const job = this.active.get(request.sessionId)
      if (!job) return next()
      return (async function* () {
        const iterator = next()[Symbol.asyncIterator]()
        try {
          for (;;) {
            const result = await abortable(iterator.next(), job.signal)
            job.signal.throwIfAborted()
            if (result.done) break
            yield result.value
          }
        } finally {
          if (job.signal.aborted && iterator.return) void iterator.return().catch(() => {})
        }
      })()
    }))
    for (const agent of host.get('agents', false)?.list?.() ?? []) this.attach(agent)
    decisions.reportModelHandoff(this.reportable())
  }
  private attach(agent: Agent): void {
    if (!agent?.session || !agent.ctx?.on || this.agents.has(agent.session.id)) return
    this.agents.set(agent.session.id, agent)
    const restored = handoffReceipt(agent.session)
    if (restored) this.report({ outcome: restored.outcome, selectionSeq: restored.selectionSeq, classifierMs: 0, summaryMs: 0,
      savedTokens: null, classifierTokens: null, summaryTokens: null })
    else {
      const pending = pendingSelection(agent.session)
      if (pending && prefilteredSelection(agent.session, pending.seq)) this.report({ outcome: 'prefiltered', selectionSeq: pending.seq,
        classifierMs: 0, summaryMs: 0, savedTokens: null, classifierTokens: null, summaryTokens: null })
    }
    this.disposers.push(agent.ctx.on('agent/pre-step', async (step: { agent: Agent; signal: AbortSignal }, next: () => Promise<unknown>) => {
      if (step.agent === agent && !this.stopped) {
        const signal = AbortSignal.any([step.signal, AbortSignal.timeout(this.config.budgetMs)])
        const operation = (async () => {
          // One superseding selection can arrive while the first summary is being cancelled.
          for (let attempt = 0; attempt < 2; attempt++) {
            const current = pendingSelection(agent.session)?.seq
            if (current === undefined || signal.aborted) break
            await this.prepare(agent, signal)
            if (pendingSelection(agent.session)?.seq === current) break
          }
        })()
        this.pending.add(operation)
        try { await operation } finally { this.pending.delete(operation) }
      }
      return next()
    }, { prepend: true }))
  }
  private reportable(): { mode: string; supported: boolean; last: Outcome | null } {
    const meter = this.host.get('tokenMeter', false)
    return { mode: this.config.mode, supported: !!this.host.get('compaction', false)?.compactRegion
      && !!meter?.measure && !!meter?.estimateMessage, last: this.last }
  }
  status(): { mode: string; supported: boolean; active: boolean; last: Outcome | null } {
    return (this.decisions.status() as { modelHandoff: ReturnType<ModelHandoff['status']> }).modelHandoff
  }
  stop(): void { if (this.stopped) return; this.stopped = true; for (const job of this.jobs.values()) job.abort(); for (const dispose of this.disposers.reverse()) dispose() }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]) }
  private report(outcome: Outcome): void { this.last = outcome; this.decisions.reportModelHandoff(this.reportable()) }
  private async prepare(agent: Agent, parent: AbortSignal): Promise<void> {
    const session = agent.session, selected = pendingSelection(session)
    if (!selected || this.config.mode === 'off' || session.header?.parentSession || session.header?.origin === 'subagent' || session.header?.delegationDepth) return
    try { if (realpathSync(session.header.cwd) !== this.root || this.host.get('agents', false)?.get(agent.id) !== agent || this.host.get('sessions', false)?.get(session.id) !== session) return } catch { return }
    // The native summary and checkpoint are the durable receipt. Both survive reload.
    if (handoffReceipt(session)?.selectionSeq === selected.seq) return
    if (prefilteredSelection(session, selected.seq)) {
      this.report({ outcome: 'prefiltered', selectionSeq: selected.seq, classifierMs: 0, summaryMs: 0,
        savedTokens: null, classifierTokens: null, summaryTokens: null })
      return
    }
    const range = handoffRange(session)
    if (!range) {
      this.report({ outcome: 'skipped', selectionSeq: selected.seq, classifierMs: 0, summaryMs: 0,
        savedTokens: null, classifierTokens: null, summaryTokens: null })
      return
    }
    if (!this.host.get('compaction', false)?.compactRegion) {
      this.report({ outcome: 'unavailable', selectionSeq: selected.seq, classifierMs: 0, summaryMs: 0,
        savedTokens: null, classifierTokens: null, summaryTokens: null })
      return
    }
    const sourceDigest = canonicalContentHash({ policy: POLICY, range, nodes: session.surface.nodes })
    const controller = new AbortController()
    const signal = AbortSignal.any([parent, controller.signal, AbortSignal.timeout(this.config.budgetMs)])
    this.jobs.set(session.id, controller)
    let classifierMs = 0, summaryMs = 0, savedTokens: number | null = null, outcome = 'skipped', shortened = 0, committing = false, integrityError = false
    let classifierTokens: number | null = null, summaryTokens: number | null = null
    const firstSeq = session.seq
    let expectedSeq = firstSeq
    let expectedNodes = [...session.surface.nodes]
    try {
      const readiness = await this.decisions.probe(AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      if (readiness.state !== 'ready' || !this.status().active) { outcome = 'unavailable'; return }
      const meter = this.host.get('tokenMeter', false) as NativeTokenMeter | undefined
      if (!meter?.measure || !meter.estimateMessage) { outcome = 'unavailable'; return }
      const before = meter.measure(session).totalTokens
      const old = compactionSurface(session)
      const startPosition = session.surface.nodes.indexOf(range.start), endPosition = session.surface.nodes.indexOf(range.end)
      const included = new Set(session.surface.nodes.slice(startPosition, endPosition + 1))
      const candidates = selectCandidates(old, meter, new Map(), seq => session.eventAt(seq))
        .filter(candidate => included.has(candidate.event.seq))
      if (candidates.length) {
        const decisionStart = performance.now()
        let choice: Awaited<ReturnType<DecisionService['evaluate']>> | undefined
        const classifierSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)])
        try {
          const batch = compactionBatch(old, [], candidates)
          choice = await this.decisions.evaluate(`handoff:${session.id}:${selected.seq}:${sourceDigest}`, { ...batch, purpose: 'model-handoff' }, classifierSignal)
        } catch (error) {
          if (signal.aborted) throw error
          if (!(error instanceof CompactionFallback) && !classifierSignal.aborted) { integrityError = true; throw error }
          // Admission failure or classifier timeout leaves the complete input for DSH.
        }
        classifierMs = Math.round(performance.now() - decisionStart)
        if (choice?.status === 'completed' && choice.result.usage) classifierTokens = choice.result.usage.input_tokens + choice.result.usage.output_tokens
        if (choice?.status === 'completed') {
          for (const candidate of candidates) {
            const answer = choice.result.answers.find(answer => answer.id === candidate.id)
            if (answer?.status !== 'selected' || answer.choiceId !== 'shorten') continue
            signal.throwIfAborted()
            if (pendingSelection(session)?.seq !== selected.seq || session.seq !== expectedSeq
              || canonicalContentHash(session.surface.nodes) !== canonicalContentHash(expectedNodes)
              || session.eventAt(candidate.event.seq) !== candidate.event
              || !session.surface.nodes.includes(candidate.event.seq)) { outcome = 'superseded'; return }
            const seq = candidate.event.seq
            committing = true
            session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: meter.estimateMessage(candidate.original) })
            session.append('tool/result', { ...candidate.event.data, message: candidate.replacement },
              { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
            expectedSeq = session.seq
            expectedNodes = [...session.surface.nodes]
            committing = false
            shortened++
          }
        }
      }
      signal.throwIfAborted()
      if (pendingSelection(session)?.seq !== selected.seq || session.seq !== expectedSeq
        || canonicalContentHash(session.surface.nodes) !== canonicalContentHash(expectedNodes)) { outcome = 'superseded'; return }
      const currentRange = handoffRange(session)
      if (!currentRange) { outcome = shortened ? 'prefiltered' : 'skipped'; return }
      this.active.set(session.id, { selectionSeq: selected.seq, signal })
      const summaryStart = performance.now()
      let result: any
      try { result = await this.host.get('compaction', false).compactRegion(currentRange.start, currentRange.end, agent, signal) }
      finally { summaryMs = Math.round(performance.now() - summaryStart) }
      if (result.usage) summaryTokens = result.usage.inputTokens + result.usage.outputTokens
      savedTokens = before - meter.measure(session).totalTokens
      if (!result.compactionId) throw new Error('Native compaction completed without an identity')
      outcome = 'summarized'
    } catch (error) {
      const partial = shortened || session.snapshotEvents().some(event => event.seq >= firstSeq && event.type === 'compaction/prune')
      outcome = committing || activeCompaction(session) ? 'commit_failed' : signal.aborted ? 'cancelled' : partial ? 'prefiltered_summary_failed' : 'summary_failed'
      if (outcome === 'commit_failed' || integrityError) throw error
    } finally {
      this.active.delete(session.id)
      if (this.jobs.get(session.id) === controller) this.jobs.delete(session.id)
      this.report({ outcome, selectionSeq: selected.seq, classifierMs, summaryMs, savedTokens,
        classifierTokens, summaryTokens })
    }
  }
}
