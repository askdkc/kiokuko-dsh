import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { KiokukoError } from '../../errors.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { CodingIdentity, CodingWorkflow } from './contracts.js'

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
