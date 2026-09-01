import { answerAgentTask, prepareAgentTask, type PreparedAgentTask } from '../akinator/agent-task.js'
import type { TaskProfile } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'
import type { DshRuntime } from './runtime.js'
import {
  assertCompleteDshCapabilityCatalog,
  assertDshCapabilityCatalogStable,
  type DshCapabilityCatalog,
} from './capability-catalog.js'
import { dshTurnRequestId, resolveGroundedIntakeProfile } from './intake-profile-resolver.js'
import type { DshIntakeAnswerer } from './user-interaction.js'
import type { SkillDiscoveryMode } from '../skills/types.js'

export interface DshPreStepEvent {
  readonly agent: { readonly id: string }
  readonly turn: number
  readonly step: number
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

/** Host-native Akinator gate. It owns no duplicate intake state and never calls next while unresolved. */
export class DshIntakeGate {
  readonly #runtime: Pick<DshRuntime, 'withDatabase'>
  readonly #answerer: DshIntakeAnswerer | undefined

  constructor(runtime: Pick<DshRuntime, 'withDatabase'>, answerer?: DshIntakeAnswerer) {
    this.#runtime = runtime
    this.#answerer = answerer
  }

  async prepare(event: DshPreStepEvent): Promise<DshIntakeGateResult> {
    assertCompleteDshCapabilityCatalog(event.capabilities)
    const grounded = resolveGroundedIntakeProfile({
      task: event.task,
      cwd: event.cwd,
      ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
      ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
    })
    const requestId = dshTurnRequestId({ dshSessionId: event.agent.id, turn: event.turn })
    let prepared = await this.#runtime.withDatabase((database) => prepareAgentTask(database, {
      requestId,
      task: grounded.task,
      cwd: grounded.cwd,
      profileHints: grounded.profileHints,
      capabilities: [...event.capabilities.skills, ...event.capabilities.tools],
      client: { kind: 'dsh', sessionId: event.agent.id },
      ...(event.skillDiscoveryMode === undefined ? {} : { skillDiscoveryMode: event.skillDiscoveryMode }),
      signal: event.signal,
    }))
    while (prepared.intake.status === 'needs_answer') {
      if (this.#answerer === undefined || prepared.intake.question === null) return { admitted: false, prepared, catalog: event.capabilities }
      const value = await this.#answerer.ask(prepared.intake.question, event.signal)
      assertDshCapabilityCatalogStable(event.capabilities, event.capabilities)
      prepared = await this.#runtime.withDatabase((database) => answerAgentTask(database, {
        sessionId: prepared.intake.sessionId,
        runId: prepared.run.runId,
        questionId: prepared.intake.question!.id,
        value,
        cwd: grounded.cwd,
        capabilities: [...event.capabilities.skills, ...event.capabilities.tools],
        ...(event.skillDiscoveryMode === undefined ? {} : { skillDiscoveryMode: event.skillDiscoveryMode }),
        signal: event.signal,
      }))
    }
    if (prepared.nextAction !== 'proceed') return { admitted: false, prepared, catalog: event.capabilities }
    return { admitted: true, prepared, catalog: event.capabilities }
  }

  async preStep(event: DshPreStepEvent, next: () => Promise<DshPreStepDecision>): Promise<DshPreStepDecision> {
    const result = await this.prepare(event)
    if (!result.admitted) return { kind: 'reject' }
    return next()
  }

  assertCatalog(expected: DshCapabilityCatalog, current: unknown): void {
    assertDshCapabilityCatalogStable(expected, current)
  }

  /** Turn-stopping callers use the same deny-before-side-effect check as pre-step. */
  assertTurnStoppingCatalog(expected: DshCapabilityCatalog, current: unknown): void {
    this.assertCatalog(expected, current)
  }
}

export function mountDshIntakeGate(ctx: DshPreStepContext, gate: DshIntakeGate): () => void {
  return ctx.on('agent/pre-step', (event, next) => gate.preStep(event, next), { prepend: true })
}
