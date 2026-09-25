import { canonicalContentHash } from '../../serialization/validate.js'
import type { DecisionService } from '../decisions/service.js'
import type { DshModelCatalog, ModelBinding } from '../model-configuration.js'
import { DEFAULT_MODEL_AUTO_ROUTES, ModelAutoConfig, MODEL_AUTO_POLICY, type ModelAutoConfiguration, type ModelAutoInput,
  type ModelAutoReason, type ModelAutoSelection } from './contracts.js'
import { modelAutoCandidates } from './candidates.js'
import { ModelAutoStore, type AutoRoute } from './store.js'
import type { z } from 'zod'

const NATIVE = (reason: ModelAutoReason): ModelAutoSelection => ({ kind: 'native', reason })
const routeResult = (route: AutoRoute, sessionRevision: number, mode: ModelAutoConfiguration['mode']): ModelAutoSelection =>
  route.status === 'selected' && route.binding && route.sessionRevision === sessionRevision && mode === 'auto'
    ? { kind: 'apply', binding: route.binding, reason: 'selected' } : NATIVE(route.reason)

/** One durable decision per admitted logical run; a lost in-flight call is never resent. */
export class ModelAutoCoordinator {
  readonly config: ModelAutoConfiguration
  private readonly pending = new Map<string, Promise<ModelAutoSelection>>()
  constructor(readonly store: ModelAutoStore, private readonly decisions: DecisionService,
    private readonly catalog: DshModelCatalog | undefined, config: z.input<typeof ModelAutoConfig> = {}) {
    this.config = ModelAutoConfig.parse(config)
  }
  async setMode(sessionId: string, mode: ModelAutoConfiguration['mode']) { return this.store.setMode(sessionId, mode) }
  async manual(sessionId: string, seq: number, selected: ModelBinding): Promise<void> { await this.store.manual(sessionId, seq, selected) }
  async baseline(runId: string, selected: ModelBinding): Promise<void> { await this.store.baseline(runId, selected) }
  async status(sessionId: string) {
    const session = await this.store.session(sessionId)
    const decision = this.decisions.status() as { mode?: string; provider?: string; readiness?: { state?: string } }
    const effective = session.mode === 'off' ? 'disabled' : session.pin ? 'manual_pin'
      : decision.mode !== 'auto' || !['typesafe', 'laya-coreml'].includes(decision.provider ?? '') ? 'decision_off'
        : decision.readiness?.state === 'ready' ? 'ready' : 'unverified'
    return { configured: this.config.mode, mode: session.mode, revision: session.revision,
      effective, preset: this.config.preset, budgetMs: this.config.budgetMs,
      candidates: (this.config.routes ?? DEFAULT_MODEL_AUTO_ROUTES).map(route => ({ id: route.id, ...route.binding })),
      manualPin: session.pin, manualSeq: session.manualSeq, decisionProvider: decision.provider ?? null,
      readiness: decision.readiness?.state ?? 'unknown', last: session.last }
  }
  async requestHeader(sessionId: string, runId: string, actual: ModelBinding): Promise<void> {
    const route = await this.store.route(runId)
    if (!route) return
    const session = await this.store.session(sessionId)
    const previous = session.last && typeof session.last === 'object' && (session.last as { runId?: unknown }).runId === runId
      ? session.last as Record<string, unknown> : {}
    await this.store.observed(sessionId, { ...previous, runId, outcome: route.status, reason: route.reason,
      selected: route.binding, actual, matched: route.status !== 'selected' || route.binding?.provider === actual.provider
        && route.binding.model === actual.model && route.binding.reasoningEffort === actual.reasoningEffort,
      at: new Date().toISOString() })
  }
  async assertCurrent(runId: string, sessionId: string, chosen: ModelBinding): Promise<void> {
    const [route, session] = await Promise.all([this.store.route(runId), this.store.session(sessionId)])
    if (!route || route.status !== 'selected' || route.sessionId !== sessionId || route.sessionRevision !== session.revision
      || session.mode !== 'auto' || session.pin || route.binding?.provider !== chosen.provider
      || route.binding.model !== chosen.model || route.binding.reasoningEffort !== chosen.reasoningEffort)
      throw new Error('Model-auto selection changed before dispatch')
  }
  async resolve(input: ModelAutoInput): Promise<ModelAutoSelection> {
    if (!input.admitted) throw new Error('Model-auto requires an admitted task')
    input.signal.throwIfAborted()
    const session = await this.store.session(input.sessionId)
    const digest = canonicalContentHash({ requestId: input.requestId, sessionId: input.sessionId, turn: input.turn,
      task: input.task, taskType: input.taskType ?? null })
    const prior = await this.store.route(input.runId)
    if (prior) {
      if (prior.inputDigest !== digest || prior.requestId !== input.requestId || prior.sessionId !== input.sessionId || prior.turn !== input.turn)
        throw new Error('Model-auto logical request changed under one run')
      if (prior.status === 'deciding') {
        const local = this.pending.get(input.runId)
        if (local) return local
        return routeResult((await this.store.recover(input.runId))!, session.revision, session.mode)
      }
      if (session.pin) return NATIVE('manual_pin')
      if (prior.sessionRevision !== session.revision || session.mode === 'off') return NATIVE('session_changed')
      return routeResult(prior, session.revision, session.mode)
    }
    if (session.mode === 'off') return NATIVE('mode_off')
    if (session.pin) return NATIVE('manual_pin')
    if (!input.task.trim() || input.taskType === 'chat') return NATIVE('ineligible_task')
    if (!await this.decisions.modelRoutingAvailable(input.requestId, input.signal)) return NATIVE('decision_off')
    const local = this.pending.get(input.runId)
    if (local) return local
    const operation = this.classify(input, digest, session.revision, session.mode)
    this.pending.set(input.runId, operation)
    try { return await operation } finally { if (this.pending.get(input.runId) === operation) this.pending.delete(input.runId) }
  }
  private async classify(input: ModelAutoInput, inputDigest: string, revision: number,
    mode: ModelAutoConfiguration['mode']): Promise<ModelAutoSelection> {
    const started = performance.now()
    const budget = AbortSignal.timeout(this.config.budgetMs)
    const signal = AbortSignal.any([input.signal, budget])
    let candidates: Awaited<ReturnType<typeof modelAutoCandidates>> = { routes: [], digest: '', reason: 'candidate_unavailable' }
    let reason: ModelAutoReason = 'decision_unavailable'
    let chosen: ModelBinding | null = null
    try {
      const measured = input.measureContext?.()
      candidates = await modelAutoCandidates(this.catalog, this.config, input.attachmentTypes ?? [], signal,
        measured === undefined ? undefined : measured + Math.ceil(Buffer.byteLength(input.task) / 2))
    }
    catch (error) {
      if (input.signal.aborted) throw error
      reason = budget.aborted ? 'decision_timeout' : 'candidate_unavailable'
    }
    // This write is an integrity boundary. A storage error must stop the request.
    await this.store.claim({ runId: input.runId, sessionId: input.sessionId, requestId: input.requestId, turn: input.turn,
      inputDigest, configDigest: canonicalContentHash(this.config), catalogDigest: candidates.digest,
      sessionRevision: revision, policy: MODEL_AUTO_POLICY })
    try {
      if (candidates.reason && reason !== 'decision_timeout') reason = candidates.reason
      else {
        const state = { task: input.task, taskType: input.taskType ?? null, attachmentTypes: input.attachmentTypes ?? [] }
        const batch = { purpose: 'model-routing' as const, contractVersion: 'typed-decisions-v1' as const, state,
          questions: [{ id: 'model-route', type: 'choice' as const,
            instructions: 'Choose one route for this complete task. luna-low: small precise edit or extraction; luna-medium: ordinary work with clear steps; luna-high: diagnosis or interacting constraints; sol-high: uncertain design, broad impact, or careful verification. Choose retain when evidence is insufficient. Never infer authorization or change the task.',
            choices: [...candidates.routes.map(route => ({ id: route.id, description: `${route.binding.model} / ${route.binding.reasoningEffort}` })),
              { id: 'retain', description: 'Keep the current model when no candidate is justified.' }], abstainId: 'retain' }] }
        if (Buffer.byteLength(JSON.stringify(batch)) > 256 * 1024) reason = 'input_too_large'
        else {
          const ready = await this.decisions.probeBound(input.requestId, signal)
          if (ready.state !== 'ready') reason = ready.reason === 'decision_off' ? 'decision_off' : 'decision_unavailable'
          else {
            const outcome = await this.decisions.evaluate(input.requestId, batch, signal, candidates.digest)
            if (outcome.status === 'fallback') reason = outcome.reason === 'DECISION_TIMEOUT' ? 'decision_timeout' : 'decision_unavailable'
            else {
              const answer = outcome.result.answers[0]
              if (answer?.status === 'selected' && answer.choiceId !== 'retain') {
                chosen = candidates.routes.find(route => route.id === answer.choiceId)?.binding ?? null
                reason = chosen ? mode === 'auto' ? 'selected' : 'observed' : 'invalid_result'
              } else reason = 'abstained'
            }
          }
        }
      }
    } catch (error) {
      if (input.signal.aborted) throw error
      if (budget.aborted) reason = 'decision_timeout'
      else if (reason !== 'input_too_large') reason = 'decision_unavailable'
    }
    input.signal.throwIfAborted()
    const selected = mode === 'auto' && chosen !== null
    const completed = await this.store.complete(input.runId, revision, selected ? 'selected' : 'retained', reason,
      selected ? chosen : null, Math.round(performance.now() - started))
    if (!completed) return NATIVE('session_changed')
    await this.store.observed(input.sessionId, { runId: input.runId, outcome: selected ? 'selected' : 'retained', reason,
      proposed: chosen, selected: selected ? chosen : null, elapsedMs: Math.round(performance.now() - started), at: new Date().toISOString() })
    return selected ? { kind: 'apply', binding: chosen!, reason } : NATIVE(reason)
  }
}
