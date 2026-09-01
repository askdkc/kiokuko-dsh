import { KiokukoError } from '../errors.js'

export interface DshAgentIdentity {
  readonly dshSessionId: string
  readonly turn: number
}

export interface DshAgentState extends DshAgentIdentity {
  readonly key: string
  readonly repositoryId: string
  readonly workspace: string
  readonly openedAt: string
}

export interface DshContinuationBinding {
  readonly resumeToken: string
  readonly dshSessionId: string
  readonly runId: string
  readonly workspace: string
  readonly routeEpoch: number
}

function validateIdentity(identity: DshAgentIdentity): void {
  if (typeof identity.dshSessionId !== 'string'
    || identity.dshSessionId.length === 0
    || identity.dshSessionId.length > 256
    || identity.dshSessionId.includes('\0')) {
    throw new KiokukoError('VALIDATION_ERROR', 'dshSessionId must be a bounded non-empty string')
  }
  if (!Number.isSafeInteger(identity.turn) || identity.turn < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'turn must be a non-negative safe integer')
  }
}

function validateToken(token: string): void {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256 || /[\p{Cc}]/u.test(token)) {
    throw new KiokukoError('VALIDATION_ERROR', 'resumeToken must be a bounded opaque value')
  }
}

export function dshAgentKey(identity: DshAgentIdentity): string {
  validateIdentity(identity)
  return `${identity.dshSessionId}\u0000${identity.turn}`
}

export function dshSessionEventSourceId(sessionId: string, sequence: number): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes(':') || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Invalid dsh session event identity')
  }
  return `dsh:${sessionId}:${sequence}`
}

/** Own one active agent state per dsh session/turn identity. */
export class DshAgentStateRegistry {
  readonly #states = new Map<string, DshAgentState>()

  open(identity: DshAgentIdentity, repositoryId: string, workspace: string, now = new Date().toISOString()): DshAgentState {
    const key = dshAgentKey(identity)
    if (this.#states.has(key)) {
      throw new KiokukoError('CONFLICT', 'The dsh session turn already has an active runtime state')
    }
    const state = Object.freeze({
      ...identity,
      key,
      repositoryId,
      workspace,
      openedAt: now,
    })
    this.#states.set(key, state)
    return state
  }

  get(identity: DshAgentIdentity): DshAgentState | undefined {
    return this.#states.get(dshAgentKey(identity))
  }

  close(identity: DshAgentIdentity): boolean {
    return this.#states.delete(dshAgentKey(identity))
  }

  closeAll(): void {
    this.#states.clear()
  }

  get size(): number {
    return this.#states.size
  }
}

/** Keep plaintext continuation tokens in process memory and bind them to exact run identity. */
export class DshContinuationRegistry {
  readonly #bindings = new Map<string, DshContinuationBinding>()

  bind(binding: DshContinuationBinding): void {
    validateToken(binding.resumeToken)
    validateIdentity({ dshSessionId: binding.dshSessionId, turn: 0 })
    if (!Number.isSafeInteger(binding.routeEpoch) || binding.routeEpoch < 0) throw new KiokukoError('VALIDATION_ERROR', 'routeEpoch is invalid')
    const existing = this.#bindings.get(binding.resumeToken)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) throw new KiokukoError('CONFLICT', 'resumeToken is already bound to another run')
    this.#bindings.set(binding.resumeToken, Object.freeze({ ...binding }))
  }

  resolve(input: { readonly resumeToken: string; readonly dshSessionId: string; readonly runId: string; readonly workspace: string; readonly routeEpoch: number }): DshContinuationBinding {
    validateToken(input.resumeToken)
    const binding = this.#bindings.get(input.resumeToken)
    if (binding === undefined
      || binding.dshSessionId !== input.dshSessionId
      || binding.runId !== input.runId
      || binding.workspace !== input.workspace
      || binding.routeEpoch !== input.routeEpoch) throw new KiokukoError('CONFLICT', 'resumeToken does not match the exact dsh route')
    return binding
  }

  resolveExact(input: { readonly resumeToken: string; readonly dshSessionId: string; readonly runId: string; readonly workspace: string }): DshContinuationBinding {
    validateToken(input.resumeToken)
    const binding = this.#bindings.get(input.resumeToken)
    if (binding === undefined
      || binding.dshSessionId !== input.dshSessionId
      || binding.runId !== input.runId
      || binding.workspace !== input.workspace) throw new KiokukoError('CONFLICT', 'resumeToken does not match the exact dsh route')
    return binding
  }

  clear(resumeToken?: string): void {
    if (resumeToken === undefined) this.#bindings.clear()
    else this.#bindings.delete(resumeToken)
  }

  get size(): number {
    return this.#bindings.size
  }
}
