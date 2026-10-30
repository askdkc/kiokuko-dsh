import { canonicalContentHash } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import { isCredentialName, scrubAgenticReplayText } from './agenticreplay-security.js'
import { assessTaskCompletion } from './task-completion.js'

/** Export projection only: the canonical private mirror and its identity stay unchanged. */
export function redactSessionExport(value: unknown, depth = 0): any {
  if (depth > 64) return { omitted: 'export_depth_limit' }
  if (typeof value === 'string') return scrubAgenticReplayText(value)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redactSessionExport(item, depth + 1))
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isCredentialName(key)
    && !/^(?:credentials?|replayState)$/iu.test(key)).map(([key,item]) => [key,redactSessionExport(item,depth+1)]))
}
const label = (value: unknown) => typeof value === 'string' && /^[\w:./-]{1,256}$/u.test(value) ? value : null
const rec = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string,any> : {}

/** Only native events establish call/result links; model prose is never a verification result. */
export class SessionExportAnalysis {
  private calls = new Map<string,Record<string,unknown>>()
  private turns: Record<string,unknown>[] = []
  private omitted = 0
  private count = 0
  private first: number | null = null
  private last: number | null = null
  constructor(readonly sessionId: string) {}
  observe(event: DshLogEvent): void {
    this.count++; this.first ??= event.seq; this.last = event.seq
    const d=rec(event.data), m=rec(d.message)
    if (event.type === 'tool/call') {
      const id=label(d.callId)
      if (!id || this.calls.size >= 256) { this.omitted++; return }
      const name=label(d.name)
      this.calls.set(id,{callId:id,turn:Number.isSafeInteger(d.turn)?d.turn:null,name,callSeq:event.seq,startedAt:event.time,
        route:name?.startsWith('lisp_')?'lisp':'native',outcome:'unresolved',execution:'not_recorded'})
    } else if (event.type === 'tool/result') {
      const id=label(m.toolCallId ?? d.callId), call=id?this.calls.get(id):undefined
      if (!call) { this.omitted++; return }
      Object.assign(call,{resultSeq:event.seq,finishedAt:event.time,
        durationMs:event.time>=Number(call.startedAt)?event.time-Number(call.startedAt):null,
        outcome:m.isError===true||d.isError===true?'error':'returned',resultDigest:canonicalContentHash(event.data ?? null)})
    } else if (event.type === 'turn/end') {
      if (this.turns.length >= 256) {this.omitted++;return}
      this.turns.push({turn:d.turn??null,endSeq:event.seq,time:event.time,reason:label(rec(d.reason).kind),
        verification:'not_implied_by_turn_completion'})
    }
  }
  finish(database: unknown = {status:'unavailable'}): unknown {
    return {format:'kiokuko.export-analysis.v1',sessionId:this.sessionId,events:{count:this.count,firstSeq:this.first,lastSeq:this.last},
      tools:[...this.calls.values()],turns:this.turns,omitted:this.omitted,database,
      limitations:['Native tool return is not proof of task success.','Nested Lisp/native calls require separately recorded parent identities.',
        'Unrecorded plugin revision, artifact identity, dispatch, refusal and deadlines remain unknown.','No automatic memory adoption or external delivery.']}
  }
}

/** Read current host-owned state without adopting memory or executing a verifier. */
export function sessionDatabaseAnalysis(db: SqliteDatabase, sessionId: string): unknown {
  const rows=db.prepare(`SELECT run_id,status,task_revision,task_generation FROM ledger_runs
    WHERE dsh_session_id=? OR task_owner_session_id=? ORDER BY created_at DESC LIMIT 33`).all<Record<string,any>>(sessionId,sessionId)
  const runs=rows.slice(0,32).map(row=>{
    const a=assessTaskCompletion(db,row.run_id)
    return {runId:row.run_id,status:row.status,revision:row.task_revision,generation:row.task_generation,
      completion:{verified:a.verified,mode:a.mode,required:a.required,criteria:a.criteria.map(c=>({criterionId:c.criterionId,
        state:c.state,reason:c.reason,evidenceRef:c.evidenceRef??null}))},
      memory:db.prepare('SELECT status,attempt_count,last_error_code,source_epoch FROM dsh_memory_finalizations WHERE run_id=?').get(row.run_id)??null}
  })
  const decisions=db.prepare(`SELECT e.event_id,e.document_json FROM dsh_diagnostic_events e JOIN dsh_diagnostic_attempts a USING(decision_id)
    WHERE a.session_id=? OR e.target_session_id=? ORDER BY e.created_at DESC LIMIT 129`).all<Record<string,any>>(sessionId,sessionId)
    .slice(0,128).map(row=>({eventId:row.event_id,...JSON.parse(row.document_json)}))
  const recovery=db.prepare('SELECT id,native_turn,origin,state,attempts,last_reason,source_digest,context_digest,updated_at FROM dsh_auxiliary_recovery WHERE session_id=? ORDER BY updated_at DESC LIMIT 64').all(sessionId)
  return redactSessionExport({status:'observed',runs,truncated:rows.length>32,decisions,recovery,
    improvementHandoff:{state:recovery.length?'available_for_review':'no_candidates',consumerReceipt:'not_recorded',automaticAdoption:false}})
}
