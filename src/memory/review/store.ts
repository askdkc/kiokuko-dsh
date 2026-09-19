import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../../db/adapter.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { assertCaptureAllowed, capturePolicy } from '../capture-policy.js'
import { MemoryReviewConfig, type ReviewConfig, type ReviewInput, type ReviewJob, type ReviewRange } from './contracts.js'
import type { CompletedReviewTurn } from './evidence.js'

export interface ReviewState extends Record<string,unknown> {
  run_id:string; workspace:string; session_id:string; source_generation:string; admitted_after_seq:number;
  scanned_through_seq:number; scheduled_through_seq:number; reviewed_through_seq:number;
  terminal_outcome:string|null; handoff_status:string; lease_nonce:string|null; lease_until:string|null; reason:string|null
}
export function reviewSettings(db:SqliteDatabase,workspace:string): {generation:number;config:ReviewConfig}|undefined {
  const row=db.prepare('SELECT generation,config_json FROM memory_review_control WHERE workspace=?').get<{generation:number;config_json:string}>(workspace)
  return row?{generation:row.generation,config:MemoryReviewConfig.parse(JSON.parse(row.config_json))}:undefined
}
/** Startup never overwrites a newer persistent setting. Changes require the caller's generation. */
export function configureReview(db:SqliteDatabase,workspace:string,config:ReviewConfig,now:string,expectedGeneration?:number):void {
  const checked=MemoryReviewConfig.parse(config), hash=canonicalContentHash(checked)
  db.prepare('INSERT OR IGNORE INTO memory_review_control(workspace,config_hash,config_json,updated_at) VALUES(?,?,?,?)').run(workspace,hash,JSON.stringify(checked),now)
  if(expectedGeneration===undefined)return
  const current=reviewSettings(db,workspace)!
  if(current.generation!==expectedGeneration)throw new Error('settings_generation_conflict')
  db.prepare('UPDATE memory_review_control SET config_hash=?,config_json=?,generation=generation+1,updated_at=? WHERE workspace=? AND generation=? AND config_hash<>?')
    .run(hash,JSON.stringify(checked),now,workspace,expectedGeneration,hash)
  const changed=db.prepare('SELECT changes() AS n').get<{n:number}>()!.n
  if(changed){
    db.prepare("UPDATE memory_review_jobs SET state=CASE WHEN dispatched_at IS NULL THEN 'cancelled' ELSE 'held' END,reason='settings_changed',owner_nonce=NULL WHERE workspace=? AND state IN ('pending','claimed','dispatched','deferred')").run(workspace)
    db.prepare("UPDATE memory_review_states SET lease_nonce=NULL,lease_until=NULL WHERE workspace=? AND lease_owner NOT LIKE 'finalizer:%'").run(workspace)
  }
}
export function reviewState(db:SqliteDatabase,runId:string):ReviewState|undefined {return db.prepare('SELECT * FROM memory_review_states WHERE run_id=?').get<ReviewState>(runId)}
export function admitReview(db:SqliteDatabase,range:ReviewRange):ReviewState {
  const run=db.prepare('SELECT workspace,dsh_session_id,status FROM ledger_runs WHERE run_id=?').get<{workspace:string;dsh_session_id:string;status:string}>(range.runId)
  if(!run||run.workspace!==range.workspace||run.dsh_session_id!==range.sessionId||!['active','intake'].includes(run.status))throw new Error('owner_mismatch')
  db.prepare(`INSERT OR IGNORE INTO memory_review_states(run_id,workspace,session_id,source_generation,admitted_after_seq,scanned_through_seq,scheduled_through_seq,reviewed_through_seq)
    VALUES(?,?,?,?,?,?,?,?)`).run(range.runId,range.workspace,range.sessionId,range.sourceGeneration,range.startSeq-1,range.startSeq-1,range.startSeq-1,range.startSeq-1)
  const state=reviewState(db,range.runId)!
  if(state.workspace!==range.workspace||state.session_id!==range.sessionId||state.source_generation!==range.sourceGeneration)throw new Error('source_generation_changed')
  return state
}
export function recordReviewTurns(db:SqliteDatabase,state:ReviewState,turns:CompletedReviewTurn[],scanned:number):void {
  const current=reviewState(db,state.run_id)!
  if(current.scanned_through_seq!==state.scanned_through_seq)return
  for(const turn of turns) {
    if(turn.start<=state.admitted_after_seq)continue
    // A recovered input is not new even if grouped with a later native turn.
    if(turn.inputIds.some(id=>db.prepare('SELECT 1 FROM memory_review_turns WHERE session_id=? AND source_generation=? AND input_id=?').get(state.session_id,state.source_generation,id)))continue
    // One row per input preserves deduplication; the complete-turn count is DISTINCT start_seq.
    for(const inputId of turn.inputIds)db.prepare('INSERT OR IGNORE INTO memory_review_turns(run_id,session_id,source_generation,start_seq,end_seq,input_id) VALUES(?,?,?,?,?,?)')
      .run(state.run_id,state.session_id,state.source_generation,turn.start,turn.end,inputId)
  }
  db.prepare('UPDATE memory_review_states SET scanned_through_seq=max(scanned_through_seq,?) WHERE run_id=?').run(scanned,state.run_id)
}
export function acquireMemoryLease(db:SqliteDatabase,runId:string,owner:string,now:string,ttl:number):string|undefined {
  const nonce=randomUUID(), until=new Date(Date.parse(now)+ttl).toISOString()
  db.prepare('UPDATE memory_review_states SET lease_nonce=?,lease_until=?,lease_owner=? WHERE run_id=? AND (lease_nonce IS NULL OR lease_until<=?)')
    .run(nonce,until,owner,runId,now)
  const changed=db.prepare('SELECT changes() AS n').get<{n:number}>()!.n
  return changed?nonce:undefined
}
export function assertMemoryLease(db:SqliteDatabase,runId:string,nonce:string,now:string):void {
  const state=reviewState(db,runId)
  if(!state||state.lease_nonce!==nonce||!state.lease_until||state.lease_until<=now)throw new Error('stale_claim')
}
export function releaseMemoryLease(db:SqliteDatabase,runId:string,nonce:string):void {
  db.prepare('UPDATE memory_review_states SET lease_nonce=NULL,lease_until=NULL,lease_owner=NULL WHERE run_id=? AND lease_nonce=?').run(runId,nonce)
}
export function reserveReview(db:SqliteDatabase,range:ReviewRange,input:ReviewInput,origin:ReviewJob['origin'],now:string,parent?:ReviewJob):ReviewJob {
  const state=reviewState(db,range.runId),settings=reviewSettings(db,range.workspace)
  if(!state||state.workspace!==range.workspace||state.session_id!==range.sessionId||state.source_generation!==range.sourceGeneration)throw new Error('owner_mismatch')
  assertCaptureAllowed(db,range.workspace,range.sessionId)
  if(!settings||settings.config.mode==='off')throw new Error('review_off')
  if(parent){
    const existing=db.prepare('SELECT * FROM memory_review_jobs WHERE retry_parent_id=?').get<ReviewJob>(parent.id)
    if(existing)return existing
    if(parent.resolved_by)throw new Error('already_reviewed')
    if(!['held','rejected','completed','cancelled'].includes(parent.state)||parent.reason==='source_unavailable')throw new Error('retry_not_available')
    if(parent.state==='completed'&&!db.prepare("SELECT 1 FROM memory_review_effects WHERE job_id=? AND disposition='held'").get(parent.id))throw new Error('already_reviewed')
  }else if(state.terminal_outcome)throw new Error('run_terminal')
  if(db.prepare("SELECT 1 FROM dsh_memory_finalizations WHERE run_id=? AND status IN ('pending','processing')").get(range.runId))throw new Error('finalizer_owns_range')
  const id=`review:${canonicalContentHash({range,origin,parent:parent?.id??null,version:1})}`
  const existing=db.prepare('SELECT * FROM memory_review_jobs WHERE id=?').get<ReviewJob>(id)
  if(existing)return existing
  if(!parent&&range.startSeq<=state.scheduled_through_seq)throw new Error('range_already_scheduled')
  const json=JSON.stringify(input)
  db.prepare(`INSERT INTO memory_review_jobs(id,workspace,session_id,run_id,source_generation,start_seq,end_seq,input_json,input_hash,settings_generation,policy_revision,origin,retry_parent_id,state,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(id,range.workspace,range.sessionId,range.runId,range.sourceGeneration,range.startSeq,range.endSeq,json,canonicalContentHash(input),settings.generation,capturePolicy(db,range.workspace,range.sessionId).revision,origin,parent?.id??null,now)
  if(!parent)db.prepare('UPDATE memory_review_states SET scheduled_through_seq=? WHERE run_id=?').run(range.endSeq,range.runId)
  return db.prepare('SELECT * FROM memory_review_jobs WHERE id=?').get<ReviewJob>(id)!
}
export function claimReview(db:SqliteDatabase,workspace:string,now:string):ReviewJob|undefined {
  const settings=reviewSettings(db,workspace)
  if(!settings||settings.config.mode==='off')return
  db.prepare("UPDATE memory_review_jobs SET state='held',reason='dispatch_uncertain',owner_nonce=NULL WHERE workspace=? AND state='dispatched' AND lease_until<=?").run(workspace,now)
  db.prepare("UPDATE memory_review_jobs SET state='pending',owner_nonce=NULL WHERE workspace=? AND state='claimed' AND lease_until<=?").run(workspace,now)
  db.prepare("UPDATE memory_review_jobs SET state='pending',reason=NULL WHERE workspace=? AND state='deferred' AND (next_eligible_at IS NULL OR next_eligible_at<=?)").run(workspace,now)
  const jobs=db.prepare("SELECT * FROM memory_review_jobs WHERE workspace=? AND state='pending' ORDER BY created_at,id LIMIT 64").all<ReviewJob>(workspace)
  for(const job of jobs){
    if(capturePolicy(db,workspace,job.session_id).mode!=='allowed'||job.settings_generation!==settings.generation){db.prepare("UPDATE memory_review_jobs SET state='cancelled',reason='policy_changed' WHERE id=?").run(job.id);continue}
    const state=reviewState(db,job.run_id)!
    const owner=db.prepare('SELECT workspace,dsh_session_id,status FROM ledger_runs WHERE run_id=?').get<{workspace:string;dsh_session_id:string;status:string}>(job.run_id)
    if(!owner||owner.workspace!==job.workspace||owner.dsh_session_id!==job.session_id||(!['active','intake'].includes(owner.status)&&job.origin!=='retry'))continue
    if(state.terminal_outcome&&job.origin!=='retry')continue
    if(db.prepare("SELECT 1 FROM dsh_memory_finalizations WHERE run_id=? AND status IN ('pending','processing')").get(job.run_id))continue
    const nonce=acquireMemoryLease(db,job.run_id,job.id,now,settings.config.timeoutMs+30000)
    if(!nonce)continue
    const until=reviewState(db,job.run_id)!.lease_until
    db.prepare("UPDATE memory_review_jobs SET state='claimed',owner_nonce=?,attempt=attempt+1,lease_until=? WHERE id=? AND state='pending'").run(nonce,until,job.id)
    return {...job,state:'claimed',owner_nonce:nonce,lease_until:until,attempt:job.attempt+1}
  }
}
export function assertReviewClaim(db:SqliteDatabase,job:ReviewJob,now:string):void {
  const current=db.prepare('SELECT * FROM memory_review_jobs WHERE id=?').get<ReviewJob>(job.id)
  assertCaptureAllowed(db,job.workspace,job.session_id,job.policy_revision)
  const settings=reviewSettings(db,job.workspace)
  if(!current||!['claimed','dispatched'].includes(current.state)||current.owner_nonce!==job.owner_nonce||current.attempt!==job.attempt||settings?.generation!==job.settings_generation||settings.config.mode==='off')throw new Error('stale_claim')
  const owner=db.prepare('SELECT workspace,dsh_session_id,status FROM ledger_runs WHERE run_id=?').get<{workspace:string;dsh_session_id:string;status:string}>(job.run_id)
  if(!owner||owner.workspace!==job.workspace||owner.dsh_session_id!==job.session_id||(!['active','intake'].includes(owner.status)&&job.origin!=='retry'))throw new Error('owner_changed')
  if(db.prepare("SELECT 1 FROM dsh_memory_finalizations WHERE run_id=? AND status IN ('pending','processing')").get(job.run_id))throw new Error('finalizer_owns_range')
  assertMemoryLease(db,job.run_id,job.owner_nonce!,now)
  const state=reviewState(db,job.run_id)!
  if(state.source_generation!==job.source_generation||state.terminal_outcome&&job.origin!=='retry')throw new Error('owner_changed')
}
export function dispatchReview(db:SqliteDatabase,job:ReviewJob,now:string):boolean {
  assertReviewClaim(db,job,now)
  const settings=reviewSettings(db,job.workspace)!,day=now.slice(0,10)
  const count=db.prepare('SELECT count(*) AS n FROM memory_review_jobs WHERE workspace=? AND dispatch_day=?').get<{n:number}>(job.workspace,day)!.n
  if(count>=settings.config.dailyCalls){
    db.prepare("UPDATE memory_review_jobs SET state='deferred',reason='daily_budget',next_eligible_at=?,owner_nonce=NULL WHERE id=?").run(new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString(),job.id)
    releaseMemoryLease(db,job.run_id,job.owner_nonce!);return false
  }
  db.prepare("UPDATE memory_review_jobs SET state='dispatched',dispatch_day=?,dispatched_at=? WHERE id=? AND state='claimed' AND dispatched_at IS NULL AND owner_nonce=?")
    .run(day,now,job.id,job.owner_nonce)
  const changed=db.prepare('SELECT changes() AS n').get<{n:number}>()!.n
  if(!changed)throw new Error('already_dispatched')
  return true
}
export function advanceReviewed(db:SqliteDatabase,runId:string):void {
  const state=reviewState(db,runId);if(!state)return
  const jobs=db.prepare('SELECT * FROM memory_review_jobs WHERE run_id=? AND retry_parent_id IS NULL AND end_seq>? ORDER BY start_seq').all<ReviewJob>(runId,state.reviewed_through_seq)
  let through=state.reviewed_through_seq
  for(const job of jobs){
    if(!job.resolved_by&&(job.state!=='completed'||db.prepare("SELECT 1 FROM memory_review_effects WHERE job_id=? AND disposition='held'").get(job.id)))break
    through=job.end_seq
  }
  db.prepare('UPDATE memory_review_states SET reviewed_through_seq=? WHERE run_id=?').run(through,runId)
}
export function handoffReview(db:SqliteDatabase,runId:string,outcome:string):void {
  const state=reviewState(db,runId);if(!state)return
  const finalizer=db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get<{workspace:string;dsh_session_id:string;memory_adoption_version:number;source_end_seq:number;source_start_seq:number;capture_admission:string}>(runId)
  const handoff=!!finalizer&&finalizer.workspace===state.workspace&&finalizer.dsh_session_id===state.session_id&&finalizer.memory_adoption_version===2&&finalizer.source_start_seq<=state.admitted_after_seq+1&&finalizer.source_end_seq>=state.scheduled_through_seq&&finalizer.capture_admission==='ready'
  const reason=capturePolicy(db,state.workspace,state.session_id).mode!=='allowed'?'capture_excluded':outcome==='cancelled'?'run_cancelled':handoff?'finalizer_handoff':'no_finalizer_consumer'
  db.prepare('UPDATE memory_review_states SET terminal_outcome=?,handoff_status=?,handoff_run_id=?,lease_nonce=NULL,lease_until=NULL,reason=? WHERE run_id=?')
    .run(outcome,handoff?'finalizer_pending':'no_consumer',handoff?runId:null,reason,runId)
  db.prepare(`UPDATE memory_review_jobs SET state=CASE WHEN dispatched_at IS NOT NULL THEN 'held' WHEN ? THEN 'superseded' ELSE 'cancelled' END,
    owner_nonce=NULL,lease_until=NULL,reason=? WHERE run_id=? AND state IN ('pending','claimed','dispatched','deferred')`).run(handoff?1:0,reason,runId)
}
