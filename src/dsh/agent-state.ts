import { createHash } from 'node:crypto'
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

const MAX_CONTINUATION_BINDINGS = 4_096

function validateIdentity(identity: DshAgentIdentity): void {
  if (typeof identity.dshSessionId !== 'string'
    || identity.dshSessionId.length === 0
    || identity.dshSessionId.length > 256
    || /[\p{Cc}\p{Cf}]/u.test(identity.dshSessionId)) {
    throw new KiokukoError('VALIDATION_ERROR', 'dshSessionId must be a bounded non-empty string')
  }
  if (!Number.isSafeInteger(identity.turn) || identity.turn < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'turn must be a non-negative safe integer')
  }
}

function validateBindingText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a bounded non-empty string`)
  }
}

function validateToken(token: string): void {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256 || /[\p{Cc}\p{Cf}]/u.test(token)) {
    throw new KiokukoError('VALIDATION_ERROR', 'resumeToken must be a bounded opaque value')
  }
}

export function dshAgentKey(identity: DshAgentIdentity): string {
  validateIdentity(identity)
  return `${identity.dshSessionId}\u0000${identity.turn}`
}

export function dshSessionEventSourceId(sessionId: string, sequence: number, incarnation: string): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(sessionId)
    || typeof incarnation !== 'string' || incarnation.length === 0 || incarnation.length > 256 || /[\p{Cc}\p{Cf}]/u.test(incarnation)
    || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Invalid dsh session event identity')
  }
  // Encode IDs containing either the delimiter or an escape marker twice so
  // `a:b` and `a%3Ab` cannot collapse to the same source identity.
  const encodedSessionId = /[:%]/u.test(sessionId)
    ? encodeURIComponent(encodeURIComponent(sessionId))
    : sessionId
  const encodedIncarnation = /[:%]/u.test(incarnation)
    ? encodeURIComponent(encodeURIComponent(incarnation))
    : incarnation
  const readable = `dsh:${encodedSessionId}:${encodedIncarnation}:${sequence}`
  if (readable.length <= 256) return readable
  // Ledger identifiers are bounded independently of the two native identity
  // fields. Hash only the oversized spelling; the digest still binds the
  // exact session/incarnation/sequence tuple without truncation collisions.
  const digest = createHash('sha256')
    .update(sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(incarnation, 'utf8')
    .update('\0', 'utf8')
    .update(String(sequence), 'utf8')
    .digest('hex')
  return `dsh:${digest}:${sequence}`
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
    validateBindingText(binding.runId, 'runId')
    validateBindingText(binding.workspace, 'workspace')
    if (!Number.isSafeInteger(binding.routeEpoch) || binding.routeEpoch < 0) throw new KiokukoError('VALIDATION_ERROR', 'routeEpoch is invalid')
    const existing = this.#bindings.get(binding.resumeToken)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(binding)) throw new KiokukoError('CONFLICT', 'resumeToken is already bound to another run')
    if (existing === undefined && this.#bindings.size >= MAX_CONTINUATION_BINDINGS) {
      throw new KiokukoError('SERVICE_UNAVAILABLE', 'dsh continuation capacity is exhausted; close or restart the runtime before resuming more runs')
    }
    this.#bindings.set(binding.resumeToken, Object.freeze({ ...binding }))
  }

  resolve(input: { readonly resumeToken: string; readonly dshSessionId: string; readonly runId: string; readonly workspace: string; readonly routeEpoch: number }): DshContinuationBinding {
    validateToken(input.resumeToken)
    validateIdentity({ dshSessionId: input.dshSessionId, turn: 0 })
    validateBindingText(input.runId, 'runId')
    validateBindingText(input.workspace, 'workspace')
    if (!Number.isSafeInteger(input.routeEpoch) || input.routeEpoch < 0) throw new KiokukoError('VALIDATION_ERROR', 'routeEpoch is invalid')
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
    validateIdentity({ dshSessionId: input.dshSessionId, turn: 0 })
    validateBindingText(input.runId, 'runId')
    validateBindingText(input.workspace, 'workspace')
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
