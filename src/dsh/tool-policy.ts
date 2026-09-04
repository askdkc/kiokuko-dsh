import { KiokukoError } from '../errors.js'
import type { EnnoNextAction } from '../enno-oduno/types.js'
import {
  DSH_MODEL_FACING_OPERATIONS,
  bindDshToolInvocation,
  type DshToolExecution,
  type DshNativeToolExecution,
  type DshToolHostBinding,
  isDshModelFacingOperation,
} from './tools.js'

export type DshToolPhase = 'intake' | 'ideal' | 'planning' | 'confirmation' | 'goki' | 'verifying' | 'meditation' | 'completed' | 'blocked' | 'cancelled'

export interface DshToolPolicyState extends Omit<DshToolHostBinding, 'idempotencyKey'> {
  readonly phase: DshToolPhase
  readonly nativeTurn?: number
  readonly currentWorkUnitId?: string
  readonly dshSessionId?: string
  readonly nextAction?: EnnoNextAction
}

export type DshToolPolicyDenyCode = 'UNLOADED' | 'UNKNOWN_TOOL' | 'WRONG_PHASE' | 'WRONG_DIRECTIVE' | 'STALE_STATE' | 'LEASE_REQUIRED' | 'CANCELLED' | 'IDENTITY_INJECTION' | 'TURN_SEALED'

export type DshToolPolicyDecision =
  | { readonly kind: 'allow'; readonly binding: DshToolHostBinding }
  | { readonly kind: 'deny'; readonly code: DshToolPolicyDenyCode; readonly reason: string }

export interface DshToolPolicyContext {
  readonly tools: {
    guard(guard: (execution: DshToolExecution | DshNativeToolExecution) => string | undefined): () => void
  }
  readonly on?: (name: 'tools/pre-execute', listener: (execution: DshToolExecution | DshNativeToolExecution, next: () => Promise<unknown>) => Promise<unknown>, options?: { readonly prepend?: boolean }) => () => void
}

const phaseAllowlist: Readonly<Record<DshToolPhase, readonly string[]>> = Object.freeze({
  intake: [],
  ideal: ['enno_ideal_submit'],
  planning: ['enno_plan_submit'],
  confirmation: [],
  goki: ['enno_work_report', 'curator_check', 'memory_checkpoint'],
  verifying: ['enno_finish', 'curator_check', 'memory_checkpoint'],
  meditation: ['enno_meditation_submit'],
  completed: [],
  blocked: [],
  cancelled: [],
})

const directiveOperation: Readonly<Partial<Record<EnnoNextAction, string>>> = Object.freeze({
  submit_ideal: 'enno_ideal_submit',
  submit_plan: 'enno_plan_submit',
  execute_work_unit: 'enno_work_report',
  submit_final_review: 'enno_finish',
  submit_meditation: 'enno_meditation_submit',
})

function denied(code: DshToolPolicyDenyCode, reason: string): DshToolPolicyDecision {
  return { kind: 'deny', code, reason }
}

function publicReason(code: DshToolPolicyDenyCode): string {
  return `Kiokuko dsh tool denied (${code.toLowerCase()})`
}

/** Own the monotonic policy decision without granting authority to the caller. */
export class DshToolPolicy {
  #state: DshToolPolicyState | undefined
  readonly #states = new Map<string, DshToolPolicyState>()
  readonly #sealedTurns = new Map<string, { readonly nativeTurn: number; readonly receiptId: string }>()
  #disposed = false

  constructor(state: DshToolPolicyState) {
    this.#storeState(state)
  }

  #storeState(state: DshToolPolicyState): void {
    const frozen = Object.freeze({ ...state })
    this.#state = frozen
    if (state.dshSessionId !== undefined) {
      this.#states.set(state.dshSessionId, frozen)
      if (state.nativeTurn !== undefined) this.beginTurn(state.dshSessionId, state.nativeTurn)
    }
  }

  setState(state: DshToolPolicyState): void {
    if (this.#disposed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh tool policy is disposed')
    this.#storeState(state)
  }

  dispose(): void {
    this.#disposed = true
    this.#state = undefined
    this.#states.clear()
    this.#sealedTurns.clear()
  }

  /** Release the per-session snapshot after its run has reached a terminal state. */
  clearSession(sessionId: string): void {
    this.#states.delete(sessionId)
    this.#sealedTurns.delete(sessionId)
    if (this.#state?.dshSessionId === sessionId) this.#state = undefined
  }

  /** A later native turn supersedes an older seal; the same turn never does. */
  beginTurn(sessionId: string, nativeTurn: number): void {
    if (!Number.isSafeInteger(nativeTurn) || nativeTurn < 1) throw new KiokukoError('VALIDATION_ERROR', 'native turn is invalid')
    const current = this.#sealedTurns.get(sessionId)
    if (current !== undefined && nativeTurn > current.nativeTurn) this.#sealedTurns.delete(sessionId)
  }

  /** Seal every not-yet-started tool after the first committed phase result. */
  sealSession(sessionId: string, nativeTurn: number, receiptId: string): void {
    if (this.#disposed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh tool policy is disposed')
    if (!Number.isSafeInteger(nativeTurn) || nativeTurn < 1 || !/^[0-9a-f]{64}$/u.test(receiptId)) {
      throw new KiokukoError('VALIDATION_ERROR', 'turn seal identity is invalid')
    }
    const existing = this.#sealedTurns.get(sessionId)
    if (existing !== undefined) {
      if (existing.nativeTurn !== nativeTurn || existing.receiptId !== receiptId) {
        throw new KiokukoError('CONFLICT', 'DSH turn was sealed by another receipt')
      }
      return
    }
    this.#sealedTurns.set(sessionId, Object.freeze({ nativeTurn, receiptId }))
  }

  sealedReason(execution: DshToolExecution): string | undefined {
    const sessionId = execution.agent?.dshSessionId
    if (sessionId === undefined) return undefined
    const seal = this.#sealedTurns.get(sessionId)
    if (seal === undefined) return undefined
    const stateTurn = this.#states.get(sessionId)?.nativeTurn
    const executionTurn = execution.agent?.turn ?? stateTurn
    return executionTurn === seal.nativeTurn ? publicReason('TURN_SEALED') : undefined
  }

  decide(execution: DshToolExecution): DshToolPolicyDecision {
    if (this.#disposed) return denied('UNLOADED', publicReason('UNLOADED'))
    const state = execution.agent === undefined
      ? this.#state
      : this.#states.get(execution.agent.dshSessionId)
        ?? (this.#state?.dshSessionId === undefined ? this.#state : undefined)
    if (state === undefined) return denied('STALE_STATE', publicReason('STALE_STATE'))
    // A native execution always carries a session object that the host must
    // have bound into policy state. A run-only snapshot cannot authorize it.
    if (execution.agent !== undefined && state.dshSessionId === undefined) {
      return denied('STALE_STATE', publicReason('STALE_STATE'))
    }
    if (execution.signal.aborted) return denied('CANCELLED', publicReason('CANCELLED'))
    if (!isDshModelFacingOperation(execution.name)) {
      return denied('UNKNOWN_TOOL', publicReason('UNKNOWN_TOOL'))
    }
    if (state.nextAction !== undefined && execution.origin !== 'host') {
      const expected = directiveOperation[state.nextAction]
      if (expected === undefined) return denied('STALE_STATE', publicReason('STALE_STATE'))
      if (expected !== execution.name) return denied('WRONG_DIRECTIVE', publicReason('WRONG_DIRECTIVE'))
    }
    const allowedOperations = phaseAllowlist[state.phase]
    if (allowedOperations === undefined) return denied('STALE_STATE', publicReason('STALE_STATE'))
    if (!allowedOperations.includes(execution.name)) {
      return denied('WRONG_PHASE', publicReason('WRONG_PHASE'))
    }
    if (execution.name === 'enno_work_report'
      && (state.currentWorkUnitId === undefined || state.workUnitId !== state.currentWorkUnitId || state.leaseToken === undefined)) {
      return denied('LEASE_REQUIRED', publicReason('LEASE_REQUIRED'))
    }
    if (execution.agent !== undefined && state.dshSessionId !== undefined
      && execution.agent.dshSessionId !== state.dshSessionId && execution.origin !== 'host') {
      return denied('STALE_STATE', publicReason('STALE_STATE'))
    }
    try {
      return { kind: 'allow', binding: bindDshToolInvocation(execution, state) }
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') {
        return denied('IDENTITY_INJECTION', publicReason('IDENTITY_INJECTION'))
      }
      if (error instanceof KiokukoError && error.code === 'CONFLICT') {
        return denied('STALE_STATE', publicReason('STALE_STATE'))
      }
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
        return denied('STALE_STATE', publicReason('STALE_STATE'))
      }
      throw error
    }
  }

  guardReason(execution: DshToolExecution): string | undefined {
    const sealed = this.sealedReason(execution)
    if (sealed !== undefined) return sealed
    if (!isDshModelFacingOperation(execution.name)) return undefined
    const decision = this.decide(execution)
    return decision.kind === 'deny' ? decision.reason : undefined
  }
}

/** Install a final monotonic guard; later waterfall listeners cannot allow a denied call. */
export function mountDshToolPolicy(ctx: DshToolPolicyContext, policy: DshToolPolicy): () => void {
  const guardDisposer = ctx.tools.guard((execution) => {
    try {
      return policy.guardReason(normalizePolicyExecution(execution))
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') return publicReason('STALE_STATE')
      throw error
    }
  })
  const preExecuteDisposer = ctx.on?.('tools/pre-execute', async (execution, next) => {
    let normalized: DshToolExecution
    try {
      normalized = normalizePolicyExecution(execution)
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') return { kind: 'deny', reason: publicReason('STALE_STATE') }
      throw error
    }
    const sealed = policy.sealedReason(normalized)
    if (sealed !== undefined) return { kind: 'deny', reason: sealed }
    if (!isDshModelFacingOperation(normalized.name)) return next()
    const decision = policy.decide(normalized)
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    return next()
  }, { prepend: true })
  return () => {
    preExecuteDisposer?.()
    guardDisposer()
  }
}

function normalizePolicyExecution(execution: DshToolExecution | DshNativeToolExecution): DshToolExecution {
  if (execution.agent === undefined || !('id' in execution.agent)) return execution as DshToolExecution
  const session = execution.agent.session
  if (session === undefined || typeof session.id !== 'string' || session.id.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'dsh native tool execution is missing its authoritative session')
  }
  return {
      callId: execution.callId,
      ...(execution.rootCallId === undefined ? {} : { rootCallId: execution.rootCallId }),
      name: execution.name,
    arguments: execution.arguments,
    agent: {
        dshSessionId: session.id,
        nativeSession: session,
    },
      ...(execution.parent === undefined ? {} : { parent: execution.parent }),
      signal: execution.signal,
  }
}

export function dshToolPhaseAllowlist(phase: DshToolPhase): readonly string[] {
  return phaseAllowlist[phase]
}

export const DSH_TOOL_OPERATION_COUNT = DSH_MODEL_FACING_OPERATIONS.length
