import { answerAgentTask, prepareAgentTask, type PreparedAgentTask } from './task-intake.js'
import type { TaskProfile } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { DshRuntime } from './runtime.js'
import {
  assertCompleteDshCapabilityCatalog,
  assertDshCapabilityCatalogStable,
  type DshCapabilityCatalog,
} from './capability-catalog.js'
import { dshTurnRequestId, resolveGroundedIntakeProfile } from './intake-profile-resolver.js'
import type { DshIntakeAnswerer, DshUserQuestionAgent } from './user-interaction.js'
import type { SkillDiscoveryMode } from '../skills/types.js'

export interface DshPreStepEvent {
  readonly agent: { readonly id: string }
  /** Opaque native Agent scope used for capability snapshots. */
  readonly nativeAgent?: DshUserQuestionAgent
  /** The native DSH session identity; it is distinct from agent.id. */
  readonly sessionId: string
  /** Opaque native Session object, retained only for exact host binding. */
  readonly nativeSession?: object
  readonly turn: number
  /** Exact native DSH `turn/start` sequence, bound atomically with a new run. */
  readonly sourceStartSeq?: number
  readonly step: number
  /** Exact native message batch. Never flattened or reconstructed by intake. */
  readonly nativeMessages?: readonly unknown[]
  readonly task: string
  readonly cwd: string
  readonly profileHints?: Partial<TaskProfile>
  readonly evidence?: readonly string[]
  readonly skillDiscoveryMode?: SkillDiscoveryMode
  readonly capabilities: DshCapabilityCatalog
  readonly signal: AbortSignal
}

export type DshPreStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: readonly unknown[]; readonly startsRequestSeries?: true }

export interface DshIntakeGateResult {
  readonly admitted: boolean
  readonly prepared: PreparedAgentTask
  readonly catalog: DshCapabilityCatalog
}

export interface DshCapabilityReadContext {
  readonly agent: { readonly id: string }
  readonly nativeAgent?: DshUserQuestionAgent
  readonly cwd: string
  readonly signal: AbortSignal
}

export function assertDshModelAdmitted(result: DshIntakeGateResult): void {
  if (!result.admitted || (result.prepared.intake.status !== 'ready' && result.prepared.intake.status !== 'exhausted') || result.prepared.nextAction !== 'proceed') {
    throw new KiokukoError('CONFLICT', 'dsh model execution is not admitted before intake and capability checks complete')
  }
}

export interface DshPreStepContext {
  on(name: 'agent/pre-step', listener: (event: DshPreStepEvent, next: () => Promise<DshPreStepDecision>) => Promise<DshPreStepDecision>, options?: { readonly prepend?: boolean }): () => void
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message)
}

function assertAgentId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'dsh agent identity is invalid')
  }
}

/** Host-native Akinator gate. It replays one bound result per logical turn and never calls next while unresolved. */
export class DshIntakeGate {
  readonly #runtime: Pick<DshRuntime, 'withDatabase'>
  readonly #answerer: DshIntakeAnswerer | undefined
  readonly #readCapabilities: ((context: DshCapabilityReadContext) => DshCapabilityCatalog | PromiseLike<DshCapabilityCatalog>) | undefined
  readonly #prepared = new Map<string, {
    readonly fingerprint: string
    readonly result: DshIntakeGateResult
    readonly agentId: string
    readonly nativeAgent?: object
    readonly nativeSession?: object
  }>()
  readonly #preparing = new Map<string, {
    readonly fingerprint: string
    readonly agentId: string
    readonly nativeAgent?: object
    readonly nativeSession?: object
    readonly promise: Promise<DshIntakeGateResult>
  }>()

  constructor(
    runtime: Pick<DshRuntime, 'withDatabase'>,
    answerer?: DshIntakeAnswerer,
    readCapabilities?: (context: DshCapabilityReadContext) => DshCapabilityCatalog | PromiseLike<DshCapabilityCatalog>,
  ) {
    this.#runtime = runtime
    this.#answerer = answerer
    this.#readCapabilities = readCapabilities
  }

  async prepare(event: DshPreStepEvent): Promise<DshIntakeGateResult> {
    assertAgentId(event.agent.id)
    assertCompleteDshCapabilityCatalog(event.capabilities)
    const grounded = resolveGroundedIntakeProfile({
      task: event.task,
      cwd: event.cwd,
      ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
      ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
    })
    const requestId = dshTurnRequestId({ dshSessionId: event.sessionId, turn: event.turn })
    const cacheKey = `${event.sessionId}\u0000${event.turn}`
    const fingerprint = canonicalContentHash({
      sessionId: event.sessionId,
      agentId: event.agent.id,
      turn: event.turn,
      sourceStartSeq: event.sourceStartSeq ?? null,
      task: grounded.task,
      cwd: grounded.cwd,
      ...(grounded.profileHints === undefined ? {} : { profileHints: grounded.profileHints }),
      ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
      ...(event.skillDiscoveryMode === undefined ? {} : { skillDiscoveryMode: event.skillDiscoveryMode }),
      catalogDigest: event.capabilities.digest,
    })
    const cached = this.#prepared.get(cacheKey)
    if (cached !== undefined) {
      if (event.signal.aborted) return { admitted: false, prepared: cached.result.prepared, catalog: cached.result.catalog }
      if (cached.fingerprint !== fingerprint
        || cached.agentId !== event.agent.id
        || cached.nativeAgent !== event.nativeAgent
        || cached.nativeSession !== event.nativeSession) {
        conflict('dsh logical turn was reused with different bound input')
      }
      assertDshCapabilityCatalogStable(cached.result.catalog, event.capabilities)
      return cached.result
    }
    const inFlight = this.#preparing.get(cacheKey)
    if (inFlight !== undefined) {
      if (inFlight.fingerprint !== fingerprint
        || inFlight.agentId !== event.agent.id
        || inFlight.nativeAgent !== event.nativeAgent
        || inFlight.nativeSession !== event.nativeSession) {
        conflict('dsh logical turn was reused with different bound input')
      }
      const result = await inFlight.promise
      return event.signal.aborted ? { ...result, admitted: false } : result
    }
    const operation = (async (): Promise<DshIntakeGateResult> => {
      let prepared = await this.#runtime.withDatabase((database) => prepareAgentTask(database, {
        requestId,
        task: grounded.task,
        cwd: grounded.cwd,
        profileHints: grounded.profileHints,
        capabilities: [...event.capabilities.skills, ...event.capabilities.tools],
        dshSessionId: event.sessionId,
        ...(event.sourceStartSeq === undefined ? {} : {
          dshLogStart: { sourceStartSeq: event.sourceStartSeq, sourceStartTurn: event.turn },
        }),
        ...(event.skillDiscoveryMode === undefined ? {} : { skillDiscoveryMode: event.skillDiscoveryMode }),
        signal: event.signal,
      }))
      while (prepared.intake.status === 'needs_answer') {
        if (this.#answerer === undefined || prepared.intake.question === null) {
          const result = { admitted: false, prepared, catalog: event.capabilities }
          this.#prepared.set(cacheKey, {
            fingerprint,
            result,
            agentId: event.agent.id,
            ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
            ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
          })
          return result
        }
        const value = await this.#answerer.ask(prepared.intake.question, event.signal, event.nativeAgent)
        const currentCapabilities = this.#readCapabilities === undefined
          ? event.capabilities
          : await this.#readCapabilities({
            agent: event.agent,
            ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
            cwd: event.cwd,
            signal: event.signal,
          })
        assertDshCapabilityCatalogStable(event.capabilities, currentCapabilities)
        prepared = await this.#runtime.withDatabase((database) => answerAgentTask(database, {
          sessionId: prepared.intake.sessionId,
          runId: prepared.run.runId,
          dshSessionId: event.sessionId,
          questionId: prepared.intake.question!.id,
          value,
          cwd: grounded.cwd,
          capabilities: [...event.capabilities.skills, ...event.capabilities.tools],
          ...(event.skillDiscoveryMode === undefined ? {} : { skillDiscoveryMode: event.skillDiscoveryMode }),
          signal: event.signal,
        }))
      }
      const result = prepared.nextAction !== 'proceed'
        ? { admitted: false, prepared, catalog: event.capabilities }
        : { admitted: true, prepared, catalog: event.capabilities }
      this.#prepared.set(cacheKey, {
        fingerprint,
        result,
        agentId: event.agent.id,
        ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
        ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
      })
      if (event.signal.aborted) return { admitted: false, prepared, catalog: event.capabilities }
      return result
    })()
    this.#preparing.set(cacheKey, {
      fingerprint,
      agentId: event.agent.id,
      ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
      ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
      promise: operation,
    })
    try {
      return await operation
    } finally {
      if (this.#preparing.get(cacheKey)?.promise === operation) this.#preparing.delete(cacheKey)
    }
  }

  async preStep(event: DshPreStepEvent, next: () => Promise<DshPreStepDecision>): Promise<DshPreStepDecision> {
    // Preserve the native chain's exact message decision first. Kiokuko
    // admission augments that decision but never consumes/rejects a prompt
    // merely because its own intake, cache, or question service is degraded.
    const decision = await next()
    if (decision.kind !== 'enter' || event.signal.aborted) return decision
    try {
      await this.prepare(event)
    } catch {
      return decision
    }
    return decision
  }

  assertCatalog(expected: DshCapabilityCatalog, current: unknown): void {
    assertDshCapabilityCatalogStable(expected, current)
  }

  /** Turn-stopping callers use the same deny-before-side-effect check as pre-step. */
  assertTurnStoppingCatalog(expected: DshCapabilityCatalog, current: unknown): void {
    this.assertCatalog(expected, current)
  }

  /** Release the cached preparation for a turn once its owning run closes. */
  clearTurn(sessionId: string, turn: number): void {
    const key = `${sessionId}\u0000${turn}`
    this.#prepared.delete(key)
    this.#preparing.delete(key)
  }
}

export function mountDshIntakeGate(ctx: DshPreStepContext, gate: DshIntakeGate): () => void {
  return ctx.on('agent/pre-step', (event, next) => gate.preStep(event, next), { prepend: true })
}
