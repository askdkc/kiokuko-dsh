import { createHash, randomBytes } from 'node:crypto'
import * as z from 'zod/v4'
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { detectRepositoryRoot } from '../repository/detect-root.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { directiveForRun } from '../enno-oduno/directives.js'
import { PLAN_START_RECOVERY_BLOCKER_PREFIX } from '../enno-oduno/plan-recovery.js'
import {
  appendEnnoEventInTransaction,
  claimExecutionLeaseInTransaction,
  readEnnoSnapshot,
} from '../enno-oduno/store.js'
import type {
  EnnoExecutionLease,
  EnnoOdunoState,
  RoleDirective,
} from '../enno-oduno/types.js'

export interface DshExactResumeExpectation {
  readonly runId: string
  readonly workspace: string
  readonly dshSessionId: string
  readonly routeEpoch: number
  readonly resumeToken: string
  readonly requireExistingBinding: true
}

export interface DshResumeDecision {
  readonly continue: boolean
  readonly runId: string | null
  readonly status: EnnoOdunoState['status'] | null
  readonly directive: RoleDirective | null
  readonly reason: string | null
  readonly warning: string | null
  readonly resumeToken: string | null
  readonly routeEpoch: number | null
  readonly executionLease: EnnoExecutionLease | null
}

const inputSchema = z.object({
  dshSessionId: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4_096),
}).strict()

interface CandidateRow extends SqliteRow {
  runId: string
  workspace: string
  orchestrationId: string
  dshSessionId: string | null
  repositoryRoot: string
  status: EnnoOdunoState['status']
  routeEpoch: number
}

type CandidateResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'resolved'; readonly candidate: CandidateRow }

function candidates(
  database: SqliteDatabase,
  repositoryRoot: string,
  dshSessionId: string | undefined,
  expectedRunId: string | undefined,
): CandidateRow[] {
  return database.prepare(`
    SELECT ec.run_id AS runId, ec.workspace, ec.orchestration_session_id AS orchestrationId,
           ec.dsh_session_id AS dshSessionId, ec.repository_root AS repositoryRoot,
           ec.status, ec.route_epoch AS routeEpoch
    FROM enno_contracts AS ec
    WHERE ec.repository_root = ?
      AND (? IS NULL OR ec.dsh_session_id = ?)
      AND (? IS NULL OR ec.run_id = ?)
      AND (ec.blocker IS NULL OR ec.blocker NOT LIKE ?)
      AND ec.status IN ('zenki_planning', 'goki_executing', 'enno_verifying')
    ORDER BY ec.created_at, ec.run_id
    LIMIT 2
  `).all<CandidateRow>(
    repositoryRoot,
    dshSessionId ?? null,
    dshSessionId ?? null,
    expectedRunId ?? null,
    expectedRunId ?? null,
    `${PLAN_START_RECOVERY_BLOCKER_PREFIX}%`,
  )
}

function bindCandidate(
  database: SqliteDatabase,
  candidate: CandidateRow,
  dshSessionId: string,
): CandidateRow {
  if (candidate.dshSessionId === dshSessionId) return candidate
  const activeLease = database.prepare(`
    SELECT dsh_session_id AS dshSessionId, lease_expires_at AS expiresAt
    FROM enno_execution_leases WHERE run_id = ?
  `).get<{ dshSessionId: string; expiresAt: string }>(candidate.runId)
  if (activeLease !== undefined && activeLease.expiresAt > new Date().toISOString()
    && activeLease.dshSessionId !== dshSessionId) {
    throw new KiokukoError('CONFLICT', 'An active Enno WorkUnit lease prevents DSH session rebinding')
  }
  const updated = database.prepare(`
    UPDATE enno_contracts
       SET dsh_session_id = ?, route_epoch = route_epoch + 1, updated_at = ?
     WHERE run_id = ? AND orchestration_session_id = ? AND dsh_session_id IS ?
    RETURNING route_epoch AS routeEpoch
  `).get<{ routeEpoch: number }>(
    dshSessionId,
    new Date().toISOString(),
    candidate.runId,
    candidate.orchestrationId,
    candidate.dshSessionId,
  )
  if (updated === undefined) throw new KiokukoError('CONFLICT', 'Enno DSH session route changed concurrently')
  appendEnnoEventInTransaction(
    database,
    candidate.runId,
    candidate.dshSessionId === null ? 'enno.dsh_session_bound' : 'enno.dsh_session_rebound',
    'enno-oduno',
    candidate.dshSessionId === null ? 'bound' : 'rebound',
    { fromDshSessionId: candidate.dshSessionId, toDshSessionId: dshSessionId },
  )
  return { ...candidate, dshSessionId, routeEpoch: updated.routeEpoch }
}

function resolveCandidate(
  database: SqliteDatabase,
  repositoryRoot: string,
  dshSessionId: string,
  expectedRunId: string | undefined,
): CandidateResolution {
  const exact = candidates(database, repositoryRoot, dshSessionId, expectedRunId)
  if (exact.length > 1) return { kind: 'ambiguous' }
  if (exact[0] !== undefined) return { kind: 'resolved', candidate: exact[0] }
  const repository = candidates(database, repositoryRoot, undefined, expectedRunId)
  if (repository.length === 0) return { kind: 'none' }
  if (repository.length > 1) return { kind: 'ambiguous' }
  return { kind: 'resolved', candidate: bindCandidate(database, repository[0]!, dshSessionId) }
}

function exactResumeCandidate(
  database: SqliteDatabase,
  expectation: DshExactResumeExpectation,
  repositoryRoot: string,
): CandidateRow {
  const rows = candidates(database, repositoryRoot, undefined, expectation.runId)
  const candidate = rows[0]
  if (candidate === undefined) throw new KiokukoError('CONFLICT', 'The exact DSH resume run is not registered for this repository')
  if (candidate.routeEpoch !== expectation.routeEpoch) throw new KiokukoError('CONFLICT', 'resumeToken route epoch is stale')
  if (candidate.workspace !== expectation.workspace || candidate.dshSessionId !== expectation.dshSessionId) {
    throw new KiokukoError('CONFLICT', 'The exact DSH resume route is stale')
  }
  const tokenHash = createHash('sha256').update(expectation.resumeToken, 'utf8').digest('hex')
  const token = database.prepare(`
    SELECT run_id AS runId, repository_root AS repositoryRoot, route_epoch AS routeEpoch,
           dsh_session_id AS dshSessionId, expires_at AS expiresAt
      FROM enno_resume_tokens WHERE token_hash = ?
  `).get<{
    runId: string
    repositoryRoot: string
    routeEpoch: number
    dshSessionId: string
    expiresAt: string
  }>(tokenHash)
  if (token !== undefined && token.routeEpoch !== expectation.routeEpoch) {
    throw new KiokukoError('CONFLICT', 'resumeToken route epoch is stale')
  }
  if (token === undefined
    || token.runId !== expectation.runId
    || token.repositoryRoot !== repositoryRoot
    || token.routeEpoch !== expectation.routeEpoch
    || token.dshSessionId !== expectation.dshSessionId
    || !Number.isFinite(Date.parse(token.expiresAt))
    || Date.parse(token.expiresAt) <= Date.now()) {
    throw new KiokukoError('CONFLICT', 'The exact DSH resume credential is stale')
  }
  return candidate
}

function issueResumeToken(database: SqliteDatabase, snapshot: ReturnType<typeof readEnnoSnapshot>): string {
  if (snapshot.dshSessionId === null) throw new KiokukoError('INTEGRITY_ERROR', 'Enno resume token requires a bound DSH session')
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString()
  database.prepare('DELETE FROM enno_resume_tokens WHERE expires_at <= ?').run(now.toISOString())
  database.prepare(`
    INSERT INTO enno_resume_tokens (
      token_hash, run_id, repository_root, route_epoch, dsh_session_id, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    createHash('sha256').update(token, 'utf8').digest('hex'),
    snapshot.runId,
    snapshot.repositoryRoot,
    snapshot.routeEpoch ?? 0,
    snapshot.dshSessionId,
    expiresAt,
    now.toISOString(),
  )
  return token
}

function claimContinuation(
  database: SqliteDatabase,
  snapshot: ReturnType<typeof readEnnoSnapshot>,
  directiveDigest: string,
): boolean {
  if (snapshot.dshSessionId === null) throw new KiokukoError('INTEGRITY_ERROR', 'Enno continuation requires the current DSH session')
  const existing = database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
           attempts, directive_digest AS directiveDigest, continuation_count AS continuationCount,
           total_count AS totalCount
      FROM enno_dsh_continuations WHERE run_id = ? AND dsh_session_id = ?
  `).get<{
    contractRevision: number
    mutationRevision: number
    attempts: number
    directiveDigest: string
    continuationCount: number
    totalCount: number
  }>(snapshot.runId, snapshot.dshSessionId)
  const unchanged = existing?.contractRevision === snapshot.revision
    && existing.mutationRevision === snapshot.mutationRevision
    && existing.attempts === snapshot.attempts
    && existing.directiveDigest === directiveDigest
  const count = unchanged ? existing.continuationCount : 0
  const remaining = Math.max(0, snapshot.contract.maxAttempts - snapshot.attempts)
  if (count >= remaining || (existing?.totalCount ?? 0) >= snapshot.contract.maxAttempts) return false
  database.prepare(`
    INSERT INTO enno_dsh_continuations (
      run_id, dsh_session_id, contract_revision, mutation_revision, attempts,
      directive_digest, continuation_count, total_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
    ON CONFLICT(run_id, dsh_session_id) DO UPDATE SET
      contract_revision = excluded.contract_revision,
      mutation_revision = excluded.mutation_revision,
      attempts = excluded.attempts,
      directive_digest = excluded.directive_digest,
      continuation_count = CASE
        WHEN enno_dsh_continuations.contract_revision = excluded.contract_revision
         AND enno_dsh_continuations.mutation_revision = excluded.mutation_revision
         AND enno_dsh_continuations.attempts = excluded.attempts
         AND enno_dsh_continuations.directive_digest = excluded.directive_digest
        THEN enno_dsh_continuations.continuation_count + 1 ELSE 1 END,
      total_count = enno_dsh_continuations.total_count + 1,
      updated_at = excluded.updated_at
  `).run(
    snapshot.runId,
    snapshot.dshSessionId,
    snapshot.revision,
    snapshot.mutationRevision,
    snapshot.attempts,
    directiveDigest,
    new Date().toISOString(),
  )
  return true
}

function continuationPrompt(
  directive: RoleDirective,
): string {
  return `Enno-Oduno requires continuation in this DSH session. Follow this run-bound directive; DSH binds route credentials and execution leases outside model arguments:\n${JSON.stringify({ directive })}`
}

export function decideDshContinuation(
  database: SqliteDatabase,
  rawInput: unknown,
  expectedRun?: string | DshExactResumeExpectation,
): DshResumeDecision {
  const parsed = inputSchema.safeParse(rawInput)
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'DSH continuation input is invalid')
  const repositoryRoot = detectRepositoryRoot({ cwd: parsed.data.cwd, allowDirectory: true }).root
  const continuation = withImmediateTransaction(database, () => {
    const resolution = typeof expectedRun === 'object'
      ? { kind: 'resolved' as const, candidate: exactResumeCandidate(database, expectedRun, repositoryRoot) }
      : resolveCandidate(database, repositoryRoot, parsed.data.dshSessionId, expectedRun)
    if (resolution.kind !== 'resolved') return resolution
    const candidate = resolution.candidate
    const snapshot = readEnnoSnapshot(database, {
      runId: candidate.runId,
      workspace: candidate.workspace,
      orchestrationId: candidate.orchestrationId,
    })
    if (snapshot.dshSessionId !== parsed.data.dshSessionId) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Enno DSH session routing is inconsistent')
    }
    const directive = directiveForRun(snapshot)
    if (directive === null) throw new KiokukoError('INTEGRITY_ERROR', 'Enno active run has no role directive')
    const claimed = claimContinuation(database, snapshot, canonicalContentHash(directive))
    const resumeToken = claimed ? issueResumeToken(database, snapshot) : null
    const executionLease = claimed && directive.role === 'goki' && directive.workUnit !== null
      ? claimExecutionLeaseInTransaction(database, snapshot, directive.workUnit.id, { dshSessionId: parsed.data.dshSessionId })
      : null
    return { kind: 'continuation' as const, snapshot, directive, claimed, resumeToken, executionLease }
  })
  if (continuation.kind === 'none') {
    return { continue: false, runId: null, status: null, directive: null, reason: null, warning: null, resumeToken: null, routeEpoch: null, executionLease: null }
  }
  if (continuation.kind === 'ambiguous') {
    return { continue: false, runId: null, status: null, directive: null, reason: null, warning: 'Multiple Enno-Oduno runs match this DSH repository; refusing to guess.', resumeToken: null, routeEpoch: null, executionLease: null }
  }
  const { snapshot } = continuation
  if (!continuation.claimed) {
    return { continue: false, runId: snapshot.runId, status: snapshot.status, directive: null, reason: null, warning: 'Enno-Oduno continuation limit reached for this DSH session.', resumeToken: null, routeEpoch: snapshot.routeEpoch ?? 0, executionLease: null }
  }
  return {
    continue: true,
    runId: snapshot.runId,
    status: snapshot.status,
    directive: continuation.directive,
    reason: continuationPrompt(continuation.directive),
    warning: null,
    resumeToken: continuation.resumeToken,
    routeEpoch: snapshot.routeEpoch ?? 0,
    executionLease: continuation.executionLease,
  }
}
