import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'

export type DshLoopGuardDecision = 'deliver' | 'replan' | 'wait_user' | 'blocked'

export interface DshLoopGuardClaim {
  readonly claimId: string
  readonly decision: DshLoopGuardDecision
  readonly ordinal: number
  readonly generation: number
  readonly recovered: boolean
  readonly replayed: boolean
}

interface LoopClaimRow extends Record<string, unknown> {
  decision: DshLoopGuardDecision
  ordinal: number
  generation: number
  resolution: 'user_answer' | 'manual_user' | 'superseded' | null
}

function identity(value: string, label: string, maximum = 256): string {
  if (value.length === 0 || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} is invalid`)
  }
  return value
}

function digest(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new KiokukoError('VALIDATION_ERROR', `${label} must be a SHA-256 digest`)
  return value
}

export function claimAutomaticContinuationInTransaction(
  database: SqliteDatabase,
  input: {
    readonly claimId: string
    readonly runId: string
    readonly dshSessionId: string
    readonly instructionDigest: string
    readonly progressDigest: string
    /** Optional cap for this instruction across all observations until new human input. */
    readonly deliveryLimit?: number
    readonly now?: string
  },
): DshLoopGuardClaim {
  const claimId = digest(input.claimId, 'claimId')
  const runId = identity(input.runId, 'runId')
  const dshSessionId = identity(input.dshSessionId, 'dshSessionId')
  const instructionDigest = digest(input.instructionDigest, 'instructionDigest')
  const progressDigest = digest(input.progressDigest, 'progressDigest')
  const existingClaim = database.prepare(`
    SELECT decision, ordinal, generation, resolution, run_id AS runId, dsh_session_id AS sessionId
      FROM dsh_loop_guard_claims WHERE claim_id = ?
  `).get<LoopClaimRow & { runId: string; sessionId: string }>(claimId)
  if (existingClaim !== undefined) {
    if (existingClaim.runId !== runId || existingClaim.sessionId !== dshSessionId)
      throw new KiokukoError('CONFLICT', 'Continuation claim belongs to a different run or session')
    return Object.freeze({
      claimId,
      decision: existingClaim.resolution === 'user_answer' ? 'deliver' : existingClaim.decision,
      ordinal: existingClaim.ordinal,
      generation: existingClaim.generation,
      recovered: existingClaim.resolution === 'user_answer',
      replayed: true,
    })
  }

  const now = input.now ?? new Date().toISOString()
  database.prepare(`
    INSERT OR IGNORE INTO dsh_loop_guard_states (
      run_id, dsh_session_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(runId, dshSessionId, now, now)
  const state = database.prepare(`
    SELECT generation, automatic_count AS automaticCount FROM dsh_loop_guard_states
    WHERE run_id = ? AND dsh_session_id = ?
  `).get<{ generation: number; automaticCount: number }>(runId, dshSessionId)!
  const { generation } = state
  const previous = database.prepare(`
    SELECT max(CASE WHEN decision IN ('replan','blocked') THEN 2 ELSE 1 END) AS attempts
    FROM dsh_loop_guard_claims
    WHERE run_id = ? AND dsh_session_id = ? AND generation = ?
      AND policy_version = 2 AND progress_digest = ?
  `).get<{ attempts: number | null }>(runId, dshSessionId, generation, progressDigest)?.attempts
  const limitReached = input.deliveryLimit !== undefined && database.prepare(`
    SELECT count(*) AS deliveries FROM dsh_loop_guard_claims
    WHERE run_id = ? AND dsh_session_id = ? AND generation = ? AND instruction_digest = ?
      AND decision IN ('deliver', 'replan')
  `).get<{ deliveries: number }>(runId, dshSessionId, generation, instructionDigest)!.deliveries >= input.deliveryLimit
  const decision = limitReached || previous === 2 ? 'blocked' : previous === 1 ? 'replan' : 'deliver'
  const ordinal = state.automaticCount + 1
  database.prepare(`
    UPDATE dsh_loop_guard_states
       SET instruction_digest = ?, automatic_count = ?, status = ?, blocked_claim_id = ?, updated_at = ?
     WHERE run_id = ? AND dsh_session_id = ?
  `).run(instructionDigest, ordinal, decision === 'blocked' ? 'blocked' : 'active',
    decision === 'blocked' ? claimId : null, now, runId, dshSessionId)
  database.prepare(`
    INSERT INTO dsh_loop_guard_claims (
      claim_id, run_id, dsh_session_id, instruction_digest, generation, ordinal,
      decision, created_at, progress_digest, policy_version, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
  `).run(claimId, runId, dshSessionId, instructionDigest, generation, ordinal, decision, now, progressDigest,
    limitReached ? 'delivery_limit' : decision === 'deliver' ? 'new_observation' : 'no_progress')
  return Object.freeze({ claimId, decision, ordinal, generation, recovered: false, replayed: false })
}

export function resetLoopGuardForUserInTransaction(
  database: SqliteDatabase,
  input: {
    readonly runId: string
    readonly dshSessionId: string
    readonly resolution: 'user_answer' | 'manual_user' | 'superseded'
    readonly claimId?: string
    readonly now?: string
  },
): void {
  const runId = identity(input.runId, 'runId')
  const dshSessionId = identity(input.dshSessionId, 'dshSessionId')
  const now = input.now ?? new Date().toISOString()
  const claimId = input.claimId === undefined ? undefined : digest(input.claimId, 'claimId')
  if (claimId !== undefined) {
    database.prepare(`
      UPDATE dsh_loop_guard_claims
         SET resolution = ?, resolved_at = ?
       WHERE claim_id = ? AND run_id = ? AND dsh_session_id = ? AND resolution IS NULL
    `).run(input.resolution, now, claimId, runId, dshSessionId)
  } else {
    database.prepare(`
      UPDATE dsh_loop_guard_claims
         SET resolution = ?, resolved_at = ?
       WHERE run_id = ? AND dsh_session_id = ? AND decision = 'wait_user' AND resolution IS NULL
    `).run(input.resolution, now, runId, dshSessionId)
  }
  database.prepare(`
    UPDATE dsh_loop_guard_states
       SET instruction_digest = NULL, generation = generation + 1,
           automatic_count = 0, status = 'active', blocked_claim_id = NULL, updated_at = ?
     WHERE run_id = ? AND dsh_session_id = ?
  `).run(now, runId, dshSessionId)
}
