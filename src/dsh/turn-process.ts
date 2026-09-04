import { canonicalContentHash, canonicalJson } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError, type ErrorCode } from '../errors.js'
import type { AkinatorQuestion } from '../akinator/types.js'

export const DSH_TURN_HANDOFF_MAX_BYTES = 32 * 1024
export const DSH_TURN_FAILURE_MAX_BYTES = 8 * 1024
export const DSH_BOUNDARY_JOB_MAX_ATTEMPTS = 3

export type DshTurnPhase =
  | 'intake'
  | 'ideal'
  | 'planning'
  | 'confirmation'
  | 'work_unit'
  | 'final_verification'
  | 'final_review'
  | 'meditation'
  | 'complete'

export type DshEnnoReceiptOperation =
  | 'ideal_submit'
  | 'advice_submit'
  | 'plan_submit'
  | 'answer'
  | 'work_report'
  | 'finish'
  | 'meditation_submit'
  | 'verify_prepare'

export interface FailureFact {
  readonly code: string
  readonly message: string
  readonly digest: string
  readonly count: number
}

export interface TurnHandoff {
  readonly schemaVersion: 1
  readonly runId: string
  readonly phase: DshTurnPhase
  readonly revision: number
  readonly nextAction: string
  readonly evidenceRange?: { readonly startSeq: number; readonly endSeq: number }
  readonly failureDigest?: string
}

export type TurnOutcome<T> =
  | { readonly kind: 'applied'; readonly value: T; readonly handoff: TurnHandoff }
  | { readonly kind: 'retry'; readonly reason: FailureFact; readonly handoff: TurnHandoff }
  | { readonly kind: 'clarify'; readonly question: AkinatorQuestion; readonly handoff: TurnHandoff }
  | { readonly kind: 'waiting_user'; readonly questionId: string }
  | { readonly kind: 'infrastructure_error'; readonly retryAfterMs: number }

export function appliedTurnOutcome<T>(value: T, handoff: TurnHandoff): TurnOutcome<T> {
  boundedJson(handoff, DSH_TURN_HANDOFF_MAX_BYTES, 'turn handoff')
  return Object.freeze({ kind: 'applied', value, handoff })
}

export interface PrepareTurnIntentInput {
  readonly runId: string
  readonly dshSessionId: string
  readonly nativeTurn: number
  readonly phase: DshTurnPhase
  readonly contractRevision: number
  readonly workUnitId?: string
  readonly inputDigest: string
  readonly operation: DshEnnoReceiptOperation
  readonly idempotencyKey: string
  readonly now?: string
}

export interface PreparedTurnIntent extends PrepareTurnIntentInput {
  readonly receiptId: string
  readonly continuationId: string
  readonly boundaryJobId: string
}

export interface DshTurnSeal {
  readonly receiptId: string
  readonly runId: string
  readonly dshSessionId: string
  readonly nativeTurn: number
  readonly phase: DshTurnPhase
  readonly contractRevision: number
  readonly outcomeKind: TurnOutcome<unknown>['kind']
  readonly nextAction: string | null
}

export interface DshContinuationOutboxItem {
  readonly continuationId: string
  readonly receiptId: string
  readonly runId: string
  readonly dshSessionId: string
  readonly causalRevision: number
  readonly message: unknown
  readonly status: 'pending' | 'dispatched' | 'observed' | 'superseded'
}

export interface DshBoundaryJob {
  readonly jobId: string
  readonly receiptId: string
  readonly runId: string
  readonly dshSessionId: string
  readonly nativeTurn: number
  readonly kind: string
  readonly attemptCount: number
  readonly ownerNonce: string
}

interface IntentRow extends Record<string, unknown> {
  receiptId: string
  runId: string
  dshSessionId: string
  nativeTurn: number
  phase: DshTurnPhase
  contractRevision: number
  workUnitKey: string
  inputDigest: string
  operation: DshEnnoReceiptOperation
  idempotencyKey: string
  continuationId: string
  boundaryJobId: string
  createdAt: string
}

interface SealRow extends Record<string, unknown> {
  receiptId: string
  runId: string
  dshSessionId: string
  nativeTurn: number
  phase: DshTurnPhase
  contractRevision: number
  outcomeKind: TurnOutcome<unknown>['kind']
  nextAction: string | null
}

interface OutboxRow extends Record<string, unknown> {
  continuationId: string
  receiptId: string
  runId: string
  dshSessionId: string
  causalRevision: number
  messageJson: string
  status: DshContinuationOutboxItem['status']
}

interface BoundaryJobRow extends Record<string, unknown> {
  jobId: string
  receiptId: string
  runId: string
  dshSessionId: string
  nativeTurn: number
  kind: string
  attemptCount: number
}

const PHASES = new Set<DshTurnPhase>([
  'intake', 'ideal', 'planning', 'confirmation', 'work_unit',
  'final_verification', 'final_review', 'meditation', 'complete',
])

const OPERATIONS = new Set<DshEnnoReceiptOperation>([
  'ideal_submit', 'advice_submit', 'plan_submit', 'answer', 'work_report',
  'finish', 'meditation_submit', 'verify_prepare',
])

const EXPECTED_FAILURE_CODES = new Set<ErrorCode>(['VALIDATION_ERROR', 'CONFLICT', 'NOT_FOUND'])

function identity(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} is invalid`)
  }
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a SHA-256 digest`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} must be a positive safe integer`)
  }
  return value
}

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let result = ''
  let used = 0
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8')
    if (used + size > maximumBytes) break
    result += point
    used += size
  }
  return result
}

function boundedJson(value: unknown, maximumBytes: number, label: string): string {
  const serialized = canonicalJson(value)
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} exceeds ${maximumBytes} UTF-8 bytes`)
  }
  return serialized
}

function checkedIntent(input: PrepareTurnIntentInput): PreparedTurnIntent {
  const runId = identity(input.runId, 'runId')
  const dshSessionId = identity(input.dshSessionId, 'dshSessionId')
  const nativeTurn = positiveInteger(input.nativeTurn, 'nativeTurn')
  if (!PHASES.has(input.phase)) throw new KiokukoError('VALIDATION_ERROR', 'turn phase is invalid')
  const contractRevision = positiveInteger(input.contractRevision, 'contractRevision')
  const workUnitId = input.workUnitId === undefined ? undefined : identity(input.workUnitId, 'workUnitId', 4_096)
  const inputDigest = digest(input.inputDigest, 'inputDigest')
  if (!OPERATIONS.has(input.operation)) throw new KiokukoError('VALIDATION_ERROR', 'Enno receipt operation is invalid')
  const idempotencyKey = identity(input.idempotencyKey, 'idempotencyKey')
  const identityDocument = {
    version: 1,
    runId,
    dshSessionId,
    nativeTurn,
    phase: input.phase,
    contractRevision,
    workUnitId: workUnitId ?? null,
    inputDigest,
    operation: input.operation,
    idempotencyKey,
  }
  const receiptId = canonicalContentHash(identityDocument)
  return Object.freeze({
    ...input,
    runId,
    dshSessionId,
    nativeTurn,
    contractRevision,
    ...(workUnitId === undefined ? {} : { workUnitId }),
    inputDigest,
    idempotencyKey,
    receiptId,
    continuationId: canonicalContentHash({ receiptId, kind: 'continuation' }),
    boundaryJobId: canonicalContentHash({ receiptId, kind: 'boundary' }),
  })
}

function sameIntent(row: IntentRow, intent: PreparedTurnIntent): boolean {
  return row.receiptId === intent.receiptId
    && row.runId === intent.runId
    && row.dshSessionId === intent.dshSessionId
    && row.nativeTurn === intent.nativeTurn
    && row.phase === intent.phase
    && row.contractRevision === intent.contractRevision
    && row.workUnitKey === (intent.workUnitId ?? '')
    && row.inputDigest === intent.inputDigest
    && row.operation === intent.operation
    && row.idempotencyKey === intent.idempotencyKey
    && row.continuationId === intent.continuationId
    && row.boundaryJobId === intent.boundaryJobId
}

function intentForTurn(database: SqliteDatabase, sessionId: string, nativeTurn: number): IntentRow | undefined {
  return database.prepare(`
    SELECT receipt_id AS receiptId, run_id AS runId, dsh_session_id AS dshSessionId,
           native_turn AS nativeTurn, phase, contract_revision AS contractRevision,
           work_unit_key AS workUnitKey, input_digest AS inputDigest, operation,
           idempotency_key AS idempotencyKey, continuation_id AS continuationId,
           boundary_job_id AS boundaryJobId, created_at AS createdAt
      FROM dsh_turn_intents
     WHERE dsh_session_id = ? AND native_turn = ?
  `).get<IntentRow>(sessionId, nativeTurn)
}

/** Prepare immutable identity before an Enno operation begins. */
export function prepareTurnIntentInTransaction(database: SqliteDatabase, raw: PrepareTurnIntentInput): PreparedTurnIntent {
  const intent = checkedIntent(raw)
  const existing = intentForTurn(database, intent.dshSessionId, intent.nativeTurn)
  if (existing !== undefined) {
    if (!sameIntent(existing, intent)) throw new KiokukoError('CONFLICT', 'DSH native turn was reused for another phase intent')
    return intent
  }
  const now = raw.now ?? new Date().toISOString()
  database.prepare(`
    INSERT INTO dsh_turn_intents (
      receipt_id, run_id, dsh_session_id, native_turn, phase,
      contract_revision, work_unit_key, input_digest, operation,
      idempotency_key, continuation_id, boundary_job_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    intent.receiptId,
    intent.runId,
    intent.dshSessionId,
    intent.nativeTurn,
    intent.phase,
    intent.contractRevision,
    intent.workUnitId ?? '',
    intent.inputDigest,
    intent.operation,
    intent.idempotencyKey,
    intent.continuationId,
    intent.boundaryJobId,
    now,
  )
  return intent
}

export function prepareTurnIntent(database: SqliteDatabase, input: PrepareTurnIntentInput): PreparedTurnIntent {
  return withImmediateTransaction(database, () => prepareTurnIntentInTransaction(database, input))
}

export function readTurnSeal(database: SqliteDatabase, dshSessionId: string, nativeTurn: number): DshTurnSeal | undefined {
  const row = database.prepare(`
    SELECT receipt_id AS receiptId, run_id AS runId, dsh_session_id AS dshSessionId,
           native_turn AS nativeTurn, phase, contract_revision AS contractRevision,
           outcome_kind AS outcomeKind, next_action AS nextAction
      FROM dsh_turn_receipts
     WHERE dsh_session_id = ? AND native_turn = ?
  `).get<SealRow>(identity(dshSessionId, 'dshSessionId'), positiveInteger(nativeTurn, 'nativeTurn'))
  return row === undefined ? undefined : Object.freeze(row)
}

export function isExpectedTurnFailure(error: unknown): error is KiokukoError {
  return error instanceof KiokukoError && EXPECTED_FAILURE_CODES.has(error.code)
}

function failureFact(error: KiokukoError, count: number): FailureFact {
  const message = boundedText(error.message, DSH_TURN_FAILURE_MAX_BYTES)
  return Object.freeze({
    code: error.code,
    message,
    digest: canonicalContentHash({ code: error.code, message, details: error.details }),
    count,
  })
}

export interface CommitExpectedFailureInput extends PrepareTurnIntentInput {
  readonly error: KiokukoError
}

/**
 * Convert a predictable domain rejection into a durable turn result.  This is
 * a successful transport envelope: DSH can commit it and stop the turn without
 * treating validation feedback as an infrastructure failure.
 */
export function commitExpectedFailureInTransaction(
  database: SqliteDatabase,
  input: CommitExpectedFailureInput,
): TurnOutcome<never> {
  const existing = readTurnSeal(database, input.dshSessionId, input.nativeTurn)
  if (existing !== undefined) {
    const memory = database.prepare(`
      SELECT failure_count AS failureCount, memory_json AS memoryJson
        FROM dsh_temporary_memories
       WHERE run_id = ? AND phase = ? AND contract_revision = ? AND input_digest = ?
       ORDER BY updated_at DESC LIMIT 1
    `).get<{ failureCount: number; memoryJson: string }>(input.runId, input.phase, input.contractRevision, input.inputDigest)
    if (memory === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Stored retry receipt has no temporary memory')
    const stored = JSON.parse(memory.memoryJson) as { reason: FailureFact; handoff: TurnHandoff }
    return existing.outcomeKind === 'clarify'
      ? { kind: 'clarify', question: questionFor(stored.reason), handoff: stored.handoff }
      : { kind: 'retry', reason: stored.reason, handoff: stored.handoff }
  }
  const intent = prepareTurnIntentInTransaction(database, input)
  const base = failureFact(input.error, 1)
  const memoryId = canonicalContentHash({
    runId: intent.runId,
    phase: intent.phase,
    revision: intent.contractRevision,
    inputDigest: intent.inputDigest,
    failureDigest: base.digest,
  })
  const now = input.now ?? new Date().toISOString()
  database.prepare(`
    INSERT INTO dsh_temporary_memories (
      memory_id, run_id, phase, contract_revision, input_digest, failure_digest,
      failure_count, weight, confidence, memory_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1.0, 1.0, '{}', ?, ?)
    ON CONFLICT(run_id, phase, contract_revision, input_digest, failure_digest) DO UPDATE SET
      failure_count = failure_count + 1,
      updated_at = excluded.updated_at
  `).run(memoryId, intent.runId, intent.phase, intent.contractRevision, intent.inputDigest, base.digest, now, now)
  const count = database.prepare(`
    SELECT failure_count AS count FROM dsh_temporary_memories WHERE memory_id = ?
  `).get<{ count: number }>(memoryId)?.count
  if (count === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Temporary failure memory was not persisted')
  const reason = failureFact(input.error, count)
  const clarify = count >= 2
  const nextAction = clarify ? 'ask_akinator' : `retry_${intent.phase}`
  const handoff: TurnHandoff = Object.freeze({
    schemaVersion: 1,
    runId: intent.runId,
    phase: intent.phase,
    revision: intent.contractRevision,
    nextAction,
    failureDigest: reason.digest,
  })
  const memoryJson = boundedJson({ reason, handoff }, 65536, 'temporary turn memory')
  database.prepare('UPDATE dsh_temporary_memories SET memory_json = ? WHERE memory_id = ?').run(memoryJson, memoryId)
  database.prepare(`
    INSERT INTO dsh_turn_receipts (
      receipt_id, run_id, dsh_session_id, native_turn, phase,
      contract_revision, work_unit_key, input_digest, outcome_kind,
      next_action, enno_operation, enno_idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(
    intent.receiptId, intent.runId, intent.dshSessionId, intent.nativeTurn,
    intent.phase, intent.contractRevision, intent.workUnitId ?? '', intent.inputDigest,
    clarify ? 'clarify' : 'retry', nextAction, now,
  )
  database.prepare(`
    INSERT INTO dsh_turn_handoffs (receipt_id, handoff_json, created_at)
    VALUES (?, ?, ?)
  `).run(intent.receiptId, boundedJson(handoff, DSH_TURN_HANDOFF_MAX_BYTES, 'turn handoff'), now)
  database.prepare(`
    INSERT INTO dsh_boundary_jobs (
      job_id, receipt_id, run_id, kind, status, attempt_count,
      available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(intent.boundaryJobId, intent.receiptId, intent.runId, nextAction, now, now, now)
  const message = {
    id: intent.continuationId,
    role: 'user',
    content: [{ type: 'text', text: clarify
      ? `Kiokuko needs clarification after repeated ${intent.phase} validation: ${reason.message}`
      : `Retry Kiokuko ${intent.phase} using the recorded validation fact: ${reason.message}` }],
    source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'continuation', deliveryId: intent.continuationId },
  }
  database.prepare(`
    INSERT INTO dsh_continuation_outbox (
      continuation_id, receipt_id, run_id, dsh_session_id, causal_revision,
      message_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    intent.continuationId, intent.receiptId, intent.runId, intent.dshSessionId,
    intent.contractRevision, boundedJson(message, DSH_TURN_HANDOFF_MAX_BYTES, 'continuation message'), now, now,
  )
  return clarify
    ? { kind: 'clarify', question: questionFor(reason), handoff }
    : { kind: 'retry', reason, handoff }
}

function questionFor(reason: FailureFact): AkinatorQuestion {
  return Object.freeze({
    id: 'expected',
    prompt: `The same processing constraint failed repeatedly: ${reason.message}\nWhat result should be considered correct?`,
    options: null,
    required: true,
  })
}

export function commitExpectedFailure(database: SqliteDatabase, input: CommitExpectedFailureInput): TurnOutcome<never> {
  return withImmediateTransaction(database, () => commitExpectedFailureInTransaction(database, input))
}

export function readPendingOutbox(database: SqliteDatabase, sessionId: string): readonly DshContinuationOutboxItem[] {
  const rows = database.prepare(`
    SELECT continuation_id AS continuationId, receipt_id AS receiptId,
           run_id AS runId, dsh_session_id AS dshSessionId,
           causal_revision AS causalRevision, message_json AS messageJson, status
      FROM dsh_continuation_outbox
     WHERE dsh_session_id = ? AND status IN ('pending', 'dispatched')
     ORDER BY created_at, continuation_id
  `).all<OutboxRow>(identity(sessionId, 'dshSessionId'))
  return Object.freeze(rows.map((row) => Object.freeze({
    continuationId: row.continuationId,
    receiptId: row.receiptId,
    runId: row.runId,
    dshSessionId: row.dshSessionId,
    causalRevision: row.causalRevision,
    message: JSON.parse(row.messageJson) as unknown,
    status: row.status,
  })))
}

export function markOutboxDispatchedInTransaction(database: SqliteDatabase, continuationId: string, now = new Date().toISOString()): void {
  database.prepare(`
    UPDATE dsh_continuation_outbox SET status = 'dispatched', dispatched_at = coalesce(dispatched_at, ?), updated_at = ?
     WHERE continuation_id = ? AND status IN ('pending', 'dispatched')
  `).run(now, now, digest(continuationId, 'continuationId'))
}

export function markOutboxObservedInTransaction(database: SqliteDatabase, continuationId: string, sequence: number, now = new Date().toISOString()): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new KiokukoError('VALIDATION_ERROR', 'observed sequence is invalid')
  database.prepare(`
    UPDATE dsh_continuation_outbox SET status = 'observed', observed_seq = ?, updated_at = ?
     WHERE continuation_id = ? AND status IN ('pending', 'dispatched', 'observed')
  `).run(sequence, now, digest(continuationId, 'continuationId'))
}

export function supersedeOutboxBeforeRevisionInTransaction(
  database: SqliteDatabase,
  sessionId: string,
  revision: number,
  now = new Date().toISOString(),
): void {
  database.prepare(`
    UPDATE dsh_continuation_outbox SET status = 'superseded', updated_at = ?
     WHERE dsh_session_id = ? AND causal_revision < ? AND status IN ('pending', 'dispatched')
  `).run(now, identity(sessionId, 'dshSessionId'), positiveInteger(revision, 'revision'))
}

export function supersedeOutboxAtOrBeforeRevisionInTransaction(
  database: SqliteDatabase,
  sessionId: string,
  revision: number,
  now = new Date().toISOString(),
): void {
  database.prepare(`
    UPDATE dsh_continuation_outbox SET status = 'superseded', updated_at = ?
     WHERE dsh_session_id = ? AND causal_revision <= ? AND status IN ('pending', 'dispatched')
  `).run(now, identity(sessionId, 'dshSessionId'), positiveInteger(revision, 'revision'))
}

export function supersedeBoundaryJobsAtOrBeforeRevisionInTransaction(
  database: SqliteDatabase,
  sessionId: string,
  revision: number,
  now = new Date().toISOString(),
): void {
  database.prepare(`
    UPDATE dsh_boundary_jobs
       SET status = 'superseded', owner_nonce = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE receipt_id IN (
       SELECT receipt_id FROM dsh_turn_receipts
        WHERE dsh_session_id = ? AND contract_revision <= ?
     )
       AND status IN ('pending', 'processing', 'waiting_user', 'failed_retryable')
  `).run(now, identity(sessionId, 'dshSessionId'), positiveInteger(revision, 'revision'))
}

function boundaryJobIdentity(receiptId: string, kind: string): string {
  return canonicalContentHash({ receiptId: digest(receiptId, 'receiptId'), kind: identity(kind, 'boundary job kind') })
}

export function claimBoundaryJobInTransaction(
  database: SqliteDatabase,
  ownerNonceValue: string,
  now = new Date().toISOString(),
  sessionId?: string,
): DshBoundaryJob | undefined {
  const ownerNonce = identity(ownerNonceValue, 'boundary owner nonce')
  const leaseExpiresAt = new Date(Date.parse(now) + 60_000).toISOString()
  const row = database.prepare(`
    SELECT job.job_id AS jobId, job.receipt_id AS receiptId, job.run_id AS runId,
           receipt.dsh_session_id AS dshSessionId, receipt.native_turn AS nativeTurn,
           job.kind, job.attempt_count AS attemptCount
      FROM dsh_boundary_jobs AS job
      JOIN dsh_turn_receipts AS receipt ON receipt.receipt_id = job.receipt_id
     WHERE (job.status IN ('pending', 'failed_retryable')
            OR (job.status = 'processing' AND job.lease_expires_at <= ?))
       AND job.available_at <= ?
       AND (? IS NULL OR receipt.dsh_session_id = ?)
     ORDER BY job.available_at, job.created_at, job.job_id
     LIMIT 1
  `).get<BoundaryJobRow>(now, now, sessionId ?? null, sessionId ?? null)
  if (row === undefined) return undefined
  database.prepare(`
    UPDATE dsh_boundary_jobs
       SET status = 'processing', owner_nonce = ?, lease_expires_at = ?,
           attempt_count = attempt_count + 1, updated_at = ?
     WHERE job_id = ?
  `).run(ownerNonce, leaseExpiresAt, now, row.jobId)
  return Object.freeze({ ...row, attemptCount: row.attemptCount + 1, ownerNonce })
}

export type DshBoundaryCompletion =
  | { readonly kind: 'completed'; readonly nextKind?: string }
  | { readonly kind: 'waiting_user' }
  | { readonly kind: 'superseded' }

export function completeBoundaryJobInTransaction(
  database: SqliteDatabase,
  job: DshBoundaryJob,
  completion: DshBoundaryCompletion,
  now = new Date().toISOString(),
): void {
  const status = completion.kind === 'completed' ? 'completed' : completion.kind
  const changed = database.prepare(`
    UPDATE dsh_boundary_jobs
       SET status = ?, owner_nonce = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = ?
     WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?
    RETURNING job_id AS jobId
  `).get<{ jobId: string }>(status, now, job.jobId, job.ownerNonce)
  if (changed === undefined) throw new KiokukoError('CONFLICT', 'Boundary job lease changed before completion')
  if (completion.kind !== 'completed' || completion.nextKind === undefined) return
  const nextKind = identity(completion.nextKind, 'next boundary job kind')
  database.prepare(`
    INSERT INTO dsh_boundary_jobs (
      job_id, receipt_id, run_id, kind, status, attempt_count,
      available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(receipt_id, kind) DO UPDATE SET
      status = 'pending', available_at = excluded.available_at,
      owner_nonce = NULL, lease_expires_at = NULL, updated_at = excluded.updated_at
    WHERE dsh_boundary_jobs.status IN ('completed', 'failed_retryable')
  `).run(boundaryJobIdentity(job.receiptId, nextKind), job.receiptId, job.runId, nextKind, now, now, now)
}

export function failBoundaryJobInTransaction(
  database: SqliteDatabase,
  job: DshBoundaryJob,
  error: unknown,
  now = new Date().toISOString(),
): { readonly kind: 'retry'; readonly retryAt: string } | { readonly kind: 'waiting_user' } {
  const item = typeof error === 'object' && error !== null ? error as { code?: unknown } : undefined
  const code = typeof item?.code === 'string' ? item.code.slice(0, 128) : 'BOUNDARY_JOB_FAILED'
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  if (job.attemptCount >= DSH_BOUNDARY_JOB_MAX_ATTEMPTS) {
    database.prepare(`
      UPDATE dsh_boundary_jobs
         SET status = 'waiting_user', owner_nonce = NULL, lease_expires_at = NULL,
             last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?
    `).run(code, message, now, job.jobId, job.ownerNonce)
    return Object.freeze({ kind: 'waiting_user' })
  }
  const retryAt = new Date(Date.parse(now) + Math.min(60_000, 250 * 2 ** Math.min(job.attemptCount, 8))).toISOString()
  database.prepare(`
    UPDATE dsh_boundary_jobs
       SET status = 'failed_retryable', available_at = ?, owner_nonce = NULL,
           lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = ?
     WHERE job_id = ? AND status = 'processing' AND owner_nonce = ?
  `).run(retryAt, code, message, now, job.jobId, job.ownerNonce)
  return Object.freeze({ kind: 'retry', retryAt })
}

export function replacePendingOutboxMessageInTransaction(
  database: SqliteDatabase,
  receiptIdValue: string,
  message: unknown,
  now = new Date().toISOString(),
): void {
  const messageJson = boundedJson(message, DSH_TURN_HANDOFF_MAX_BYTES, 'continuation message')
  database.prepare(`
    UPDATE dsh_continuation_outbox SET message_json = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'pending'
  `).run(messageJson, now, digest(receiptIdValue, 'receiptId'))
}

export function phaseForOperation(operation: string): DshTurnPhase | undefined {
  if (operation === 'enno_ideal_submit') return 'ideal'
  if (operation === 'enno_plan_submit') return 'planning'
  if (operation === 'enno_work_report') return 'work_unit'
  if (operation === 'enno_finish') return 'final_review'
  if (operation === 'enno_meditation_submit') return 'meditation'
  return undefined
}

export function ennoReceiptOperation(operation: string): DshEnnoReceiptOperation | undefined {
  if (operation === 'enno_ideal_submit') return 'ideal_submit'
  if (operation === 'enno_plan_submit') return 'plan_submit'
  if (operation === 'enno_work_report') return 'work_report'
  if (operation === 'enno_finish') return 'finish'
  if (operation === 'enno_meditation_submit') return 'meditation_submit'
  return undefined
}
