import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'

/** Caller owns the explicit resume/handoff transaction. Never used by ordinary log binding. */
export function rotateTaskSourceInTransaction(database: SqliteDatabase, input: {
  runId: string; sessionId: string; nextSessionId: string; expectedRevision: number; expectedGeneration: number;
  operationId: string; reason: string; sourceEndSeq?: number
}, now: string): void {
  const run = database.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get<Record<string, unknown>>(input.runId)
  if (!run || (run.task_owner_session_id ?? run.dsh_session_id) !== input.sessionId
    || run.task_revision !== input.expectedRevision || run.task_generation !== input.expectedGeneration)
    throw new KiokukoError('CONFLICT', 'Task source rotation requires the current owner and generation')
  const boundary = database.prepare('SELECT * FROM dsh_run_log_boundaries WHERE run_id=?').get<Record<string, unknown>>(input.runId)
  const job = database.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get<Record<string, unknown>>(input.runId)
  const review = database.prepare('SELECT * FROM memory_review_states WHERE run_id=?').get<Record<string, unknown>>(input.runId)
  if (!boundary && !job && !review) return
  const epoch = database.prepare('SELECT COALESCE(MAX(source_epoch),0)+1 AS epoch FROM dsh_task_source_history WHERE run_id=?').get<{epoch:number}>(input.runId)!.epoch
  if (job && job.source_epoch !== epoch) throw new KiokukoError('INTEGRITY_ERROR', 'Task finalization source epoch changed')
  if (boundary && !job && (!Number.isSafeInteger(input.sourceEndSeq) || input.sourceEndSeq! < Number(boundary.source_start_seq)))
    throw new KiokukoError('CONFLICT', 'Source rotation requires the host-observed stopped log end')
  const json = (row: Record<string, unknown> | undefined) => row ? JSON.stringify(row) : null
  database.prepare(`INSERT INTO dsh_task_source_history(run_id,source_epoch,source_session_id,original_session_id,task_generation,
    next_owner_session_id,operation_id,reason,boundary_json,finalization_json,review_state_json,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.runId,epoch,input.sessionId,String(run.dsh_session_id),input.expectedGeneration,input.nextSessionId,
      input.operationId,input.reason,json(boundary),json(job),json(review),now)
  database.prepare(`INSERT INTO dsh_task_source_entries(run_id,source_epoch,entry_id,ordinal,created_at)
    SELECT run_id,?,entry_id,ordinal,created_at FROM dsh_memory_finalization_entries WHERE run_id=?`).run(epoch,input.runId)
  if (job || boundary) {
    const sourceJob: Record<string, unknown> = job ? { ...job, claim_nonce: null, lease_until: null,
      status: job.status === 'processing' ? 'pending' : job.status } : {
      run_id: input.runId, workspace: run.workspace, dsh_session_id: input.sessionId, source_epoch: epoch,
      source_start_seq: boundary!.source_start_seq, source_end_seq: input.sourceEndSeq, status: 'pending', attempt_count: 0,
      input_mode: 'bounded_evidence', extraction_version: 2, evidence_selection_version: 2, memory_adoption_version: 2,
      evidence_contract_version: 4, capture_admission: 'ready', scheduled_at: now, updated_at: now,
    }
    sourceJob.outcome = job?.source_outcome ?? (['completed','failed','cancelled','interrupted'].includes(String(run.status)) ? run.status : 'interrupted')
    sourceJob.source_generation = review?.source_generation ?? `legacy:${input.sessionId}`
    database.prepare('INSERT INTO dsh_task_source_finalizations(run_id,source_epoch,job_json) VALUES(?,?,?)')
      .run(input.runId,epoch,JSON.stringify(sourceJob))
  }
  // Deleting only the current projection revokes its nonce; memory entries and historical links remain.
  database.prepare('DELETE FROM dsh_memory_finalizations WHERE run_id=?').run(input.runId)
  database.prepare('DELETE FROM dsh_run_log_boundaries WHERE run_id=?').run(input.runId)
  database.prepare(`UPDATE memory_review_jobs SET state='superseded',owner_nonce=NULL,lease_until=NULL,reason='task_source_rotated'
    WHERE run_id=? AND state IN ('pending','claimed','dispatched','deferred')`).run(input.runId)
  database.prepare(`UPDATE memory_review_states SET session_id=?,source_generation=?,admitted_after_seq=-1,
    scanned_through_seq=-1,scheduled_through_seq=-1,reviewed_through_seq=-1,terminal_outcome=NULL,
    handoff_run_id=NULL,handoff_status='none',lease_nonce=NULL,lease_until=NULL,lease_owner=NULL,reason='task_source_rotated' WHERE run_id=?`)
    .run(input.nextSessionId,`task-source:${epoch+1}:${input.nextSessionId}`,input.runId)
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
  const existing=database.prepare('SELECT source_end_seq,dsh_session_id FROM dsh_memory_finalizations WHERE run_id=?')
    .get<{source_end_seq:number;dsh_session_id:string}>(identity.taskId)
  if(existing){
    if(existing.source_end_seq!==input.sourceEndSeq || existing.dsh_session_id!==identity.sessionId)
      throw new KiokukoError('CONFLICT','Stopped finalization source range changed')
    return true
  }
  const outcome=['completed','failed','cancelled','interrupted'].includes(String(run.status)) ? String(run.status) : 'interrupted'
  database.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,
    status,attempt_count,input_mode,extraction_version,evidence_selection_version,memory_adoption_version,capture_admission,evidence_contract_version,
    scheduled_at,updated_at,source_epoch,source_outcome)
    VALUES(?,?,?,?,?,'pending',0,'bounded_evidence',2,2,2,'ready',4,?,?,
      (SELECT COALESCE(MAX(source_epoch),0)+1 FROM dsh_task_source_history WHERE run_id=?),?)`)
    .run(identity.taskId,String(run.workspace),identity.sessionId,Number(boundary.source_start_seq),input.sourceEndSeq,now,now,identity.taskId,outcome)
  return true
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
  const existing=database.prepare('SELECT dsh_session_id,source_end_seq,source_outcome FROM dsh_memory_finalizations WHERE run_id=?')
    .get<{dsh_session_id:string;source_end_seq:number;source_outcome:string|null}>(identity.taskId)
  if(existing){
    if(existing.dsh_session_id!==identity.sessionId || existing.source_end_seq!==input.sourceEndSeq
      || existing.source_outcome!==null && existing.source_outcome!=='completed')
      throw new KiokukoError('CONFLICT','Completion finalization source range changed')
    return true
  }
  database.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,
    status,attempt_count,input_mode,extraction_version,evidence_selection_version,memory_adoption_version,capture_admission,evidence_contract_version,
    scheduled_at,updated_at,source_epoch,source_outcome)
    VALUES(?,?,?,?,?,'pending',0,'bounded_evidence',2,2,2,'ready',4,?,?,
      (SELECT COALESCE(MAX(source_epoch),0)+1 FROM dsh_task_source_history WHERE run_id=?),'completed')`)
    .run(identity.taskId,String(run.workspace),identity.sessionId,boundary.source_start_seq,input.sourceEndSeq,now,now,identity.taskId)
  return true
}
