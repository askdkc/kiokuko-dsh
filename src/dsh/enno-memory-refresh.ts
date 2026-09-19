import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import { deriveMemoryPolicy, hasBlockingRequiredCapability, resolveCapabilities } from '../akinator/capabilities.js'
import { readAkinatorSession } from '../akinator/store.js'
import { readContextRunRetrievalState } from '../context/run-state.js'
import { contextRetrievalStateHash } from '../context/selection-state.js'
import { scopedMemoryUseSignal, assertScopedMemoryUseSignal } from '../context/scoped-memory-gate.js'
import { queryScopedContextGated, type ScopedContextQuery } from '../context/scoped-broker.js'
import { captureProjectManifestSnapshot } from '../repository/project-fingerprint.js'
import { GLOBAL_WORKSPACE } from '../memory/workspaces.js'
import { readEnnoSnapshot, assertExecutionLeaseInTransaction } from '../enno-oduno/store.js'
import { stateForSnapshot } from '../enno-oduno/service.js'
import { buildEnnoMemoryFocus, extractMemorySignals, mergeMemorySignals, type MemorySignals } from '../enno-oduno/memory-focus.js'
import { decideMemoryRefresh, type MemoryRefreshReason } from '../enno-oduno/memory-refresh-policy.js'
import type { WorkUnit } from '../enno-oduno/types.js'
import { readRefreshMetadata, reserveMemoryRefresh, commitMemoryRefresh } from './enno-memory-refresh-store.js'
import { EnnoMemoryConfig } from './config.js'
import type { PreparedAgentTask } from './task-intake.js'
import type { DshRuntime } from './runtime.js'

export interface EnnoMemoryObservation {
  mode: 'observe' | 'active'; decision: 'reuse' | 'full' | 'skip'; reason: MemoryRefreshReason
  fullSearchCount: number; fullBudgetRemaining: number; candidateCount: number; selectedCount: number; omittedCount: number
  corpusValidationMs: number; retrievalMs: number; rankingMs: number; deliveryMs: number; totalMs: number
  embeddingCalls: 0; remoteCalls: 0; llmCalls: 0; selectedCharacters: number; selectedBytes: number
  resultDiscarded: boolean
}
export interface RefreshBinding {
  readonly runId: string; readonly sessionId: string; readonly nativeAgent: object; readonly nativeSession: object
  readonly prepared: PreparedAgentTask; readonly capabilities: readonly unknown[]; readonly constraints: string; readonly query?:string
  readonly leaseToken?: string; readonly signal: AbortSignal
  /** Current native identity, input generation, catalog, route and policy; never a model assertion. */
  readonly validateCapabilities?: () => Promise<void>
  readonly isCurrent: () => boolean
  readonly apply: (value: Pick<PreparedAgentTask, 'context' | 'memoryPolicy'>) => void
}
interface Owner {
  agent: object; session: object; version: number; signals: MemorySignals; focus: string | null
  corpus: string | null; manifest: string | null; config: string; fullCount: number; cold: boolean
  baseline: Pick<PreparedAgentTask, 'context' | 'memoryPolicy'>; selected: Pick<PreparedAgentTask, 'context' | 'memoryPolicy'>
  verifierCursor: number; unit: WorkUnit | null; inFlight?: Promise<void>; apply: RefreshBinding['apply']
}
const emptySignals = (): MemorySignals => ({ errors: [], paths: [], identifiers: [] })
const allowedStates = new Set(['oduno_ideal', 'zenki_planning', 'goki_executing', 'enno_verifying'])

/** One bounded owner registry; no new lease, queue, model request or memory body store. */
export class DshEnnoMemoryRefresh {
  #config: EnnoMemoryConfig
  #owners = new Map<string, Owner>()
  #closed = false
  constructor(private readonly runtime: Pick<DshRuntime, 'withDatabase'>, config: EnnoMemoryConfig,
    private readonly observe?: (value: EnnoMemoryObservation) => void) { this.#config = EnnoMemoryConfig.parse(config) }
  ownsActiveRefresh(state:PreparedAgentTask['ennoOduno']):boolean { return this.#config.mode==='active'&&state.applicable&&allowedStates.has(state.status??'') }
  get enabled(): boolean { return !this.#closed && this.#config.mode !== 'off' }
  configure(config: EnnoMemoryConfig): void {
    const next = EnnoMemoryConfig.parse(config)
    if (canonicalContentHash(next) === canonicalContentHash(this.#config)) return
    this.#config = next
    for (const owner of this.#owners.values()) {
      owner.version++
      owner.config = ''
      owner.selected = owner.baseline
      owner.apply(owner.baseline)
    }
    if (next.mode === 'off') this.#owners.clear()
  }
  invalidate(runId: string): void { const owner = this.#owners.get(runId); if (owner) owner.version++ }
  clear(runId: string): void { this.invalidate(runId); this.#owners.delete(runId) }
  close(): void { this.#closed = true; for (const id of this.#owners.keys()) this.clear(id) }
  observeResult(runId: string, agent: object, session: object, root: string, result: unknown): void {
    if (!this.enabled) return
    const owner = this.#owners.get(runId)
    if (!owner || owner.agent !== agent || owner.session !== session) return
    try {
      const signals = mergeMemorySignals(owner.signals, extractMemorySignals(result, root))
      if (canonicalContentHash(signals) !== canonicalContentHash(owner.signals)) { owner.signals = signals; owner.version++ }
    } catch { /* Optional malformed evidence cannot alter native tool results. */ }
  }
  async refresh(input: RefreshBinding): Promise<void> {
    if (!this.enabled || !input.prepared.ennoOduno.applicable || !allowedStates.has(input.prepared.ennoOduno.status)
      || input.prepared.nextAction !== 'proceed' || !input.isCurrent() || input.signal.aborted) return
    let owner = this.#owners.get(input.runId)
    if (owner && (owner.agent !== input.nativeAgent || owner.session !== input.nativeSession)) { this.clear(input.runId); owner = undefined }
    if (!owner) {
      if (this.#owners.size >= 32) {
        const oldest = this.#owners.keys().next().value!
        const evicted = this.#owners.get(oldest)!
        evicted.apply(evicted.baseline)
        this.clear(oldest)
      }
      const initial = { context: input.prepared.context, memoryPolicy: input.prepared.memoryPolicy }
      owner = { agent: input.nativeAgent, session: input.nativeSession, version: 0, signals: emptySignals(), focus: null,
        corpus: null, manifest: null, config: canonicalContentHash(this.#config), fullCount: 0, cold: input.prepared.context === null,
        baseline: initial, selected: initial, verifierCursor: 0, unit: null, apply: input.apply }
      owner.focus = buildEnnoMemoryFocus({ state: input.prepared.ennoOduno, root: input.prepared.project.repositoryRoot,
        signals: owner.signals, constraints: input.constraints, characterBudget: 8000 }).retrievalDomainDigest
      this.#owners.set(input.runId, owner)
    }
    owner.apply = input.apply
    if (owner.inFlight) { await owner.inFlight; return }
    const promise = this.#refresh(input, owner)
    owner.inFlight = promise
    try { await promise } finally { delete owner.inFlight }
  }
  async #refresh(input: RefreshBinding, owner: Owner): Promise<void> {
    const started = performance.now(), config = this.#config, configDigest = canonicalContentHash(config), version = owner.version
    const metric: EnnoMemoryObservation = { mode: config.mode as 'active' | 'observe', decision: 'skip', reason: 'memory_unavailable',
      fullSearchCount: owner.fullCount, fullBudgetRemaining: Math.max(0, config.maxFullSearchesPerRun-owner.fullCount),
      candidateCount: 0, selectedCount: 0, omittedCount: 0, corpusValidationMs: 0, retrievalMs: 0, rankingMs: 0, deliveryMs: 0, totalMs: 0,
      embeddingCalls: 0, remoteCalls: 0, llmCalls: 0, selectedCharacters: 0, selectedBytes: 0, resultDiscarded: false }
    const assertLive = () => {
      if (this.#closed || this.#owners.get(input.runId) !== owner || owner.version !== version || input.signal.aborted
        || this.#config !== config || !input.isCurrent()) throw new KiokukoError('CONFLICT', 'Memory refresh owner changed')
      if (performance.now()-started > config.localBudgetMs) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Memory refresh local budget exceeded')
    }
    try {
      owner.unit = input.prepared.ennoOduno.directive?.workUnit ?? owner.unit
      const state = input.prepared.ennoOduno
      let focus = buildEnnoMemoryFocus({ state: state.directive ? { ...state, directive: { ...state.directive, workUnit: owner.unit } } : state,
        root: input.prepared.project.repositoryRoot, signals: owner.signals, constraints: input.constraints, characterBudget: 8000 })
      if(input.query!==undefined)focus={...focus,retrievalDomainDigest:canonicalContentHash({focus:focus.retrievalDomainDigest,query:input.query})}
      if (config.mode === 'observe') {
        const decision = decideMemoryRefresh({ active: true, previousFocus: owner.focus ?? focus.retrievalDomainDigest,
          focus: focus.retrievalDomainDigest, corpusChanged: false, configChanged: owner.config !== configDigest,
          cold: owner.cold, fullCount: owner.fullCount, maxFull: config.maxFullSearchesPerRun })
        Object.assign(metric, decision); owner.focus = focus.retrievalDomainDigest; owner.config = configDigest; owner.cold = false
        return
      }
      await this.runtime.withDatabase(async (db, embedding) => {
        assertLive()
        const run = readContextRunRetrievalState(db, input.runId)
        const snapshot = readEnnoSnapshot(db, { runId: input.runId, workspace: input.prepared.project.workspace,
          orchestrationId: state.orchestrationId! })
        const assertAuthority = () => {
          assertLive()
          const current = readEnnoSnapshot(db, { runId: input.runId, workspace: snapshot.workspace, orchestrationId: snapshot.orchestrationId })
          const currentRun = readContextRunRetrievalState(db, input.runId)
          if (current.dshSessionId !== input.sessionId || current.repositoryRoot !== input.prepared.project.repositoryRoot
            || canonicalContentHash(current) !== canonicalContentHash(snapshot) || currentRun.stateHash !== run.stateHash
            || canonicalContentHash(stateForSnapshot(current)) !== canonicalContentHash(state)) {
            throw new KiokukoError('CONFLICT', 'Memory refresh authority changed')
          }
          if (current.status === 'goki_executing') {
            const unit = state.directive?.workUnit?.id
            if (!unit || !input.leaseToken) throw new KiokukoError('CONFLICT', 'Memory refresh execution lease unavailable')
            assertExecutionLeaseInTransaction(db, current, { workUnitId: unit, leaseToken: input.leaseToken, routeEpoch: current.routeEpoch })
          }
        }
        assertAuthority()
        // Bounded cursor over host-owned verifier outcomes, including failures that returned Zenki to planning.
        const verifiers = db.prepare(`SELECT rowid AS cursor, status, signal, exit_code AS exitCode, stdout_preview AS stdout,
          stderr_preview AS stderr FROM enno_verifier_runs WHERE run_id=? AND rowid>? AND status IN ('failed','timeout','spawn_failed')
          AND contract_revision<=? ORDER BY rowid LIMIT 16`).all<{ cursor: number; status: string; signal: string | null;
            exitCode: number | null; stdout: string | null; stderr: string | null }>(input.runId, owner.verifierCursor, snapshot.revision)
        for (const result of verifiers) {
          owner.signals = mergeMemorySignals(owner.signals, extractMemorySignals({ value: { ...result,
            timedOut: result.status === 'timeout', spawnFailed: result.status === 'spawn_failed' }, content: [] }, snapshot.repositoryRoot))
          owner.verifierCursor = result.cursor
        }
        if (verifiers.length) focus = buildEnnoMemoryFocus({ state: state.directive ? { ...state, directive: { ...state.directive, workUnit: owner.unit } } : state,
          root: snapshot.repositoryRoot, signals: owner.signals, constraints: input.constraints, characterBudget: 8000 })
        if(verifiers.length&&input.query!==undefined)focus={...focus,retrievalDomainDigest:canonicalContentHash({focus:focus.retrievalDomainDigest,query:input.query})}
        const manifest = captureProjectManifestSnapshot(input.prepared.project).manifestDigest
        const corpusStart = performance.now()
        const corpus = contextRetrievalStateHash(db, [snapshot.workspace, GLOBAL_WORKSPACE], { includeEcosystem: true })
        metric.corpusValidationMs = performance.now()-corpusStart
        const metadata = readRefreshMetadata(db, input.runId)
        owner.fullCount = metadata?.fullCount ?? 0
        const decision = decideMemoryRefresh({ active: true, previousFocus: owner.focus ?? focus.retrievalDomainDigest,
          focus: focus.retrievalDomainDigest, corpusChanged: owner.corpus !== null && (owner.corpus !== corpus || owner.manifest !== manifest),
          configChanged: owner.config !== configDigest, cold: owner.cold, fullCount: owner.fullCount, maxFull: config.maxFullSearchesPerRun })
        Object.assign(metric, decision)
        if (decision.decision === 'skip') return
        if (decision.decision === 'reuse' && owner.selected.context === null) { assertAuthority(); input.apply(owner.selected); return }
        const query: ScopedContextQuery = { project: input.prepared.project, task: input.query ?? readAkinatorSession(db, { workspace: snapshot.workspace, sessionId: run.intakeSessionId }).task,
          taskProfile: run.profile, recommendedTags: run.recommendedTags, runId: input.runId, characterBudget: 8000,
          errorSignatures: focus.observedErrorSignals, changedPaths: focus.targetPaths,
          focus: { objective: focus.workUnitObjective, identifiers: focus.observedIdentifiers, constraints: focus.constraints,
            retrievalDomainDigest: focus.retrievalDomainDigest, rankingFocusDigest: focus.rankingFocusDigest } }
        const ticket = reserveMemoryRefresh(db, { runId: input.runId, config: configDigest, full: decision.decision === 'full',
          maxFull: config.maxFullSearchesPerRun, assertCurrent: assertAuthority })
        if (!ticket) { metric.decision = 'skip'; metric.reason = 'budget_exhausted'; return }
        owner.fullCount = ticket.fullCount
        // The production host provides an off runtime. No extra provider invocation is allowed here.
        // A required semantic contract cannot silently become lexical-only.
        if (decision.decision === 'full' && embedding.mode === 'required') throw new KiokukoError('SERVICE_UNAVAILABLE', 'Required local embedding is unavailable for refresh')
        const timings = { retrievalMs: 0, rankingMs: 0, deliveryMs: 0 }
        const gated = await queryScopedContextGated(db, query, candidate => {
          assertAuthority()
          metric.candidateCount = candidate.items.length + (candidate.omissions?.length ?? 0)
          const memoryUse = scopedMemoryUseSignal(db, snapshot.workspace, candidate)
          const memoryPolicy = deriveMemoryPolicy(run.profile, memoryUse, input.capabilities)
          const capabilities = resolveCapabilities({ task: query.task, profile: run.profile,
            recommendedTags: run.recommendedTags, capabilities: input.capabilities, memoryUse })
          const withheld = memoryPolicy.contextWithheld || hasBlockingRequiredCapability(capabilities)
          return { persist: !withheld, value: memoryPolicy,
            assertBeforePersist: () => { assertAuthority(); assertScopedMemoryUseSignal(db, snapshot.workspace, candidate, memoryUse) } }
        }, {}, { timings, ...(input.validateCapabilities ? { beforeCommit: input.validateCapabilities } : {}), ...(decision.decision === 'reuse' && owner.selected.context !== null ? { reuse: owner.selected.context } : {}),
          commit: context => { assertAuthority(); commitMemoryRefresh(db, { runId: input.runId, ticket, focus: focus.retrievalDomainDigest, context }) } })
        Object.assign(metric, timings)
        assertLive()
        owner.selected = { context: gated.context, memoryPolicy: gated.value }
        owner.focus = focus.retrievalDomainDigest; owner.corpus = corpus; owner.manifest = manifest; owner.config = configDigest; owner.cold = false
        const deliveryStart = performance.now()
        input.apply(owner.selected)
        metric.deliveryMs += performance.now()-deliveryStart
        metric.selectedCount = gated.context?.items.length ?? 0; metric.omittedCount = gated.context?.omissions?.length ?? 0
        for (const item of gated.context?.items ?? []) {
          metric.selectedCharacters += item.projection?.characters ?? 0; metric.selectedBytes += item.projection?.bytes ?? 0
        }
      })
    } catch {
      metric.resultDiscarded = true
      metric.reason = performance.now()-started > config.localBudgetMs ? 'time_budget'
        : owner.version !== version || input.signal.aborted || this.#config !== config || !input.isCurrent() ? 'stale_generation' : 'memory_unavailable'
      // The existing request fence decides whether any previously selected memory is still usable.
    } finally {
      metric.totalMs = performance.now()-started; metric.fullSearchCount = owner.fullCount
      metric.fullBudgetRemaining = Math.max(0, config.maxFullSearchesPerRun-owner.fullCount)
      try { this.observe?.(metric) } catch { /* Numeric diagnostics are optional. */ }
    }
  }
}
