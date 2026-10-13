import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { KiokukoError } from '../../errors.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { CodingIdentity, CodingWorkflow } from './contracts.js'
import type { RequestIntentDecision } from '../decisions/request-intent.js'

export const CODING_ADMISSION_CONTRACT_VERSION = 'lisp-choice-admission-v1'

export interface CodingAdmission {
  readonly runId: string
  readonly requestId: string | null
  readonly requestDigest: string | null
  readonly admissionVersion: string
  readonly intentPolicyVersion: string
  readonly changeScope: 'implementation' | 'document' | 'unknown'
  readonly confirmationRequired: boolean
  readonly legacy: boolean
}

/** Persist the exact interpretation and whether this run must ask about Lisp. */
export function recordCodingAdmissionInTransaction(db: SqliteDatabase, input: {
  runId: string; requestId: string; task: string; intent?: RequestIntentDecision; now?: string
}): CodingAdmission {
  const requestDigest = canonicalContentHash(input.task)
  if (input.intent && input.intent.evidence.requestDigest !== requestDigest)
    throw new KiokukoError('CONFLICT', 'Coding admission does not match the current request')
  const changeScope = input.intent?.action === 'change' ? input.intent.changeScope : 'unknown'
  const confirmationRequired = input.intent?.action === 'change' && changeScope === 'implementation'
  const value: CodingAdmission = { runId: input.runId, requestId: input.requestId,
    requestDigest, admissionVersion: CODING_ADMISSION_CONTRACT_VERSION,
    intentPolicyVersion: input.intent?.policyVersion ?? 'unknown', changeScope, confirmationRequired, legacy: false }
  const existing = readCodingAdmission(db, input.runId)
  if (existing) {
    if (existing.legacy || existing.requestId !== value.requestId || existing.requestDigest !== value.requestDigest
      || existing.admissionVersion !== value.admissionVersion || existing.intentPolicyVersion !== value.intentPolicyVersion
      || existing.changeScope !== value.changeScope || existing.confirmationRequired !== value.confirmationRequired) {
      throw new KiokukoError('CONFLICT', 'Coding admission identity or interpretation changed')
    }
    return existing
  }
  db.prepare(`INSERT INTO dsh_coding_admissions
    (run_id,request_id,request_digest,admission_version,intent_policy_version,change_scope,confirmation_required,legacy,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(input.runId, input.requestId, value.requestDigest, value.admissionVersion,
      value.intentPolicyVersion, value.changeScope, confirmationRequired ? 1 : 0, 0, input.now ?? new Date().toISOString())
  return value
}

/** An absent or malformed row is unknown, never implicitly treated as legacy. */
export function readCodingAdmission(db: SqliteDatabase, runId: string): CodingAdmission | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_coding_admissions'").get()) return undefined
  const row = db.prepare(`SELECT run_id,request_id,request_digest,admission_version,intent_policy_version,change_scope,
    confirmation_required,legacy FROM dsh_coding_admissions WHERE run_id=?`).get<Record<string, unknown>>(runId)
  if (!row) return undefined
  if (typeof row.run_id !== 'string' || typeof row.admission_version !== 'string'
    || typeof row.intent_policy_version !== 'string'
    || !['implementation', 'document', 'unknown'].includes(String(row.change_scope))
    || (row.confirmation_required !== 0 && row.confirmation_required !== 1)
    || (row.legacy !== 0 && row.legacy !== 1)
    || row.request_id !== null && typeof row.request_id !== 'string'
    || row.request_digest !== null && (typeof row.request_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.request_digest))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Invalid durable coding admission state')
  }
  const legacy = row.legacy === 1
  if (legacy && (row.admission_version !== 'legacy' || row.confirmation_required !== 0)
    || !legacy && (!row.request_id || !row.request_digest || row.admission_version !== CODING_ADMISSION_CONTRACT_VERSION)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Inconsistent durable coding admission state')
  }
  return { runId: row.run_id, requestId: row.request_id as string | null, requestDigest: row.request_digest as string | null,
    admissionVersion: row.admission_version, intentPolicyVersion: row.intent_policy_version,
    changeScope: row.change_scope as CodingAdmission['changeScope'], confirmationRequired: row.confirmation_required === 1, legacy }
}

export function readCodingWorkflow(db: SqliteDatabase, runId: string): CodingWorkflow | undefined {
  // Legacy consumers may use a pre-workflow schema. Do not manufacture a
  // choice or catch database failures as though they were a legacy task.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_coding_workflows'").get()) return undefined
  const row = db.prepare('SELECT snapshot_json FROM dsh_coding_workflows WHERE run_id=?').get<{ snapshot_json: string }>(runId)
  if (!row) return undefined
  const value = JSON.parse(row.snapshot_json) as CodingWorkflow
  if (value.pendingScopeChange !== undefined && (!value.pendingScopeChange
    || !/^[a-f0-9]{64}$/u.test(value.pendingScopeChange.requestDigest)
    || !Array.isArray(value.pendingScopeChange.evidenceRefs) || value.pendingScopeChange.evidenceRefs.length > 32
    || value.pendingScopeChange.evidenceRefs.some(ref => typeof ref !== 'string' || !ref || ref.length > 256 || /[\p{Cc}\p{Cf}]/u.test(ref)))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Invalid pending coding scope-change evidence')
  }
  return value
}
export function sessionCodingWorkflow(db: SqliteDatabase, sessionId: string): CodingWorkflow | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_coding_workflows'").get()) return undefined
  const row = db.prepare(`SELECT w.snapshot_json FROM dsh_coding_workflows w JOIN dsh_execution_owners o ON o.run_id=w.run_id
    WHERE o.dsh_session_id=? AND w.session_id=?`).get<{ snapshot_json: string }>(sessionId, sessionId)
  return row ? JSON.parse(row.snapshot_json) as CodingWorkflow : undefined
}
export function assertCodingIdentity(workflow: CodingWorkflow, identity: CodingIdentity): void {
  if (workflow.runId !== identity.runId || workflow.sessionId !== identity.sessionId || workflow.repositoryRoot !== identity.repositoryRoot)
    throw new KiokukoError('CONFLICT', 'Coding workflow owner or repository changed')
}
export function initializeCodingWorkflow(db: SqliteDatabase, input: CodingIdentity & { requestId: string; task: string }): CodingWorkflow {
  return withImmediateTransaction(db, () => initializeCodingWorkflowInTransaction(db, input))
}
/** Run admission already owns the transaction that creates its ledger identity. */
export function initializeCodingWorkflowInTransaction(db: SqliteDatabase, input: CodingIdentity & { requestId: string; task: string }): CodingWorkflow {
  const previous = readCodingWorkflow(db, input.runId)
  if (previous) {
    assertCodingIdentity(previous, input)
    if (previous.requestId !== input.requestId || previous.requestDigest !== canonicalContentHash(input.task))
      throw new KiokukoError('CONFLICT', 'Coding request identity was reused with different input')
    return previous
  }
  const workflowId = randomUUID()
  const value: CodingWorkflow = { runId: input.runId, sessionId: input.sessionId, repositoryRoot: input.repositoryRoot,
    requestId: input.requestId, request: input.task, requestDigest: canonicalContentHash(input.task),
    workflowId, revision: 1, scopeVersion: 1, state: 'preparing', retiredIds: [], attempts: {},
    choice: { state: 'pending', scopeVersion: 1, questionId: `coding-lisp-${workflowId}-1`, revision: 1 } }
  db.prepare('INSERT INTO dsh_coding_workflows VALUES(?,?,?,?,?,?,?,?)')
    .run(workflowId, input.runId, input.sessionId, input.repositoryRoot, input.requestId, 1, JSON.stringify(value), new Date().toISOString())
  db.prepare('INSERT OR IGNORE INTO dsh_completion_runs(run_id,mode,created_at) VALUES(?,?,?)')
    .run(input.runId, 'enforce', new Date().toISOString())
  db.prepare("UPDATE dsh_completion_runs SET mode='enforce' WHERE run_id=?").run(input.runId)
  return value
}
/** Revision, effect and replay receipt commit together. Callers never retain mutable stored state. */
export function mutateCodingWorkflow(db: SqliteDatabase, identity: CodingIdentity, callId: string, expectedRevision: number,
  payload: unknown, change: (value: CodingWorkflow) => void, implicitRevision = false): CodingWorkflow {
  return withImmediateTransaction(db, () => {
    const current = readCodingWorkflow(db, identity.runId)
    if (!current) throw new KiokukoError('NOT_FOUND', 'No coding workflow for this task')
    assertCodingIdentity(current, identity)
    const digest = canonicalContentHash({ identity: { runId: identity.runId, sessionId: identity.sessionId, repositoryRoot: identity.repositoryRoot },
      ...(implicitRevision ? {} : { expectedRevision }), payload })
    const previous = db.prepare('SELECT request_digest,response_json FROM dsh_coding_operations WHERE workflow_id=? AND call_id=?')
      .get<{ request_digest: string; response_json: string }>(current.workflowId, callId)
    if (previous) {
      if (previous.request_digest !== digest) throw new KiokukoError('CONFLICT', 'Coding call ID reused with changed input')
      return JSON.parse(previous.response_json)
    }
    if (current.revision !== expectedRevision) throw new KiokukoError('CONFLICT', 'Stale coding workflow revision')
    change(current)
    current.revision++
    const json = JSON.stringify(current)
    db.prepare('UPDATE dsh_coding_workflows SET revision=?,snapshot_json=?,updated_at=? WHERE workflow_id=? AND revision=?')
      .run(current.revision, json, new Date().toISOString(), current.workflowId, expectedRevision)
    if (readCodingWorkflow(db, identity.runId)?.revision !== current.revision) throw new KiokukoError('CONFLICT', 'Coding CAS failed')
    db.prepare('INSERT INTO dsh_coding_operations VALUES(?,?,?,?)').run(current.workflowId, callId, digest, json)
    return current
  })
}
