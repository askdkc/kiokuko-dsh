import { canonicalContentHash } from '../serialization/validate.js'
import type { EnnoNextAction, EnnoOdunoState } from '../enno-oduno/types.js'
import {
  selectDshDirectiveSources,
  type DshDirectiveSourceSelection,
} from './context-injection.js'
import type { UserFacingConfirmation } from '../enno-oduno/types.js'
import type { DshConfirmationAnswer, DshConfirmationAnswerer } from './user-interaction.js'
import type { DshAdvisoryRoundResult, DshAdvisoryRunner } from './advisory-runner.js'

export interface DshTurnStoppingAgent {
  readonly id: string
  steer(message: DshContinuationMessage): void
  cancel?(reason: string): void
}

export interface DshTurnStoppingEvent {
  readonly agent: DshTurnStoppingAgent
  readonly turn: number
  readonly signal: AbortSignal
}

export interface DshContinuationMessage {
  readonly content: string
  readonly source: 'kiokuko-dsh'
}

export interface DshEnnoControllerDependencies {
  readonly readState: (event: DshTurnStoppingEvent) => Promise<EnnoOdunoState | null>
  readonly injectNextStepContext?: (input: {
    readonly event: DshTurnStoppingEvent
    readonly selection: DshDirectiveSourceSelection
  }) => void | PromiseLike<void>
  readonly maxSteersPerDirective?: number
  readonly advisoryRunner?: DshAdvisoryRunner
  readonly submitAdvisory?: (result: DshAdvisoryRoundResult) => void | PromiseLike<void>
  readonly runFinalVerification?: (input: { readonly event: DshTurnStoppingEvent; readonly state: EnnoOdunoState }) => void | PromiseLike<void>
}

export interface DshConfirmationControllerDependencies {
  readonly answerer?: DshConfirmationAnswerer
  readonly submit: (input: { readonly action: DshConfirmationAnswer['action']; readonly requestedChanges?: string; readonly expectedRevision: number }) => void | PromiseLike<void>
  readonly readRevision: () => number | PromiseLike<number>
}

export type DshConfirmationDecision =
  | { readonly kind: 'submitted'; readonly answer: DshConfirmationAnswer }
  | { readonly kind: 'blocked'; readonly reason: 'answerer_unavailable' | 'stale_revision' | 'aborted' }

export type DshEnnoNextActionHandler =
  | { readonly kind: 'pending'; readonly requiresDirective: true }
  | { readonly kind: 'terminal'; readonly requiresDirective: false }

/** Exhaustive policy table: every core Enno next action has exactly one dsh owner. */
export const DSH_ENNO_NEXT_ACTION_HANDLERS: Readonly<Record<EnnoNextAction, DshEnnoNextActionHandler>> = Object.freeze({
  answer_intake: { kind: 'pending', requiresDirective: true },
  submit_ideal: { kind: 'pending', requiresDirective: true },
  submit_plan: { kind: 'pending', requiresDirective: true },
  ask_user_confirmation: { kind: 'pending', requiresDirective: true },
  execute_work_unit: { kind: 'pending', requiresDirective: true },
  run_final_verification: { kind: 'pending', requiresDirective: true },
  submit_final_review: { kind: 'pending', requiresDirective: true },
  submit_meditation: { kind: 'pending', requiresDirective: true },
  report_blocker: { kind: 'terminal', requiresDirective: false },
  complete: { kind: 'terminal', requiresDirective: false },
})

/** Execute confirmation only after a public answer and a fresh revision check. */
export class DshConfirmationController {
  readonly #dependencies: DshConfirmationControllerDependencies

  constructor(dependencies: DshConfirmationControllerDependencies) {
    this.#dependencies = dependencies
  }

  async confirm(input: { readonly confirmation: UserFacingConfirmation; readonly expectedRevision: number; readonly signal?: AbortSignal }): Promise<DshConfirmationDecision> {
    if (input.signal?.aborted) return { kind: 'blocked', reason: 'aborted' }
    if (this.#dependencies.answerer === undefined) return { kind: 'blocked', reason: 'answerer_unavailable' }
    const answer = await this.#dependencies.answerer.ask(input.confirmation, input.signal)
    if (input.signal?.aborted) return { kind: 'blocked', reason: 'aborted' }
    if (await this.#dependencies.readRevision() !== input.expectedRevision) return { kind: 'blocked', reason: 'stale_revision' }
    await this.#dependencies.submit({
      action: answer.action,
      expectedRevision: input.expectedRevision,
      ...(answer.requestedChanges === undefined ? {} : { requestedChanges: answer.requestedChanges }),
    })
    return { kind: 'submitted', answer }
  }
}

export type DshTurnStoppingDecision =
  | { readonly kind: 'close'; readonly nextAction: EnnoNextAction }
  | { readonly kind: 'steer'; readonly nextAction: EnnoNextAction; readonly selection: DshDirectiveSourceSelection }
  | { readonly kind: 'abort'; readonly reason: 'aborted' | 'state_unavailable' | 'directive_missing' | 'stale_directive' | 'continuation_limit' | 'verification_failed' | 'context_injection_failed' }

const continuationText = 'Kiokuko の現在の処理は未完了です。提示された現在の指示に従って次の処理を実行し、完了を先取りしないでください。'

function directiveKey(event: DshTurnStoppingEvent, state: EnnoOdunoState): string {
  return canonicalContentHash({
    agentId: event.agent.id,
    turn: event.turn,
    nextAction: state.nextAction,
    directive: state.directive,
    contractRevision: state.contractRevision,
    routeEpoch: state.routeEpoch,
  })
}

/** Own the awaited turn boundary and never convert an Enno error into a normal close. */
export class DshEnnoController {
  readonly #readState: DshEnnoControllerDependencies['readState']
  readonly #injectNextStepContext: NonNullable<DshEnnoControllerDependencies['injectNextStepContext']>
  readonly #maxSteersPerDirective: number
  readonly #advisoryRunner: DshAdvisoryRunner | undefined
  readonly #submitAdvisory: DshEnnoControllerDependencies['submitAdvisory']
  readonly #runFinalVerification: DshEnnoControllerDependencies['runFinalVerification']
  readonly #steers = new Map<string, number>()

  constructor(dependencies: DshEnnoControllerDependencies) {
    this.#readState = dependencies.readState
    this.#injectNextStepContext = dependencies.injectNextStepContext ?? (() => undefined)
    this.#maxSteersPerDirective = dependencies.maxSteersPerDirective ?? 1
    this.#advisoryRunner = dependencies.advisoryRunner
    this.#submitAdvisory = dependencies.submitAdvisory
    this.#runFinalVerification = dependencies.runFinalVerification
    if (!Number.isSafeInteger(this.#maxSteersPerDirective) || this.#maxSteersPerDirective < 1 || this.#maxSteersPerDirective > 8) {
      throw new Error('maxSteersPerDirective must be between 1 and 8')
    }
  }

  async turnStopping(event: DshTurnStoppingEvent): Promise<DshTurnStoppingDecision> {
    if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
    let state: EnnoOdunoState | null
    try {
      state = await this.#readState(event)
    } catch {
      return { kind: 'abort', reason: 'state_unavailable' }
    }
    if (state === null || !state.applicable) return { kind: 'close', nextAction: 'complete' }
    const handler = DSH_ENNO_NEXT_ACTION_HANDLERS[state.nextAction]
    if (handler.kind === 'terminal') return { kind: 'close', nextAction: state.nextAction }
    if (state.directive === null) return { kind: 'abort', reason: 'directive_missing' }
    if ((state.contractRevision !== null && state.directive.contractRevision !== state.contractRevision)
      || (state.routeEpoch !== null && state.directive.routeEpoch !== state.routeEpoch)) {
      return { kind: 'abort', reason: 'stale_directive' }
    }
    const key = directiveKey(event, state)
    const used = this.#steers.get(key) ?? 0
    if (used >= this.#maxSteersPerDirective) return { kind: 'abort', reason: 'continuation_limit' }
    const selection = selectDshDirectiveSources(state.directive)
    if (state.nextAction === 'run_final_verification') {
      if (this.#runFinalVerification === undefined) return { kind: 'abort', reason: 'state_unavailable' }
      try {
        await this.#runFinalVerification({ event, state })
      } catch {
        return { kind: 'abort', reason: 'verification_failed' }
      }
    }
    try {
      if (state.directive.advisoryRound !== undefined) {
        if (this.#advisoryRunner === undefined || this.#submitAdvisory === undefined) return { kind: 'abort', reason: 'state_unavailable' }
        const advisory = await this.#advisoryRunner.run({ directive: state.directive.advisoryRound, signal: event.signal })
        await this.#submitAdvisory(advisory)
      }
      await this.#injectNextStepContext({ event, selection })
    } catch {
      return { kind: 'abort', reason: 'context_injection_failed' }
    }
    this.#steers.set(key, used + 1)
    event.agent.steer({ content: continuationText, source: 'kiokuko-dsh' })
    return { kind: 'steer', nextAction: state.nextAction, selection }
  }

  async handle(event: DshTurnStoppingEvent): Promise<DshTurnStoppingDecision> {
    const decision = await this.turnStopping(event)
    if (decision.kind === 'abort' && decision.reason !== 'aborted') {
      event.agent.cancel?.(`kiokuko dsh Enno continuation stopped: ${decision.reason}`)
    }
    return decision
  }

  dispose(): void {
    this.#steers.clear()
  }
}

export interface DshTurnStoppingContext {
  on(name: 'agent/turn-stopping', listener: (event: DshTurnStoppingEvent) => Promise<void>, options?: { readonly prepend?: boolean }): () => void
}

export function mountDshEnnoController(ctx: DshTurnStoppingContext, controller: DshEnnoController): () => void {
  return ctx.on('agent/turn-stopping', async (event) => { await controller.handle(event) }, { prepend: true })
}
