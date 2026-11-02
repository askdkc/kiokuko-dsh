import { canonicalContentHash, canonicalJson } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'

export const DSH_TURN_HANDOFF_MAX_BYTES = 32 * 1024
export const DSH_BOUNDARY_JOB_MAX_ATTEMPTS = 3
const RETRYABLE_BOUNDARY_ERRORS = new Set(['NATIVE_FLUSH_FAILED', 'NATIVE_FLUSH_TIMEOUT', 'DATABASE_ERROR',
  'BACKPRESSURE', 'SERVICE_UNAVAILABLE', 'SQLITE_BUSY', 'CRASH_CUT', 'BOUNDARY_BINDING_UNAVAILABLE'])
export function retryableBoundaryErrorCode(code: string): boolean { return RETRYABLE_BOUNDARY_ERRORS.has(code) }

export interface DshContinuationOutboxItem {
  readonly continuationId: string
  readonly receiptId: string
  readonly runId: string
  readonly dshSessionId: string
  readonly causalRevision: number
  readonly message: unknown
  readonly messageForm: 'continuation' | 'loop-recovery'
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

interface OutboxRow extends Record<string, unknown> {
  continuationId: string
  receiptId: string
  runId: string
  dshSessionId: string
  causalRevision: number
  messageJson: string
  messageForm: DshContinuationOutboxItem['messageForm']
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

function boundedJson(value: unknown, maximumBytes: number, label: string): string {
  const serialized = canonicalJson(value)
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} exceeds ${maximumBytes} UTF-8 bytes`)
  }
  return serialized
}

export function readPendingOutbox(database: SqliteDatabase, sessionId: string): readonly DshContinuationOutboxItem[] {
  const rows = database.prepare(`
    SELECT continuation_id AS continuationId, receipt_id AS receiptId,
           run_id AS runId, dsh_session_id AS dshSessionId,
           causal_revision AS causalRevision, message_json AS messageJson,
           message_form AS messageForm, status
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
    messageForm: row.messageForm,
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

/** Reconstruct timers from durable state, including a crashed owner's lease. */
export function nextBoundaryWakeAt(database: SqliteDatabase, sessionId: string): string | undefined {
  return database.prepare(`SELECT MIN(CASE WHEN job.status = 'processing'
      THEN MAX(job.available_at, job.lease_expires_at) ELSE job.available_at END) AS wakeAt
    FROM dsh_boundary_jobs AS job JOIN dsh_turn_receipts AS receipt ON receipt.receipt_id = job.receipt_id
    WHERE receipt.dsh_session_id = ? AND job.status IN ('pending', 'processing', 'failed_retryable')`)
    .get<{ wakeAt: string | null }>(sessionId)?.wakeAt ?? undefined
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
  if (!retryableBoundaryErrorCode(code) || job.attemptCount >= DSH_BOUNDARY_JOB_MAX_ATTEMPTS) {
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
  messageForm: DshContinuationOutboxItem['messageForm'],
  now = new Date().toISOString(),
): void {
  const messageJson = boundedJson(message, DSH_TURN_HANDOFF_MAX_BYTES, 'continuation message')
  database.prepare(`
    UPDATE dsh_continuation_outbox SET message_json = ?, message_form = ?, updated_at = ?
     WHERE receipt_id = ? AND status = 'pending'
  `).run(messageJson, messageForm, now, digest(receiptIdValue, 'receiptId'))
}
