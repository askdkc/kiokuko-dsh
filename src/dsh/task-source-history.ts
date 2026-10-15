import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'

/** Caller owns the explicit resume/handoff transaction. Preserve raw provenance
 * without consulting or scheduling optional memory jobs. */
export function rotateTaskSourceInTransaction(database: SqliteDatabase, input: {
  runId: string; sessionId: string; nextSessionId: string; expectedRevision: number; expectedGeneration: number;
  operationId: string; reason: string; sourceEndSeq?: number
}, now: string): void {
  const run = database.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get<Record<string, unknown>>(input.runId)
  if (!run || (run.task_owner_session_id ?? run.dsh_session_id) !== input.sessionId
    || run.task_revision !== input.expectedRevision || run.task_generation !== input.expectedGeneration)
    throw new KiokukoError('CONFLICT', 'Task source rotation requires the current owner and generation')
  const boundary = database.prepare('SELECT * FROM dsh_run_log_boundaries WHERE run_id=?').get<Record<string, unknown>>(input.runId)
  const currentBoundary = boundary && boundary.workspace === run.workspace && boundary.dsh_session_id === input.sessionId ? boundary : undefined
  const end = currentBoundary && Number.isSafeInteger(input.sourceEndSeq)
    && input.sourceEndSeq! >= Number(currentBoundary.source_start_seq) ? input.sourceEndSeq! : undefined
  const provenance = currentBoundary ? { ...currentBoundary, source_end_seq: end ?? null,
    source_end_status: end === undefined ? 'unavailable' : 'host_observed' } : null
  const epoch = database.prepare('SELECT COALESCE(MAX(source_epoch),0)+1 AS epoch FROM dsh_task_source_history WHERE run_id=?').get<{epoch:number}>(input.runId)!.epoch
  database.prepare(`INSERT INTO dsh_task_source_history(run_id,source_epoch,source_session_id,original_session_id,task_generation,
    next_owner_session_id,operation_id,reason,boundary_json,finalization_json,review_state_json,archived_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?)`)
    .run(input.runId,epoch,input.sessionId,String(run.dsh_session_id),input.expectedGeneration,input.nextSessionId,
      input.operationId,input.reason,provenance ? JSON.stringify(provenance) : null,now)
  // Existing memory/history rows remain untouched. Retired memory workers must
  // not be restarted under the new host. Only the raw current boundary rotates.
  if (currentBoundary) database.prepare('DELETE FROM dsh_run_log_boundaries WHERE run_id=? AND dsh_session_id=?').run(input.runId,input.sessionId)
}


/** Caller owns the stop-confirmation transaction. A confirmed wait/ignore finalizes its stopped source. */
export function scheduleStoppedTaskFinalization(database: SqliteDatabase, identity: {
  taskId: string; sessionId: string; repositoryRoot: string
}, input: { evidenceRef: string; sourceEndSeq: number }, now = new Date().toISOString()): boolean {
  const run=database.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get<Record<string,unknown>>(identity.taskId)
  if(!run || (run.task_owner_session_id??run.dsh_session_id)!==identity.sessionId || run.task_repository_root!==identity.repositoryRoot
    || !['Pending','Ignore'].includes(String(run.task_state)))throw new KiokukoError('CONFLICT','Stopped finalization requires the current stopped task owner')
  const boundary=database.prepare('SELECT * FROM dsh_run_log_boundaries WHERE run_id=? AND dsh_session_id=?')
    .get<Record<string,unknown>>(identity.taskId,identity.sessionId)
  if(!boundary)return false
  if(!Number.isSafeInteger(input.sourceEndSeq) || input.sourceEndSeq<Number(boundary.source_start_seq))
    throw new KiokukoError('CONFLICT','Stopped finalization requires the host-observed source end')
  if(!(JSON.parse(String(run.task_evidence_json)) as string[]).includes(input.evidenceRef)
    || !database.prepare(`SELECT 1 FROM ledger_task_evidence WHERE run_id=? AND evidence_ref=? AND generation=? AND kind='stopped' AND verified=1`)
      .get(identity.taskId,input.evidenceRef,Number(run.task_generation)-1))
    throw new KiokukoError('CONFLICT','Stopped finalization requires its confirmed host stop receipt')
  // A confirmed stop is execution evidence, never approval to save memory.
  return false
}


/** Caller owns the transaction after observing native idle and its final durable source end. */
export function scheduleCompletedTaskFinalization(database: SqliteDatabase, identity: {
  taskId: string; sessionId: string; repositoryRoot: string
}, input: { expectedRevision: number; expectedGeneration: number; sourceEndSeq: number }, now = new Date().toISOString()): boolean {
  const run=database.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get<Record<string,unknown>>(identity.taskId)
  if(!run || (run.task_owner_session_id??run.dsh_session_id)!==identity.sessionId || run.task_repository_root!==identity.repositoryRoot
    || run.task_state!=='Done' || run.task_revision!==input.expectedRevision || run.task_generation!==input.expectedGeneration)
    throw new KiokukoError('CONFLICT','Completion finalization requires the exact current Done task revision and generation')
  if(!database.prepare(`SELECT 1 FROM ledger_task_evidence e JOIN json_each(?) proof ON proof.value=e.evidence_ref
    WHERE e.run_id=? AND e.generation=? AND e.kind='verification' AND e.verified=1`)
    .get(String(run.task_evidence_json),identity.taskId,input.expectedGeneration-1))
    throw new KiokukoError('CONFLICT','Completion finalization requires the task’s confirmed verification receipt')
  const boundary=database.prepare('SELECT source_start_seq FROM dsh_run_log_boundaries WHERE run_id=? AND dsh_session_id=?')
    .get<{source_start_seq:number}>(identity.taskId,identity.sessionId)
  if(!boundary)return false
  if(!Number.isSafeInteger(input.sourceEndSeq) || input.sourceEndSeq<boundary.source_start_seq)
    throw new KiokukoError('CONFLICT','Completion finalization requires the host-observed final log end')
  // Verified completion does not approve a future, unseen memory proposal.
  return false
}
