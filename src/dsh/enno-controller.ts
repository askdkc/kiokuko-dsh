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
  readonly sessionId?: string
  /** Opaque native Agent object used to reject an ID-reused agent lifecycle. */
  readonly nativeAgent?: object
  /** Opaque native Session object used to reject same-ID cross-lifecycle events. */
  readonly nativeSession?: object
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
    readonly state: EnnoOdunoState
  }) => void | PromiseLike<void>
  readonly maxSteersPerDirective?: number
  readonly advisoryRunner?: DshAdvisoryRunner
  readonly submitAdvisory?: (result: DshAdvisoryRoundResult, input: { readonly event: DshTurnStoppingEvent; readonly state: EnnoOdunoState }) => void | EnnoOdunoState | PromiseLike<void | EnnoOdunoState>
  readonly runFinalVerification?: (input: { readonly event: DshTurnStoppingEvent; readonly state: EnnoOdunoState }) => void | EnnoOdunoState | PromiseLike<void | EnnoOdunoState>
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
  | { readonly kind: 'abort'; readonly reason: 'aborted' | 'stale_turn' | 'state_unavailable' | 'directive_missing' | 'stale_directive' | 'continuation_limit' | 'verification_failed' | 'context_injection_failed' }

const continuationText = 'Kiokuko の現在の処理は未完了です。提示された現在の指示に従って次の処理を実行し、完了を先取りしないでください。'

type ReplayScopeKey = object | string

interface ReplayScope {
  latestTurn: number
  readonly steers: Map<string, number>
  readonly steerIdentities: Map<string, { readonly nativeAgent?: object; readonly nativeSession?: object }>
  readonly turnInFlight: Map<number, {
    readonly nativeAgent?: object
    readonly nativeSession?: object
    readonly promise: Promise<DshTurnStoppingDecision>
  }>
}

function directiveKey(event: DshTurnStoppingEvent, state: EnnoOdunoState): string {
  return canonicalContentHash({
    agentId: event.agent.id,
    ...(event.agent.sessionId === undefined ? {} : { sessionId: event.agent.sessionId }),
    turn: event.turn,
    nextAction: state.nextAction,
    directive: state.directive,
    contractRevision: state.contractRevision,
    routeEpoch: state.routeEpoch,
  })
}

function textualScopeKey(event: DshTurnStoppingEvent): string {
  return canonicalContentHash({ agentId: event.agent.id, sessionId: event.agent.sessionId ?? null })
}

function replayScopeKey(event: DshTurnStoppingEvent): ReplayScopeKey {
  return event.agent.nativeSession ?? event.agent.nativeAgent ?? textualScopeKey(event)
}

function sameNativeIdentity(
  left: { readonly nativeAgent?: object; readonly nativeSession?: object },
  right: DshTurnStoppingEvent['agent'],
): boolean {
  return left.nativeAgent === right.nativeAgent && left.nativeSession === right.nativeSession
}

/** Own the awaited turn boundary and never convert an Enno error into a normal close. */
export class DshEnnoController {
  readonly #readState: DshEnnoControllerDependencies['readState']
  readonly #injectNextStepContext: NonNullable<DshEnnoControllerDependencies['injectNextStepContext']>
  readonly #maxSteersPerDirective: number
  readonly #advisoryRunner: DshAdvisoryRunner | undefined
  readonly #submitAdvisory: DshEnnoControllerDependencies['submitAdvisory']
  readonly #runFinalVerification: DshEnnoControllerDependencies['runFinalVerification']
  readonly #replayScopes = new Map<ReplayScopeKey, ReplayScope>()

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

  #scopeFor(event: DshTurnStoppingEvent): ReplayScope {
    const key = replayScopeKey(event)
    const existing = this.#replayScopes.get(key)
    if (existing !== undefined) return existing
    const scope: ReplayScope = {
      latestTurn: event.turn,
      steers: new Map(),
      steerIdentities: new Map(),
      turnInFlight: new Map(),
    }
    this.#replayScopes.set(key, scope)
    return scope
  }

  #isStaleTurn(scope: ReplayScope, event: DshTurnStoppingEvent): boolean {
    return event.turn < scope.latestTurn
  }

  async turnStopping(event: DshTurnStoppingEvent): Promise<DshTurnStoppingDecision> {
    if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
    const scope = this.#scopeFor(event)
    if (event.turn < scope.latestTurn) return { kind: 'abort', reason: 'stale_turn' }
    if (event.turn > scope.latestTurn) {
      // Advance the high-water mark before dropping keys from older turns.
      // The mark is synchronous, so a late older callback cannot re-enter the
      // state/verification/effect pipeline after this point.
      scope.latestTurn = event.turn
      scope.steers.clear()
      scope.steerIdentities.clear()
    }
    const existing = scope.turnInFlight.get(event.turn)
    if (existing !== undefined) {
      return sameNativeIdentity(existing, event.agent)
        ? existing.promise
        : { kind: 'abort', reason: 'state_unavailable' }
    }
    const promise = this.#decideTurnStopping(event, scope).finally(() => {
      if (scope.turnInFlight.get(event.turn)?.promise === promise) scope.turnInFlight.delete(event.turn)
    })
    scope.turnInFlight.set(event.turn, {
      ...(event.agent.nativeAgent === undefined ? {} : { nativeAgent: event.agent.nativeAgent }),
      ...(event.agent.nativeSession === undefined ? {} : { nativeSession: event.agent.nativeSession }),
      promise,
    })
    return promise
  }

  async #decideTurnStopping(event: DshTurnStoppingEvent, scope: ReplayScope): Promise<DshTurnStoppingDecision> {
    let state: EnnoOdunoState | null
    try {
      state = await this.#readState(event)
    } catch {
      return { kind: 'abort', reason: 'state_unavailable' }
    }
    if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
    if (this.#isStaleTurn(scope, event)) return { kind: 'abort', reason: 'stale_turn' }
    if (state === null || !state.applicable) return { kind: 'close', nextAction: 'complete' }
    const handler = DSH_ENNO_NEXT_ACTION_HANDLERS[state.nextAction]
    if (handler === undefined) return { kind: 'abort', reason: 'state_unavailable' }
    if (handler.kind === 'terminal') return { kind: 'close', nextAction: state.nextAction }
    if (state.directive === null) return { kind: 'abort', reason: 'directive_missing' }
    if ((state.contractRevision !== null && state.directive.contractRevision !== state.contractRevision)
      || (state.routeEpoch !== null && state.directive.routeEpoch !== state.routeEpoch)) {
      return { kind: 'abort', reason: 'stale_directive' }
    }
    let currentState = state
    let selection: DshDirectiveSourceSelection
    try {
      selection = selectDshDirectiveSources(state.directive)
      if (currentState.nextAction === 'run_final_verification') {
        if (this.#runFinalVerification === undefined) return { kind: 'abort', reason: 'state_unavailable' }
        try {
          const verified = await this.#runFinalVerification({ event, state: currentState })
          if (verified !== undefined) currentState = verified
        } catch {
          return { kind: 'abort', reason: 'verification_failed' }
        }
        if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
      }
      if (currentState.directive?.advisoryRound !== undefined) {
        if (this.#advisoryRunner === undefined || this.#submitAdvisory === undefined) return { kind: 'abort', reason: 'state_unavailable' }
        const advisory = await this.#advisoryRunner.run({ directive: currentState.directive.advisoryRound, signal: event.signal })
        if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
        const submitted = await this.#submitAdvisory(advisory, { event, state: currentState })
        if (submitted !== undefined) currentState = submitted
      }
      if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
      if (this.#isStaleTurn(scope, event)) return { kind: 'abort', reason: 'stale_turn' }
      const fresh = await this.#readState(event)
      if (this.#isStaleTurn(scope, event)) return { kind: 'abort', reason: 'stale_turn' }
      if (fresh === null || !fresh.applicable) return { kind: 'close', nextAction: 'complete' }
      const freshHandler = DSH_ENNO_NEXT_ACTION_HANDLERS[fresh.nextAction]
      if (freshHandler === undefined) return { kind: 'abort', reason: 'state_unavailable' }
      if (freshHandler.kind === 'terminal') return { kind: 'close', nextAction: fresh.nextAction }
      if (fresh.directive === null) return { kind: 'abort', reason: 'directive_missing' }
      if (fresh.contractRevision !== currentState.contractRevision || fresh.routeEpoch !== currentState.routeEpoch
        || fresh.nextAction !== currentState.nextAction
        || canonicalContentHash(fresh.directive) !== canonicalContentHash(currentState.directive)) {
        return { kind: 'abort', reason: 'stale_directive' }
      }
      currentState = fresh
      selection = selectDshDirectiveSources(fresh.directive)
    } catch {
      return { kind: 'abort', reason: 'context_injection_failed' }
    }

    // The fresh state, not the state read before verification/advisory work,
    // owns replay accounting and the next-step injection.
    if (this.#isStaleTurn(scope, event)) return { kind: 'abort', reason: 'stale_turn' }
    const key = directiveKey(event, currentState)
    const boundIdentity = scope.steerIdentities.get(key)
    if (boundIdentity !== undefined
      && (boundIdentity.nativeAgent !== event.agent.nativeAgent || boundIdentity.nativeSession !== event.agent.nativeSession)) {
      return { kind: 'abort', reason: 'state_unavailable' }
    }
    const used = scope.steers.get(key) ?? 0
    if (used >= this.#maxSteersPerDirective) return { kind: 'abort', reason: 'continuation_limit' }
    // Keys are scoped to the current native turn and are cleared only after
    // the high-water mark advances. This prevents replay while allowing an
    // unbounded sequence of independent turns.
    if (used === 0 && scope.steers.size >= 4_096) return { kind: 'abort', reason: 'continuation_limit' }
    try {
      await this.#injectNextStepContext({ event, selection, state: currentState })
    } catch {
      return { kind: 'abort', reason: 'context_injection_failed' }
    }
    if (event.signal.aborted) return { kind: 'abort', reason: 'aborted' }
    if (this.#isStaleTurn(scope, event)) return { kind: 'abort', reason: 'stale_turn' }
    // Claim immediately before the irreversible native steer. A throwing
    // steer remains consumed and cannot be retried automatically.
    scope.steers.set(key, used + 1)
    scope.steerIdentities.set(key, {
      ...(event.agent.nativeAgent === undefined ? {} : { nativeAgent: event.agent.nativeAgent }),
      ...(event.agent.nativeSession === undefined ? {} : { nativeSession: event.agent.nativeSession }),
    })
    event.agent.steer({ content: continuationText, source: 'kiokuko-dsh' })
    return { kind: 'steer', nextAction: currentState.nextAction, selection }
  }

  async handle(event: DshTurnStoppingEvent): Promise<DshTurnStoppingDecision> {
    const scope = this.#scopeFor(event)
    const existing = scope.turnInFlight.get(event.turn)
    const decision = await this.turnStopping(event)
    if (existing === undefined && decision.kind === 'abort' && decision.reason !== 'aborted' && decision.reason !== 'stale_turn') {
      event.agent.cancel?.(`kiokuko dsh Enno continuation stopped: ${decision.reason}`)
    }
    return decision
  }

  /** Release replay memory when the host retires a native lifecycle. */
  retire(identity: { readonly nativeAgent?: object; readonly nativeSession?: object }): void {
    if (identity.nativeSession !== undefined) this.#replayScopes.delete(identity.nativeSession)
    if (identity.nativeAgent !== undefined) this.#replayScopes.delete(identity.nativeAgent)
  }

  dispose(): void {
    this.#replayScopes.clear()
  }
}

export interface DshTurnStoppingContext {
  on(name: 'agent/turn-stopping', listener: (event: DshTurnStoppingEvent) => Promise<void>, options?: { readonly prepend?: boolean }): () => void
}

export function mountDshEnnoController(ctx: DshTurnStoppingContext, controller: DshEnnoController): () => void {
  return ctx.on('agent/turn-stopping', async (event) => { await controller.handle(event) }, { prepend: true })
}
