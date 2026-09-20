import { realpathSync } from 'node:fs'
import { canonicalContentHash } from '../../serialization/validate.js'
import { abortable } from '../http-json.js'
import type { DecisionService } from '../decisions/service.js'
import { COMPACTION_POLICY, type CompactionAgent, type CompactionAuthority, type CompactionOutcome, type CompactionSession, type NativeTokenMeter, type ResultCandidate, type ResultProjector, type SurfaceMessage } from './contracts.js'
import { activeCompaction, compactionBatch, CompactionFallback, compactionSurface, selectCandidates, surfaceDigest, surfaceMessage, worthwhile } from './policy.js'

interface Host { get(name: string, strict?: boolean): any; on(name: string, handler: (...args: any[]) => any, options?: any): () => void }
interface Step { agent: CompactionAgent; messages: readonly SurfaceMessage[]; signal: AbortSignal }
interface Registration { authority?: CompactionAuthority; dispose: () => void }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}

/** Owns only automatic step-boundary history projection, never manual/overflow compaction. */
export class SemanticCompactionCoordinator {
  private readonly lifetime = new AbortController()
  private readonly agents = new Map<CompactionAgent, Registration>()
  private readonly projectors = new Map<string, ResultProjector>()
  private readonly pending = new Set<Promise<void>>()
  private readonly resources = new Set<Promise<unknown>>()
  private readonly busy = new Set<CompactionSession>()
  private readonly failed = new WeakSet<CompactionSession>()
  private readonly routes = new WeakMap<CompactionAgent, { provider: string; model: string }>()
  private readonly disposeCreated: () => void
  private readonly disposeRemoved: () => void
  constructor(private readonly ctx: Host, private readonly decisions: DecisionService, private readonly root: string) {
    this.disposeCreated = ctx.on('agent/created', ({ agent }: { agent: CompactionAgent }) => this.attach(agent))
    this.disposeRemoved = ctx.on('agent/disposed', ({ agent }: { agent: CompactionAgent }) => {
      this.agents.get(agent)?.dispose()
      this.agents.delete(agent)
      this.routes.delete(agent)
    })
    for (const agent of ctx.get('agents', false)?.list?.() ?? []) this.attach(agent)
    this.supported()
  }
  private supported(): boolean {
    const meter = this.ctx.get('tokenMeter', false), compaction = this.ctx.get('compaction', false)
    const supported = !!(meter?.measure && meter.estimateMessage && compaction?.config && this.ctx.get('llm', false)?.resolveModelInfo)
    this.decisions.reportCompaction(supported, undefined, compaction?.config?.auto === true)
    return supported
  }
  /** Rebinding authority never installs a second handler on the same context. */
  attach(agent: CompactionAgent, authority?: CompactionAuthority): void {
    if (this.lifetime.signal.aborted || !agent?.ctx?.on) return
    const current = this.agents.get(agent)
    if (current) { if (authority) current.authority = authority; return }
    const registration: Registration = { ...(authority ? { authority } : {}), dispose: () => {} }
    const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
      const assembly = await next()
      this.recordRoute(agent, assembly.variables ?? {})
      return assembly
    }, { prepend: true })
    const disposeStep = agent.ctx.on('agent/pre-step', async (step: Step, next: () => Promise<unknown>) => {
      if (step.agent !== agent || this.lifetime.signal.aborted) return next()
      const operation = this.run(step, registration.authority)
      this.pending.add(operation)
      try { await operation } finally { this.pending.delete(operation) }
      return next()
    }, { prepend: true })
    registration.dispose = () => { disposeStep(); disposeAssembly() }
    this.agents.set(agent, registration)
  }
  registerProjector(tool: string, projector: ResultProjector): () => void {
    if (this.projectors.has(tool)) throw new Error('Duplicate semantic result projector')
    this.projectors.set(tool, projector)
    return () => { if (this.projectors.get(tool) === projector) this.projectors.delete(tool) }
  }
  /** Routing assembly precedes pre-step; its route may differ from the last logged request. */
  recordRoute(agent: CompactionAgent, variables: Record<string, string | undefined>): void {
    if (variables.provider && variables.model) this.routes.set(agent, { provider: variables.provider, model: variables.model })
    else this.routes.delete(agent)
  }
  private effectiveHeader(agent: CompactionAgent, session: CompactionSession) {
    const previous = session.requestHeader(), route = this.routes.get(agent)
    return route && previous ? { ...previous, config: { ...previous.config, ...route } } : previous
  }
  stop(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort(new Error('Semantic compaction stopped'))
    this.disposeCreated()
    this.disposeRemoved()
    for (const registration of this.agents.values()) registration.dispose()
    this.agents.clear()
    this.decisions.reportCompaction(false)
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending])
    await Promise.allSettled([...this.resources])
  }
  /** Cancellation ends the step promptly; database-bearing operations still drain on unload. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.resources.add(operation)
    void operation.then(() => this.resources.delete(operation), () => this.resources.delete(operation))
    return operation
  }

  private async ownership(agent: CompactionAgent, session: CompactionSession, authority?: CompactionAuthority): Promise<unknown> {
    if (agent.session !== session || this.ctx.get('agents', false)?.get(agent.id) !== agent
      || this.ctx.get('sessions', false)?.get(session.id) !== session || realpathSync(session.header.cwd) !== this.root) throw new Error('Semantic compaction ownership changed')
    if (authority) {
      const binding = await authority()
      if (binding === undefined) throw new CompactionFallback('unbound_agent')
      return binding
    }
    if (session.header.parentSession || session.header.origin === 'subagent' || session.header.delegationDepth) throw new CompactionFallback('unbound_child')
    return { sessionId: session.id, agentId: agent.id }
  }

  private async run(step: Step, authority?: CompactionAuthority): Promise<void> {
    const { agent } = step, session = agent.session
    if (!session || this.decisions.semanticCompaction.mode === 'off' || !this.supported()) return
    const native = this.ctx.get('compaction', false).config
    if (native.auto !== true || session.header.version !== 3 || this.busy.has(session) || this.failed.has(session)) return
    const started = performance.now(), deadline = new AbortController()
    const signal = AbortSignal.any([step.signal, this.lifetime.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), this.decisions.semanticCompaction.budgetMs)
    const meter = this.ctx.get('tokenMeter', false) as NativeTokenMeter
    let landed = 0, commitStarted = false, commitSeq = 0, beforeTokens: number | undefined
    const report = (outcome: CompactionOutcome['outcome'], reason: string, afterTokens?: number) => this.decisions.reportCompaction(!this.lifetime.signal.aborted,
      { outcome, reason, shortened: landed, elapsedMs: Math.round(performance.now() - started), ...(commitStarted ? { landedEvents: session.seq - commitSeq } : {}), ...(beforeTokens === undefined ? {} : { beforeTokens }), ...(afterTokens === undefined ? {} : { afterTokens }) })
    this.busy.add(session)
    try {
      signal.throwIfAborted()
      let root: string | undefined
      try { root = realpathSync(session.header.cwd) } catch { /* unavailable workspace is outside this coordinator */ }
      if (root !== this.root) { report('skipped', 'outside_workspace'); return }
      const owner = await abortable(this.track(this.ownership(agent, session, authority)), signal)
      if (activeCompaction(session)) throw new Error('Semantic compaction encountered active native compaction')
      const header = this.effectiveHeader(agent, session), route = header?.config
      if (!route?.provider || !route.model) throw new CompactionFallback('missing_route')
      const boundModel = (owner as { model?: { provider: string; model: string } })?.model
      if (boundModel && (boundModel.provider !== route.provider || boundModel.model !== route.model)) throw new Error('Semantic child model binding changed')
      const events = compactionSurface(session), seq = session.seq
      if (step.messages.some(message => !Array.isArray(message.content) || message.content.some(block => block.type !== 'text'))) throw new CompactionFallback('unsupported_pending_content')
      const configDigest = canonicalContentHash(native)
      const decisionConfig = this.decisions.configurationDigest()
      const measurement = meter.measure(session, header)
      const pendingTokens = step.messages.filter(message => !events.some(event => surfaceMessage(event)!.id === message.id)).reduce((sum, message) => sum + meter.estimateMessage(message), 0)
      beforeTokens = measurement.totalTokens + pendingTokens
      let model: any
      try { model = await abortable(this.ctx.get('llm', false).resolveModelInfo(route.provider, route.model, signal), signal) }
      catch (error) { if (signal.aborted) throw error; throw new CompactionFallback('model_metadata_unavailable') }
      const override = native.modelPolicies?.find((entry: any) => entry.provider === route.provider && entry.model === route.model)
      const ratio = override?.thresholdRatio ?? native.thresholdRatio
      const capacity = model?.context?.contextWindow
      const threshold = Math.floor(capacity * ratio)
      const retain = override?.retainTokens ?? (override?.retainRatio !== undefined ? Math.floor(capacity * override.retainRatio) : native.retainTokens ?? Math.floor(capacity * native.retainRatio))
      if (!Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1 || !Number.isSafeInteger(retain) || retain >= threshold) throw new CompactionFallback('unsupported_native_policy')
      if (beforeTokens < threshold) { report('skipped', 'low_pressure'); return }
      // A prune marker without its replacement may be the tail of a failed commit.
      // Never blindly retry that append sequence, including after reload.
      const pruned = new Set<number>()
      for (let index = 0; index < session.seq; index++) {
        const event = session.eventAt(index)
        if (event?.type === 'compaction/prune') for (const seq of event.data.shadowedSeqs ?? []) pruned.add(seq)
      }
      const candidates = selectCandidates(events, meter, this.projectors).filter(candidate => !pruned.has(candidate.event.seq))
      if (!worthwhile(beforeTokens, candidates.reduce((sum, candidate) => sum + candidate.savings, 0), threshold)) { report('skipped', 'insufficient_potential'); return }
      const digest = surfaceDigest(events, step.messages, { effective: header, logged: session.requestHeader() })
      const key = canonicalContentHash({ sessionId: session.id, digest, owner, configDigest, decisionConfig, policy: COMPACTION_POLICY })
      const outcome = await abortable(this.track(this.decisions.evaluate(`compaction:${session.id}:${key}`, compactionBatch(events, step.messages, candidates), signal, key)), signal)
      if (outcome.status !== 'completed') throw new CompactionFallback(outcome.reason)
      const accepted = new Set(outcome.result.answers.filter(answer => answer.status === 'selected' && answer.choiceId === 'shorten').map(answer => answer.id))
      const replacements = candidates.filter(candidate => accepted.has(candidate.id))
      const savings = replacements.reduce((sum, candidate) => sum + candidate.savings, 0)
      if (!worthwhile(beforeTokens, savings, threshold)) { report('fallback', 'insufficient_reduction'); return }
      const currentOwner = await abortable(this.track(this.ownership(agent, session, authority)), signal)
      signal.throwIfAborted()
      if (canonicalContentHash(owner) !== canonicalContentHash(currentOwner) || session.seq !== seq
        || surfaceDigest(compactionSurface(session), step.messages, { effective: this.effectiveHeader(agent, session), logged: session.requestHeader() }) !== digest
        || canonicalContentHash(this.ctx.get('compaction', false).config) !== configDigest
        || this.decisions.configurationDigest() !== decisionConfig
        || canonicalContentHash(meter.measure(session, header)) !== canonicalContentHash(measurement) || activeCompaction(session)) throw new Error('Semantic compaction source or authority changed')
      // Validate and freeze the entire set before the first append. No await within the commit.
      const prepared = replacements.map(candidate => this.prepare(session, candidate, meter))
      signal.throwIfAborted()
      if (performance.now() - started >= this.decisions.semanticCompaction.budgetMs) throw new CompactionFallback('budget_exceeded')
      commitStarted = true
      commitSeq = session.seq
      for (const replacement of prepared) {
        const expectedSeq = commitSeq + landed * 2
        const guard = (seq: number) => {
          signal.throwIfAborted()
          if (session.seq !== seq || agent.session !== session || this.ctx.get('agents', false)?.get(agent.id) !== agent
            || this.ctx.get('sessions', false)?.get(session.id) !== session || activeCompaction(session)) throw new Error('Semantic commit ownership or log changed')
        }
        guard(expectedSeq)
        replacement(() => guard(expectedSeq + 1))
        landed++
      }
      report('shortened', 'accepted', meter.measure(session, header).totalTokens + pendingTokens)
    } catch (error) {
      if (commitStarted) {
        this.failed.add(session)
        // Native append is committed before observers run. Count visible replacements
        // as well as returned appends if a host wrapper throws after an append.
        landed = session.surface.nodes.filter(seq => seq >= commitSeq && session.eventAt(seq)?.type === 'tool/result').length
        report('commit_failed', 'append_failure')
        throw new Error(`Semantic compaction commit failed after ${landed} confirmed replacements; inspect native history before retrying`, { cause: error })
      }
      if (step.signal.aborted || this.lifetime.signal.aborted) { report('cancelled', 'cancelled'); throw error }
      if (deadline.signal.aborted || error instanceof CompactionFallback) { report('fallback', error instanceof CompactionFallback ? error.message : 'budget_exceeded'); return }
      report('cancelled', 'integrity_failure')
      throw error
    } finally { clearTimeout(timer); this.busy.delete(session) }
  }

  private prepare(session: CompactionSession, candidate: ResultCandidate, meter: NativeTokenMeter): (afterPrune: () => void) => void {
    const seq = candidate.event.seq
    if (session.eventAt(seq) !== candidate.event || !session.surface.nodes.includes(seq)) throw new Error('Semantic replacement source disappeared')
    const message = freeze(structuredClone(candidate.replacement))
    const data = freeze(structuredClone({ ...candidate.event.data, message }))
    const shadowedTokenCount = meter.estimateMessage(candidate.original)
    return afterPrune => {
      session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount })
      afterPrune()
      if (session.eventAt(seq) !== candidate.event || !session.surface.nodes.includes(seq)) throw new Error('Semantic replacement source changed during append')
      session.append('tool/result', data, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
  }
}
