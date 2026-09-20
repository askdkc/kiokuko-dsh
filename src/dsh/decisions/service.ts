import { canonicalContentHash } from '../../serialization/validate.js'
import type { SqliteDatabase } from '../../db/adapter.js'
import { abortable } from '../http-json.js'
import { DecisionError, parseDecisionBatch, parseDecisionResult, type DecisionProvider, type DecisionBatchResult } from './contracts.js'
import { TypedDecisionsConfig, type DecisionConfiguration } from './config.js'
import { POLICY_VERSION } from './providers.js'
import { DecisionReadinessMonitor, type ReadinessOptions } from './readiness.js'
import { MemoryReuseConfig, type MemoryReuseConfiguration } from '../../memory/reuse.js'
import { evaluateMemoryBatches } from './memory-batches.js'
import { MemoryDecisionConcurrency } from './concurrency.js'

export type DecisionOutcome = { status: 'completed'; result: DecisionBatchResult } | { status: 'fallback'; reason: string }
export interface DecisionStore {
  bind(id: string, config: DecisionConfiguration): Promise<DecisionConfiguration>
  read(id: string, digest: string): Promise<DecisionOutcome | undefined>
  write(id: string, digest: string, result: DecisionOutcome): Promise<void>
}
/** Store only bounded results and configuration; request evidence is represented by a digest. */
export function databaseDecisionStore(runtime: { withDatabase<T>(operation: (db: SqliteDatabase) => T): Promise<T> }): DecisionStore {
  return {
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
  readonly memoryReuse: MemoryReuseConfiguration
  private readonly readiness: DecisionReadinessMonitor
  private readonly memoryConcurrency = new MemoryDecisionConcurrency()
  private readonly bindings = new Map<string, Promise<DecisionConfiguration>>()
  private readonly results = new Map<string, DecisionOutcome>()
  private readonly pending = new Map<string, Promise<DecisionOutcome>>()
  private lastFallback: string | null = null
  constructor(private readonly config: DecisionConfiguration, private readonly provider: (config: DecisionConfiguration) => DecisionProvider, private readonly store?: DecisionStore,
    options: ReadinessOptions & { memoryReuse?: MemoryReuseConfiguration } = {}) {
    this.memoryReuse = MemoryReuseConfig.parse(options.memoryReuse ?? {})
    this.readiness = new DecisionReadinessMonitor(config => this.memoryProvider(config), options)
  }
  private memoryProvider(config: DecisionConfiguration): DecisionProvider {
    const provider = this.provider(config)
    return { capabilities: provider.capabilities, evaluate: (batch, signal) => this.memoryConcurrency.run(signal,
      () => abortable(provider.evaluate(batch, signal), signal)) }
  }
  probe(signal: AbortSignal, force = false) { return this.readiness.probe(this.config, signal, force) }
  async inspectStatus(signal: AbortSignal) { await this.readiness.inspect(this.config, signal); return this.status() }
  invalidateReadiness(): void { this.readiness.invalidate() }
  async bind(requestId: string): Promise<DecisionConfiguration> {
    if (!requestId || requestId.length > 512) throw new Error('Invalid decision request identity')
    let binding = this.bindings.get(requestId)
    if (!binding) { binding = this.store ? this.store.bind(requestId, this.config) : Promise.resolve(structuredClone(this.config)); this.bindings.set(requestId, binding) }
    return binding
  }
  async alias(requestId: string, sourceId: string): Promise<void> {
    const config = await this.bind(sourceId)
    if (!this.bindings.has(requestId)) this.bindings.set(requestId, this.store ? this.store.bind(requestId, config) : Promise.resolve(config))
    await this.bindings.get(requestId)
  }
  status(): unknown {
    const selected = this.config[this.config.provider]
    return { mode: this.config.mode, provider: this.config.provider, model: selected.model ?? null, timeoutMs: selected.timeoutMs,
      configurationReady: this.config.mode !== 'off' && (this.config.provider !== 'nimble' || Boolean(this.config.nimble.endpoint && this.config.nimble.model)),
      limits: this.provider(this.config).capabilities, acceptance: selected.acceptance, policyVersion: POLICY_VERSION, lastFallback: this.lastFallback,
      readiness: this.readiness.status(this.config), memoryReuse: { ...this.memoryReuse, active: this.memoryReuse.mode === 'auto' && this.readiness.status(this.config).state === 'ready' } }
  }
  async evaluate(requestId: string, input: unknown, signal: AbortSignal, catalogDigest = ''): Promise<DecisionOutcome> {
    if (signal.aborted) throw new DecisionError('CANCELLED')
    const config = await this.bind(requestId)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    let batch
    try { batch = parseDecisionBatch(input) } catch (error) {
      if (!(error instanceof DecisionError)) throw error
      return { status: 'fallback', reason: error.code }
    }
    const digest = canonicalContentHash({ batch, config, catalogDigest, policyVersion: POLICY_VERSION })
    const key = `${requestId}:${digest}`
    const cached = this.results.get(key) ?? await this.store?.read(requestId, digest)
    if (signal.aborted) throw new DecisionError('CANCELLED')
    if (cached) {
      if (cached.status === 'completed') parseDecisionResult(cached.result, batch)
      else if (cached.status !== 'fallback' || typeof cached.reason !== 'string') throw new Error('Decision result integrity mismatch')
      return structuredClone(cached)
    }
    const existing = this.pending.get(key)
    if (existing) return abortable(existing, signal)
    const operation = (async (): Promise<DecisionOutcome> => {
      const timeout = new AbortController(), selected = config[config.provider]
      const timer = setTimeout(() => timeout.abort(), batch.purpose === 'memory-reuse' ? Math.min(selected.timeoutMs, this.memoryReuse.budgetMs) : selected.timeoutMs)
      const combined = AbortSignal.any([signal, timeout.signal])
      let outcome: DecisionOutcome
      try {
        if (config.mode === 'off') throw new DecisionError('UNAVAILABLE')
        if (batch.purpose === 'memory-reuse') {
          if (this.memoryReuse.mode === 'off') throw new DecisionError('UNAVAILABLE')
          const ready = await this.readiness.probe(config, combined)
          if (ready.state !== 'ready') throw new DecisionError(ready.reason === 'DECISION_AUTH' || ready.reason === 'missing_credential' ? 'AUTH' : 'UNAVAILABLE')
        }
        const provider = batch.purpose === 'memory-reuse' ? this.memoryProvider(config) : this.provider(config), limits = provider.capabilities
        if (!Number.isSafeInteger(limits.maxQuestions) || limits.maxQuestions < 1) throw new DecisionError('UNSUPPORTED')
        if (batch.questions.some(q => q.choices.length > limits.maxChoices) || Buffer.byteLength(JSON.stringify(batch)) > limits.maxBytes) throw new DecisionError('TOO_LARGE')
        const parts: DecisionBatchResult[] = []
        // Each question is independent and retains the complete evidence and its alternatives.
        if (batch.purpose === 'memory-reuse') parts.push(await evaluateMemoryBatches(provider, batch, config.provider, combined))
        else for (let offset = 0; offset < batch.questions.length; offset += limits.maxQuestions) {
          combined.throwIfAborted()
          const part = { ...batch, questions: batch.questions.slice(offset, offset + limits.maxQuestions) }
          parts.push(parseDecisionResult(await abortable(provider.evaluate(part, combined), combined), part))
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
        if (reason === 'DECISION_AUTH' && (wasReady || batch.purpose !== 'memory-reuse')) this.invalidateReadiness()
        if (batch.purpose === 'memory-reuse' && (wasReady || reason === 'DECISION_TIMEOUT')) this.readiness.failed(config, reason)
        this.lastFallback = reason
        outcome = { status: 'fallback', reason }
      } finally { clearTimeout(timer) }
      if (signal.aborted) throw new DecisionError('CANCELLED')
      await this.store?.write(requestId, digest, outcome)
      if (signal.aborted) throw new DecisionError('CANCELLED')
      this.results.set(key, structuredClone(outcome))
      return outcome
    })()
    this.pending.set(key, operation)
    try { return await operation } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
  }
}
