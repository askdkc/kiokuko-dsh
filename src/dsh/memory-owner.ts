import { KiokukoError } from '../errors.js'
import type { TaskType } from '../akinator/types.js'
import type { RequestIntentDecision } from './decisions/request-intent.js'

export type MemoryOwnerKind = 'conversation' | 'execution' | 'none'

export interface MemoryOwnerBinding {
  readonly kind: MemoryOwnerKind
  readonly agentId: string
  readonly sessionId: string
  readonly turn: number
  readonly requestDigest: string
  readonly runId?: string
}

export interface MemoryOwnerIdentity {
  readonly agentId: string
  readonly sessionId: string
  readonly turn: number
  readonly requestDigest: string
  readonly runId?: string
}

/** Choose one memory path once from the bounded intent result; unknown intent owns none. */
export function memoryOwnerKind(intent: RequestIntentDecision | undefined, taskType: TaskType | null | undefined): MemoryOwnerKind {
  if (intent?.relation === 'unknown' || intent?.action === 'unknown') return 'none'
  switch (intent?.action) {
    case 'answer': return 'conversation'
    case 'research': case 'verify': case 'change': case 'operate': return 'execution'
  }
  if (taskType === 'chat') return 'conversation'
  if (taskType !== undefined && taskType !== null) return 'execution'
  return 'none'
}

export function createMemoryOwner(kind: MemoryOwnerKind, identity: MemoryOwnerIdentity): MemoryOwnerBinding {
  if (!identity.agentId || !identity.sessionId || !Number.isSafeInteger(identity.turn) || identity.turn < 1
    || !/^[a-f0-9]{64}$/u.test(identity.requestDigest)
    || (kind === 'execution' && !identity.runId)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Memory owner identity is incomplete')
  }
  return Object.freeze({ kind, ...identity })
}

/** An owner cannot be borrowed across an agent, native session, turn, request, or run. */
export function assertMemoryOwner(owner: MemoryOwnerBinding, identity: MemoryOwnerIdentity, expectedKind?: MemoryOwnerKind): void {
  if (expectedKind !== undefined && owner.kind !== expectedKind
    || owner.agentId !== identity.agentId || owner.sessionId !== identity.sessionId || owner.turn !== identity.turn
    || owner.requestDigest !== identity.requestDigest || owner.runId !== identity.runId) {
    throw new KiokukoError('CONFLICT', 'memory_owner_changed')
  }
}
