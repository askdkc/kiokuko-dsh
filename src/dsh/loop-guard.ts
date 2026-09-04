import type { SqliteDatabase } from '../db/adapter.js'
import type { EnnoOdunoState, EnnoRunSnapshot, RoleDirective } from '../enno-oduno/types.js'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { DshBoundaryJob } from './turn-process.js'

export const DSH_AUTOMATIC_CONTINUATION_LIMIT = 3

export type DshLoopGuardDecision = 'deliver' | 'wait_user'

export interface DshLoopGuardClaim {
  readonly claimId: string
  readonly decision: DshLoopGuardDecision
  readonly ordinal: number
  readonly generation: number
  readonly recovered: boolean
  readonly replayed: boolean
}

export interface DshBoundaryEffectClaim {
  readonly decision: DshLoopGuardDecision
  readonly ordinal: number
}

interface LoopStateRow extends Record<string, unknown> {
  instructionDigest: string | null
  generation: number
  automaticCount: number
  status: 'active' | 'waiting_user'
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

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : omitUndefined(item))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, omitUndefined(child)]),
  )
}

/**
 * Hash only authoritative progress. Native turn IDs, receipts, validation
 * input/failure digests, error prose, and raw task text are deliberately absent.
 */
export function ennoInstructionDigest(snapshot: EnnoRunSnapshot, directive: RoleDirective | null): string {
  const currentWorkUnitId = directive?.workUnit?.id ?? null
  const currentWorkUnit = currentWorkUnitId === null
    ? null
    : snapshot.workUnits.find((candidate) => candidate.workUnit.id === currentWorkUnitId) ?? null
  return canonicalContentHash(omitUndefined({
    contractRevision: snapshot.revision,
    mutationRevision: snapshot.mutationRevision,
    routeEpoch: snapshot.routeEpoch ?? 0,
    status: snapshot.status,
    attempts: snapshot.attempts,
    currentWorkUnit: currentWorkUnit === null ? null : {
      id: currentWorkUnit.workUnit.id,
      status: currentWorkUnit.status,
      attemptCount: currentWorkUnit.attemptCount,
    },
    finalEvidenceReady: snapshot.finalEvidenceReady,
    finalEvidence: snapshot.finalEvidence.map((item) => ({
      status: item.status,
      stdoutDigest: item.stdoutDigest,
      stderrDigest: item.stderrDigest,
      changedDuringVerification: item.changedDuringVerification ?? false,
    })),
    advisoryPhaseState: snapshot.advisoryPhaseState ?? { state: 'not_started' },
    directive,
  }))
}

/** Compatibility digest for the legacy controller, which owns no core DB. */
export function ennoStateInstructionDigest(state: EnnoOdunoState): string {
  return canonicalContentHash(omitUndefined({
    status: state.status ?? null,
    contractRevision: state.contractRevision ?? null,
    routeEpoch: state.routeEpoch ?? null,
    currentRole: state.currentRole ?? null,
    nextAction: state.nextAction,
    advisoryPhaseState: state.advisoryPhaseState ?? { state: 'not_started' },
    directive: state.directive ?? null,
  }))
}

export function claimAutomaticContinuationInTransaction(
  database: SqliteDatabase,
  input: {
    readonly claimId: string
    readonly runId: string
    readonly dshSessionId: string
    readonly instructionDigest: string
    readonly now?: string
  },
): DshLoopGuardClaim {
  const claimId = digest(input.claimId, 'claimId')
  const runId = identity(input.runId, 'runId')
  const dshSessionId = identity(input.dshSessionId, 'dshSessionId')
  const instructionDigest = digest(input.instructionDigest, 'instructionDigest')
  const existingClaim = database.prepare(`
    SELECT decision, ordinal, generation, resolution
      FROM dsh_loop_guard_claims WHERE claim_id = ?
  `).get<LoopClaimRow>(claimId)
  if (existingClaim !== undefined) {
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
  let state = database.prepare(`
    SELECT instruction_digest AS instructionDigest, generation,
           automatic_count AS automaticCount, status
      FROM dsh_loop_guard_states
     WHERE run_id = ? AND dsh_session_id = ?
  `).get<LoopStateRow>(runId, dshSessionId)
  if (state === undefined) {
    database.prepare(`
      INSERT INTO dsh_loop_guard_states (
        run_id, dsh_session_id, instruction_digest, generation,
        automatic_count, status, blocked_claim_id, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 0, 'active', NULL, ?, ?)
    `).run(runId, dshSessionId, instructionDigest, now, now)
    state = { instructionDigest, generation: 0, automaticCount: 0, status: 'active' }
  }

  const sameInstruction = state.instructionDigest === instructionDigest
  const generation = sameInstruction ? state.generation : state.generation + 1
  const previousCount = sameInstruction ? state.automaticCount : 0
  const ordinal = Math.min(previousCount + 1, DSH_AUTOMATIC_CONTINUATION_LIMIT + 1)
  const decision: DshLoopGuardDecision = previousCount >= DSH_AUTOMATIC_CONTINUATION_LIMIT
    ? 'wait_user'
    : 'deliver'
  const automaticCount = decision === 'deliver' ? ordinal : DSH_AUTOMATIC_CONTINUATION_LIMIT

  database.prepare(`
    UPDATE dsh_loop_guard_states
       SET instruction_digest = ?, generation = ?, automatic_count = ?,
           status = ?, blocked_claim_id = ?, updated_at = ?
     WHERE run_id = ? AND dsh_session_id = ?
  `).run(
    instructionDigest,
    generation,
    automaticCount,
    decision === 'deliver' ? 'active' : 'waiting_user',
    decision === 'wait_user' ? claimId : null,
    now,
    runId,
    dshSessionId,
  )
  database.prepare(`
    INSERT INTO dsh_loop_guard_claims (
      claim_id, run_id, dsh_session_id, instruction_digest,
      generation, ordinal, decision, resolution, created_at, question_asked_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)
  `).run(claimId, runId, dshSessionId, instructionDigest, generation, ordinal, decision, now)
  return Object.freeze({ claimId, decision, ordinal, generation, recovered: false, replayed: false })
}

/** Claim the one allowed UI question before crossing the external question boundary. */
export function claimLoopRecoveryQuestionInTransaction(
  database: SqliteDatabase,
  claimIdValue: string,
  now = new Date().toISOString(),
): boolean {
  const claimId = digest(claimIdValue, 'claimId')
  const changed = database.prepare(`
    UPDATE dsh_loop_guard_claims
       SET question_asked_at = ?
     WHERE claim_id = ? AND decision = 'wait_user'
       AND question_asked_at IS NULL AND resolution IS NULL
    RETURNING claim_id AS claimId
  `).get<{ claimId: string }>(now, claimId)
  return changed !== undefined
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
  // The older resume limiter remains a secondary automatic bound, but an
  // explicit user intervention starts a new recovery generation there too.
  database.prepare(`
    UPDATE enno_dsh_continuations
       SET continuation_count = 0, total_count = 0, updated_at = ?
     WHERE run_id = ? AND dsh_session_id = ?
  `).run(now, runId, dshSessionId)
}

export function claimBoundaryEffectInTransaction(
  database: SqliteDatabase,
  job: DshBoundaryJob,
  progressDigestValue: string,
  now = new Date().toISOString(),
): DshBoundaryEffectClaim {
  const progressDigest = digest(progressDigestValue, 'progressDigest')
  const row = database.prepare(`
    SELECT progress_digest AS progressDigest, progress_count AS progressCount,
           progress_claim_attempt AS progressClaimAttempt, progress_waiting AS progressWaiting
      FROM dsh_boundary_jobs
     WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?
  `).get<{
    progressDigest: string | null
    progressCount: number
    progressClaimAttempt: number | null
    progressWaiting: number
  }>(job.jobId, job.ownerNonce)
  if (row === undefined) throw new KiokukoError('CONFLICT', 'Boundary effect lease changed before progress claim')
  if (row.progressClaimAttempt === job.attemptCount) {
    return Object.freeze({
      decision: row.progressWaiting === 1 ? 'wait_user' : 'deliver',
      ordinal: row.progressWaiting === 1 ? DSH_AUTOMATIC_CONTINUATION_LIMIT + 1 : row.progressCount,
    })
  }
  const previousCount = row.progressDigest === progressDigest ? row.progressCount : 0
  const ordinal = Math.min(previousCount + 1, DSH_AUTOMATIC_CONTINUATION_LIMIT + 1)
  const decision: DshLoopGuardDecision = previousCount >= DSH_AUTOMATIC_CONTINUATION_LIMIT
    ? 'wait_user'
    : 'deliver'
  database.prepare(`
    UPDATE dsh_boundary_jobs
       SET progress_digest = ?, progress_count = ?, progress_claim_attempt = ?,
           progress_waiting = ?, updated_at = ?
     WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?
  `).run(
    progressDigest,
    decision === 'deliver' ? ordinal : DSH_AUTOMATIC_CONTINUATION_LIMIT,
    job.attemptCount,
    decision === 'wait_user' ? 1 : 0,
    now,
    job.jobId,
    job.ownerNonce,
  )
  return Object.freeze({ decision, ordinal })
}

export function resetBoundaryEffectGuardInTransaction(
  database: SqliteDatabase,
  job: DshBoundaryJob,
  now = new Date().toISOString(),
): void {
  database.prepare(`
    UPDATE dsh_boundary_jobs
       SET progress_digest = NULL, progress_count = 0,
           progress_claim_attempt = NULL, progress_waiting = 0, updated_at = ?
     WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?
  `).run(now, job.jobId, job.ownerNonce)
}
