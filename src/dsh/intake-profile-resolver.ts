import path from 'node:path'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { deriveProfile } from '../akinator/domain.js'
import type { TaskProfile, TaskType } from '../akinator/types.js'

export interface GroundedIntakeProfileInput {
  readonly task: string
  readonly cwd: string
  readonly profileHints?: Partial<TaskProfile>
  readonly evidence?: readonly string[]
}

export interface GroundedIntakeProfile {
  readonly task: string
  readonly cwd: string
  readonly profileHints: TaskProfile
  readonly evidence: readonly string[]
}

export interface DshTurnIdentity {
  readonly dshSessionId: string
  readonly turn: number
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message)
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /[\p{Cc}]/u.test(value)) validation(`${label} must be a bounded non-empty string`)
  return value.trim()
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  return boundedText(value, 'profile hint', 4_000)
}

/** Resolve only from the task, canonical cwd, supplied hints, and bounded evidence. */
export function resolveGroundedIntakeProfile(input: GroundedIntakeProfileInput): GroundedIntakeProfile {
  const task = boundedText(input.task, 'task', 64 * 1024)
  const cwd = boundedText(input.cwd, 'cwd', 4_096)
  if (!path.isAbsolute(cwd)) validation('cwd must be absolute')
  const hints = input.profileHints ?? {}
  const profile = deriveProfile(task, {
    taskType: hints.taskType ?? null,
    target: optionalText(hints.target),
    expected: optionalText(hints.expected),
    constraints: optionalText(hints.constraints),
  })
  const evidence = input.evidence ?? []
  if (!Array.isArray(evidence) || evidence.length > 32) validation('evidence must be a bounded string array')
  const boundedEvidence = evidence.map((item) => boundedText(item, 'evidence', 8_192))
  return Object.freeze({ task, cwd, profileHints: Object.freeze(profile), evidence: Object.freeze(boundedEvidence) })
}

/** Stable logical request identity: the same session/turn replays, a new turn never does. */
export function dshTurnRequestId(identity: DshTurnIdentity): string {
  const dshSessionId = boundedText(identity.dshSessionId, 'dshSessionId', 256)
  if (!Number.isSafeInteger(identity.turn) || identity.turn < 0) validation('turn must be a non-negative safe integer')
  return `dsh-turn-${canonicalContentHash({ version: 1, dshSessionId, turn: identity.turn })}`
}
