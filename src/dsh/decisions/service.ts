import { SemanticCompactionConfig, type SemanticCompactionConfiguration, type CompactionOutcome } from '../semantic-compaction/contracts.js'
import { evaluateCompactionBatches } from './compaction-batches.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { SqliteDatabase } from '../../db/adapter.js'
import { abortable } from '../http-json.js'
import { DecisionError, parseDecisionBatch, parseDecisionResult, questionType, type DecisionProvider, type DecisionBatchResult, type DecisionBatch } from './contracts.js'
import { TypedDecisionsConfig, selectedDecisionSettings, decisionConfigurationIssue, resolveDecisionConfiguration, LAYA_POLICY_VERSION, type DecisionConfiguration } from './config.js'
import { POLICY_VERSION } from './providers.js'
import { DecisionReadinessMonitor, type ReadinessOptions } from './readiness.js'
import { MemoryReuseConfig, type MemoryReuseConfiguration } from '../../memory/reuse.js'
import { evaluateMemoryBatches } from './memory-batches.js'
import { MemoryDecisionConcurrency } from './concurrency.js'
import type { DecisionSelectionStore } from './selection-store.js'

export type DecisionOutcome = { status: 'completed'; result: DecisionBatchResult } | { status: 'fallback'; reason: string }
export interface DecisionObservation { purpose: DecisionBatch['purpose']; questionTypes: Record<string, number>; provider: string; requestedModel: string | null;
  returnedModel: string | null; policyVersion: string; cacheHit: boolean; selected: number; measured: number; abstained: number;
  fallbackReason: string | null; elapsedMs: number; inputBytes: number; inputTokens: number | null; outputTokens: number | null;
  memoryCandidates?: { policy: string; attempted: number; applicable: number; excluded: number; uncertain: number; unassessed: number } }
export interface DecisionStore {
  binding?(id: string): Promise<DecisionConfiguration | undefined>
  bind(id: string, config: DecisionConfiguration): Promise<DecisionConfiguration>
  read(id: string, digest: string): Promise<DecisionOutcome | undefined>
  write(id: string, digest: string, result: DecisionOutcome): Promise<void>
}
/** Store only bounded results and configuration; request evidence is represented by a digest. */
export function databaseDecisionStore(runtime: { withDatabase<T>(operation: (db: SqliteDatabase) => T): Promise<T> }): DecisionStore {
  return {
    binding: id => runtime.withDatabase(db => {
      const row = db.prepare('SELECT config_json,config_digest FROM dsh_decision_bindings WHERE request_id=?').get(id)
      if (!row) return undefined
      const config = TypedDecisionsConfig.parse(JSON.parse(String(row.config_json)))
      if (canonicalContentHash(config) !== row.config_digest) throw new Error('Decision configuration integrity mismatch')
      return config
    }),
    bind: (id, config) => runtime.withDatabase(db => {
      db.prepare('INSERT OR IGNORE INTO dsh_decision_bindings VALUES (?,?,?)').run(id, JSON.stringify(config), canonicalContentHash(config))
      const row = db.prepare('SELECT config_json,config_digest FROM dsh_decision_bindings WHERE request_id=?').get(id)!
      const stored = TypedDecisionsConfig.parse(JSON.parse(String(row.config_json)))
      if (canonicalContentHash(stored) !== row.config_digest) throw new Error('Decision configuration integrity mismatch')
      return stored
    }),
    read: (id, digest) => runtime.withDatabase(db => {
      const row = db.prepare('SELECT result_json FROM dsh_decision_results WHERE request_id=? AND input_digest=?').get(id, digest)
      return row ? JSON.parse(String(row.result_json)) as DecisionOutcome : undefined
    }),
    write: (id, digest, outcome) => runtime.withDatabase(db => { db.prepare('INSERT OR IGNORE INTO dsh_decision_results VALUES (?,?,?)').run(id, digest, JSON.stringify(outcome)) }),
  }
}
export class DecisionService {
  private readonly baseConfig: DecisionConfiguration
  private initialization?: Promise<void>
  private selectionRevision = 0
  private switching = false
  readonly memoryReuse: MemoryReuseConfiguration
  readonly semanticCompaction: SemanticCompactionConfiguration
  private readonly compactionMetrics = { calls: 0, inputBytes: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, usageReports: 0 }
  private readonly decisionObservations: DecisionObservation[] = []
  private observationStatus: unknown = null
  private answerReviewStatus: unknown = { mode: 'off', state: 'idle', reason: null }
  private modelHandoffStatus: { mode: string; supported: boolean; last: unknown } = { mode: 'off', supported: false, last: null }
  reportModelHandoff(status: { mode: string; supported: boolean; last: unknown }): void { this.modelHandoffStatus = status }
  reportAnswerReview(status: unknown): void { this.answerReviewStatus = status }
  reportObservationPack(mode: string, metrics: Record<string, number>): void { this.observationStatus = { mode, metrics } }
  private lastPreemptive: CompactionOutcome | null = null
  private compactionStatus: { supported: boolean; nativeAuto: boolean; last: CompactionOutcome | null } = { supported: false, nativeAuto: false, last: null }
  reportCompaction(supported: boolean, last?: CompactionOutcome, nativeAuto = this.compactionStatus.nativeAuto): void { this.compactionStatus = { supported, nativeAuto, last: last ?? this.compactionStatus.last }; if (last?.trigger === 'todo_boundary') this.lastPreemptive = last }
  private readonly readiness: DecisionReadinessMonitor
  private readonly memoryConcurrency = new MemoryDecisionConcurrency()
  private readonly bindings = new Map<string, Promise<DecisionConfiguration>>()
  private readonly results = new Map<string, DecisionOutcome>()
  private readonly pending = new Map<string, Promise<DecisionOutcome>>()
  private lastFallback: string | null = null
  constructor(private config: DecisionConfiguration, private readonly provider: (config: DecisionConfiguration) => DecisionProvider, private readonly store?: DecisionStore,
    private readonly options: ReadinessOptions & { memoryReuse?: MemoryReuseConfiguration; semanticCompaction?: SemanticCompactionConfiguration; repositoryRoot?: string;
      selectionStore?: DecisionSelectionStore; resolveConfiguration?: (config: DecisionConfiguration, signal: AbortSignal) => Promise<DecisionConfiguration>;
      onEvaluation?: (observation: DecisionObservation) => void } = {}) {
    this.config = resolveDecisionConfiguration(config, options.repositoryRoot ?? process.cwd())
    this.baseConfig = structuredClone(this.config)
    this.memoryReuse = MemoryReuseConfig.parse(options.memoryReuse ?? {})
    this.semanticCompaction = SemanticCompactionConfig.parse(options.semanticCompaction ?? {})
    this.readiness = new DecisionReadinessMonitor(config => this.memoryProvider(config), options)
  }
  private memoryProvider(config: DecisionConfiguration): DecisionProvider {
    const provider = this.provider(config)
    return { capabilities: provider.capabilities,
      ...(provider.preflight ? { preflight: (batch: Parameters<DecisionProvider['evaluate']>[0], signal: AbortSignal) => this.memoryConcurrency.run(signal, () => abortable(provider.preflight!(batch, signal), signal)) } : {}),
      evaluate: (batch, signal) => this.memoryConcurrency.run(signal,
      async () => {
        if (batch.purpose !== 'compaction') return abortable(provider.evaluate(batch, signal), signal)
        const started = performance.now(); this.compactionMetrics.calls++; this.compactionMetrics.inputBytes += Buffer.byteLength(JSON.stringify(batch))
        try {
          const result = await abortable(provider.evaluate(batch, signal), signal)
          if (result.usage) { this.compactionMetrics.usageReports++; this.compactionMetrics.inputTokens += result.usage.input_tokens; this.compactionMetrics.outputTokens += result.usage.output_tokens }
          return result
        } finally { this.compactionMetrics.elapsedMs += Math.round(performance.now() - started) }
      }) }
  }
  initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      const selected = await this.options.selectionStore?.load()
      if (selected) { this.config = selected.config; this.selectionRevision = selected.revision }
    })()
  }
  private async resolved(config: DecisionConfiguration, signal: AbortSignal): Promise<DecisionConfiguration> {
    if (config.provider !== 'laya-coreml' || !decisionConfigurationIssue(config)) return structuredClone(config)
    return this.options.resolveConfiguration ? abortable(this.options.resolveConfiguration(config, signal), signal) : structuredClone(config)
  }
  async probe(signal: AbortSignal, force = false) {
    await this.initialize()
    const current = this.config
    try {
      const resolved = await this.resolved(current, signal)
      if (this.config === current) this.config = resolved
      return await this.readiness.probe(resolved, signal, force)
    } catch (error) {
      if (signal.aborted) throw new DecisionError('CANCELLED')
      if (!(error instanceof DecisionError)) throw error
      this.lastFallback = error.code
      return { state: 'unavailable' as const, reason: error.code, checkedAt: null }
    }
  }
  /** Probe the configuration already bound to this logical request. */
  async probeBound(requestId: string, signal: AbortSignal) {
    const config = await this.bind(requestId, signal)
    if (config.mode !== 'auto' || !['typesafe', 'laya-coreml'].includes(config.provider))
      return { state: 'unconfigured' as const, reason: 'decision_off', checkedAt: null }
    return this.readiness.probe(config, signal)
  }
  async modelRoutingAvailable(requestId: string, signal: AbortSignal): Promise<boolean> {
    const config = await this.bind(requestId, signal)
    return config.mode === 'auto' && (config.provider === 'typesafe' || config.provider === 'laya-coreml')
  }
  async inspectStatus(signal: AbortSignal) { await this.initialize(); await this.readiness.inspect(this.config, signal); return this.status() }
  /** Verify before publishing the new selection. Existing request snapshots are never rewritten. */
  async selectProvider(provider: DecisionConfiguration['provider'] | 'default', signal: AbortSignal): Promise<void> {
    if (this.switching) throw new DecisionError('UNAVAILABLE')
    this.switching = true
    const parent = signal
    const budget = AbortSignal.timeout(selectedDecisionSettings({ ...this.baseConfig, provider: provider === 'default' ? this.baseConfig.provider : provider })?.timeoutMs ?? 5000)
    signal = AbortSignal.any([parent, budget])
    try {
      await this.initialize()
      if (signal.aborted) throw new DecisionError('CANCELLED')
      const candidate = structuredClone(this.baseConfig)
      if (provider !== 'default') { candidate.provider = provider; candidate.mode = 'auto' }
      const config = await this.resolved(candidate, signal)
      if (config.mode !== 'off') {
        const readiness = await this.readiness.probe(config, signal, true)
        if (readiness.state !== 'ready') throw new DecisionError(readiness.reason === 'missing_credential' || readiness.reason === 'DECISION_AUTH' ? 'AUTH' : 'UNAVAILABLE')
      }
      if (signal.aborted) throw new DecisionError('CANCELLED')
      const revision = await this.options.selectionStore?.save(config, this.selectionRevision, signal)
      // The storage callback checks cancellation before commit. Reflect a committed selection even if the caller cancels afterward.
      this.config = config
      if (revision !== undefined) this.selectionRevision = revision
      this.lastFallback = null
    } catch (error) {
      if (parent.aborted) throw new DecisionError('CANCELLED')
      if (budget.aborted) throw new DecisionError('TIMEOUT')
      throw error
    } finally { this.switching = false }
  }
  invalidateReadiness(): void { this.readiness.invalidate() }
  configurationDigest(): string { return canonicalContentHash({ config: this.config, semanticCompaction: this.semanticCompaction, policyVersion: POLICY_VERSION }) }
  async skillSelection(requestId: string, signal: AbortSignal): Promise<DecisionConfiguration['skillSelection']> { return (await this.bind(requestId, signal)).skillSelection }
  private observe(batch: DecisionBatch, config: DecisionConfiguration, outcome: DecisionOutcome, cacheHit: boolean, elapsedMs: number,
    memoryCandidateTotal?: number): void {
    const answers = outcome.status === 'completed' ? outcome.result.answers : []
    const selection = config.memorySelection ?? { mode: 'choice' as const }
    const memoryCandidates = batch.purpose === 'memory-reuse' ? {
      policy: selection.mode === 'noul' ? selection.policyVersion : 'memory-reuse-v1',
      attempted: selection.mode === 'noul' ? Math.floor(batch.questions.length / 3) : batch.questions.length,
      applicable: 0, excluded: 0, uncertain: 0, unassessed: 0,
    } : undefined
    if (memoryCandidates && outcome.status === 'completed') {
      if (Number.isSafeInteger(memoryCandidateTotal) && memoryCandidateTotal! >= memoryCandidates.attempted)
        memoryCandidates.unassessed = memoryCandidateTotal! - memoryCandidates.attempted
      if (selection.mode === 'noul') for (let index = 0; index < answers.length; index += 3) {
        const group = answers.slice(index, index + 3)
        if (group.every(answer => answer?.status === 'abstained' && answer.reason === 'unassessed')) memoryCandidates.unassessed++
        else if (group.some(answer => answer?.status === 'measured' && answer.type === 'noul' && answer.probability <= selection.rejectProbability)) memoryCandidates.excluded++
        else if (group.every(answer => answer?.status === 'measured' && answer.type === 'noul' && answer.probability >= selection.acceptProbability)) memoryCandidates.applicable++
        else memoryCandidates.uncertain++
      }
      else for (const answer of answers) {
        if (answer.status === 'abstained' && answer.reason === 'unassessed') memoryCandidates.unassessed++
        else if (answer.status === 'selected' && answer.choiceId === 'applicable') memoryCandidates.applicable++
        else if (answer.status === 'selected' && answer.choiceId === 'not_applicable') memoryCandidates.excluded++
        else memoryCandidates.uncertain++
      }
    }
    const observation: DecisionObservation = {
      purpose: batch.purpose, questionTypes: Object.fromEntries(['choice', 'noul', 'score'].map(type => [type, batch.questions.filter(q => questionType(q) === type).length])),
      provider: config.provider, requestedModel: outcome.status === 'completed' ? outcome.result.requestedModel : selectedDecisionSettings(config)?.model ?? null,
      returnedModel: outcome.status === 'completed' ? outcome.result.returnedModel ?? null : null,
      policyVersion: outcome.status === 'completed' ? outcome.result.policyVersion : batch.contractVersion ?? POLICY_VERSION,
      cacheHit, selected: answers.filter(a => a.status === 'selected').length, measured: answers.filter(a => a.status === 'measured').length,
      abstained: answers.filter(a => a.status === 'abstained').length, fallbackReason: outcome.status === 'fallback' ? outcome.reason : null,
      elapsedMs: Math.round(elapsedMs), inputBytes: Buffer.byteLength(JSON.stringify(batch)),
      inputTokens: cacheHit ? null : outcome.status === 'completed' ? outcome.result.usage?.input_tokens ?? null : null,
      outputTokens: cacheHit ? null : outcome.status === 'completed' ? outcome.result.usage?.output_tokens ?? null : null,
      ...(memoryCandidates ? { memoryCandidates } : {}),
    }
    this.decisionObservations.push(observation)
    if (this.decisionObservations.length > 128) this.decisionObservations.shift()
    try { this.options.onEvaluation?.(structuredClone(observation)) } catch { /* Observation cannot change a decision. */ }
  }
  async bind(requestId: string, signal = new AbortController().signal): Promise<DecisionConfiguration> {
    if (!requestId || requestId.length > 512) throw new Error('Invalid decision request identity')
    await this.initialize()
    let binding = this.bindings.get(requestId)
    if (!binding) {
      const current = this.config
      binding = (async () => {
        const existing = await this.store?.binding?.(requestId)
        if (existing) return existing
        let config = structuredClone(current)
        // Only a new binding gets a materialized default. An older stored binding
        // without this field continues to mean Choice after restart or aliasing.
        config.memorySelection ??= { mode: 'choice' }
        const memorySelection = config.memorySelection
        if (config.provider === 'laya-coreml' && decisionConfigurationIssue(config) === 'missing_laya_model_or_fingerprint') {
          try { config = await this.resolved(config, signal); if (this.config === current) this.config = config }
          catch (error) { if (signal.aborted) throw new DecisionError('CANCELLED'); if (!(error instanceof DecisionError)) throw error; this.lastFallback = error.code }
        }
        config.memorySelection = memorySelection
        if (signal.aborted) throw new DecisionError('CANCELLED')
        return this.store ? this.store.bind(requestId, config) : config
      })()
      this.bindings.set(requestId, binding)
      const pending = binding
      void pending.catch(() => { if (this.bindings.get(requestId) === pending) this.bindings.delete(requestId) })
    }
    try { return structuredClone(await abortable(binding, signal)) }
    catch (error) { if (signal.aborted) throw new DecisionError('CANCELLED'); throw error }
  }
  async alias(requestId: string, sourceId: string): Promise<void> {
    const config = await this.bind(sourceId)
    if (!this.bindings.has(requestId)) this.bindings.set(requestId, this.store ? this.store.bind(requestId, config) : Promise.resolve(config))
    await this.bindings.get(requestId)
  }
  status(): unknown {
    const selected = selectedDecisionSettings(this.config)
    return { mode: this.config.mode, provider: this.config.provider, model: selected?.model ?? null, timeoutMs: selected?.timeoutMs ?? null,
      configurationReady: !decisionConfigurationIssue(this.config),
      ...(this.config.provider === 'laya-coreml' ? { protocol: this.config['laya-coreml']?.protocol ?? (this.config['laya-coreml']?.runtimeFingerprint ? 'strict-v1' : null), runtimeFingerprint: this.config['laya-coreml']?.runtimeFingerprint ?? null } : {}),
      limits: this.provider(this.config).capabilities, acceptance: selected?.acceptance ?? null, policyVersion: this.config.provider === 'laya-coreml' ? LAYA_POLICY_VERSION : POLICY_VERSION, lastFallback: this.lastFallback,
      observationPack: this.observationStatus,
      answerReview: this.answerReviewStatus,
      modelHandoff: { ...this.modelHandoffStatus, active: this.modelHandoffStatus.mode === 'auto' && this.modelHandoffStatus.supported
        && this.config.mode !== 'off' && ['typesafe', 'laya-coreml'].includes(this.config.provider) && this.readiness.status(this.config).state === 'ready' },
      semanticCompaction: { ...this.semanticCompaction, ...this.compactionStatus, metrics: this.compactionMetrics, lastPreemptive: this.lastPreemptive, preemptiveActive: this.semanticCompaction.preemptive && this.semanticCompaction.mode === 'auto' && this.compactionStatus.supported && this.compactionStatus.nativeAuto && this.config.mode !== 'off' && this.readiness.status(this.config).state === 'ready', active: this.semanticCompaction.mode === 'auto' && this.compactionStatus.supported && this.compactionStatus.nativeAuto && this.config.mode !== 'off' && this.readiness.status(this.config).state === 'ready' },
      readiness: this.readiness.status(this.config), memoryReuse: { ...this.memoryReuse, active: this.memoryReuse.mode === 'auto' && this.readiness.status(this.config).state === 'ready' },
      decisionObservations: structuredClone(this.decisionObservations) }
  }
  async evaluate(requestId: string, input: unknown, signal: AbortSignal, catalogDigest = '', memoryCandidateTotal?: number): Promise<DecisionOutcome> {
    const started = performance.now()
    if (signal.aborted) throw new DecisionError('CANCELLED')
    const config = await this.bind(requestId, signal)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    let batch
    try { batch = parseDecisionBatch(input) } catch (error) {
      if (!(error instanceof DecisionError)) throw error
      return { status: 'fallback', reason: error.code }
    }
    const semantic = batch.purpose === 'compaction' || batch.purpose === 'model-handoff'
    const managed = semantic || batch.purpose === 'memory-reuse' || batch.purpose === 'model-routing'
    const digest = canonicalContentHash({ batch, config, catalogDigest, policyVersion: batch.contractVersion ?? POLICY_VERSION,
      ...(batch.purpose === 'compaction' ? { semanticCompaction: this.semanticCompaction } : {}) })
    const key = `${requestId}:${digest}`
    const cached = this.results.get(key) ?? await this.store?.read(requestId, digest)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    if (cached) {
      if (cached.status === 'completed') parseDecisionResult(cached.result, batch)
      else if (cached.status !== 'fallback' || typeof cached.reason !== 'string') throw new Error('Decision result integrity mismatch')
      if (semantic || batch.purpose === 'model-routing') {
        if ((batch.purpose === 'compaction' && this.semanticCompaction.mode === 'off') || config.mode === 'off') return { status: 'fallback', reason: 'DECISION_UNAVAILABLE' }
        const budget = AbortSignal.any([signal, AbortSignal.timeout(batch.purpose === 'model-handoff' || batch.purpose === 'model-routing' ? 5000 : this.semanticCompaction.budgetMs)])
        try {
          if ((await this.readiness.probe(config, budget)).state !== 'ready') return { status: 'fallback', reason: 'DECISION_UNAVAILABLE' }
        } catch (error) {
          if (signal.aborted) throw new DecisionError('CANCELLED')
          if (!budget.aborted && !(error instanceof DecisionError)) throw error
          return { status: 'fallback', reason: budget.aborted ? 'DECISION_TIMEOUT' : (error as DecisionError).code }
        }
      }
      this.observe(batch, config, cached, true, performance.now() - started, memoryCandidateTotal)
      return structuredClone(cached)
    }
    const existing = this.pending.get(key)
    if (existing) return abortable(existing, signal)
    const operation = (async (): Promise<DecisionOutcome> => {
      const timeout = new AbortController(), timeoutMs = selectedDecisionSettings(config)?.timeoutMs ?? 5000
      const timer = setTimeout(() => timeout.abort(), managed ? Math.min(timeoutMs,
        batch.purpose === 'model-handoff' || batch.purpose === 'model-routing' ? 5000 : semantic ? this.semanticCompaction.budgetMs : this.memoryReuse.budgetMs) : timeoutMs)
      const combined = AbortSignal.any([signal, timeout.signal])
      let outcome: DecisionOutcome
      try {
        if (decisionConfigurationIssue(config)) throw new DecisionError('UNAVAILABLE')
        const provider = managed ? this.memoryProvider(config) : this.provider(config), limits = provider.capabilities
        if (!Number.isSafeInteger(limits.maxQuestions) || limits.maxQuestions < 1) throw new DecisionError('UNSUPPORTED')
        if (batch.questions.some(q => !(limits.questionTypes ?? ['choice']).includes(questionType(q)))) throw new DecisionError('UNSUPPORTED')
        if (batch.questions.some(q => 'type' in q && q.type === 'score' && (!limits.maxScoreLevels || q.criteria.length > limits.maxScoreLevels))) throw new DecisionError('UNSUPPORTED')
        if (batch.questions.some(q => 'choices' in q && q.choices.length > limits.maxChoices) || Buffer.byteLength(JSON.stringify(batch)) > limits.maxBytes) throw new DecisionError('TOO_LARGE')
        if (managed) {
          if ((batch.purpose === 'compaction' ? this.semanticCompaction : batch.purpose === 'model-handoff' || batch.purpose === 'model-routing' ? { mode: 'auto' } : this.memoryReuse).mode === 'off') throw new DecisionError('UNAVAILABLE')
          const ready = await this.readiness.probe(config, combined)
          if (ready.state !== 'ready') throw new DecisionError(ready.reason === 'DECISION_AUTH' || ready.reason === 'missing_credential' ? 'AUTH' : 'UNAVAILABLE')
        }
        const parts: DecisionBatchResult[] = []
        // Each question is independent and retains the complete evidence and its alternatives.
        if (semantic) parts.push(...await evaluateCompactionBatches(provider, batch, combined))
        else if (batch.purpose === 'memory-reuse') parts.push(await evaluateMemoryBatches(provider, batch, config.provider, combined))
        else {
          if (batch.purpose === 'answer-review' && provider.preflight) {
            for (let offset = 0; offset < batch.questions.length; offset += limits.maxQuestions) {
              await abortable(provider.preflight({ ...batch, questions: batch.questions.slice(offset, offset + limits.maxQuestions) }, combined), combined)
            }
          }
          for (let offset = 0; offset < batch.questions.length; offset += limits.maxQuestions) {
          combined.throwIfAborted()
          const part = { ...batch, questions: batch.questions.slice(offset, offset + limits.maxQuestions) }
          parts.push(parseDecisionResult(await abortable(provider.evaluate(part, combined), combined), part))
          }
        }
        combined.throwIfAborted()
        const first = parts[0]!
        if (parts.some(p => p.provider !== first.provider || p.requestedModel !== first.requestedModel || p.returnedModel !== first.returnedModel || p.revision !== first.revision || p.policyVersion !== first.policyVersion)) throw new DecisionError('MALFORMED_RESPONSE')
        const result = { ...first, answers: parts.flatMap(p => p.answers) }
        delete result.usage
        if (parts.every(p => p.usage)) result.usage = parts.reduce((sum, p) => ({ input_tokens: sum.input_tokens + p.usage!.input_tokens, output_tokens: sum.output_tokens + p.usage!.output_tokens }), { input_tokens: 0, output_tokens: 0 })
        outcome = { status: 'completed', result: parseDecisionResult(result, batch) }
      } catch (error) {
        if (signal.aborted || error instanceof DecisionError && error.kind === 'CANCELLED' && !timeout.signal.aborted) throw new DecisionError('CANCELLED')
        if (!timeout.signal.aborted && !(error instanceof DecisionError)) throw error
        const reason = timeout.signal.aborted ? 'DECISION_TIMEOUT' : (error as DecisionError).code
        const wasReady = this.readiness.status(config).state === 'ready'
        if (reason === 'DECISION_AUTH' && (wasReady || !managed)) this.invalidateReadiness()
        if (managed && !['DECISION_TOO_LARGE', 'DECISION_INVALID_INPUT', 'DECISION_CANCELLED', 'DECISION_UNSUPPORTED'].includes(reason)
          && (wasReady || reason === 'DECISION_TIMEOUT')) this.readiness.failed(config, reason)
        this.lastFallback = reason
        outcome = { status: 'fallback', reason }
      } finally { clearTimeout(timer) }
      if (signal.aborted) throw new DecisionError('CANCELLED')
      await this.store?.write(requestId, digest, outcome)
      if (signal.aborted) throw new DecisionError('CANCELLED')
      this.results.set(key, structuredClone(outcome))
      this.observe(batch, config, outcome, false, performance.now() - started, memoryCandidateTotal)
      return outcome
    })()
    this.pending.set(key, operation)
    try { return await operation } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
  }
}
