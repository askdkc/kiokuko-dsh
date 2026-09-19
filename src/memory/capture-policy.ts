import type { SqliteDatabase } from '../db/adapter.js'

// Best-effort local cancellation. Persistent policy and claim checks are the
// authority across processes; abort alone cannot retract an already sent request.
const activeCaptures = new Map<string, Set<AbortController>>()
export function watchCapture(workspace: string, sessionId: string, controller: AbortController): () => void {
  const key = JSON.stringify([workspace, sessionId])
  const watchers = activeCaptures.get(key) ?? new Set<AbortController>()
  watchers.add(controller); activeCaptures.set(key, watchers)
  return () => { watchers.delete(controller); if (!watchers.size) activeCaptures.delete(key) }
}
export function abortCapture(workspace: string, sessionId: string): void {
  for (const controller of activeCaptures.get(JSON.stringify([workspace, sessionId])) ?? []) controller.abort(new Error('capture_excluded'))
}

export function capturePolicy(db: SqliteDatabase, workspace: string, sessionId: string): { mode: 'allowed'|'held'|'excluded'; revision: number; reason: string|null } {
  return db.prepare('SELECT mode,revision,reason FROM memory_capture_exclusions WHERE workspace=? AND native_session_id=?')
    .get<{mode:'held'|'excluded';revision:number;reason:string}>(workspace, sessionId) ?? { mode: 'allowed', revision: 0, reason: null }
}
export function assertCaptureAllowed(db: SqliteDatabase, workspace: string, sessionId: string, revision?: number): void {
  const policy = capturePolicy(db, workspace, sessionId)
  if (policy.mode !== 'allowed' || revision !== undefined && policy.revision !== revision) throw new Error('capture_excluded')
}
/** Caller owns the immediate transaction. Never stores the triggering utterance. */
export function excludeCapture(db: SqliteDatabase, workspace: string, sessionId: string, mode: 'held'|'excluded', reason: string, now: string): void {
  db.prepare(`INSERT INTO memory_capture_exclusions(workspace,native_session_id,mode,revision,reason,updated_at) VALUES(?,?,?,1,?,?)
    ON CONFLICT(workspace,native_session_id) DO UPDATE SET mode=CASE WHEN mode='excluded' THEN mode ELSE excluded.mode END,
    revision=revision+1,reason=excluded.reason,updated_at=excluded.updated_at`).run(workspace,sessionId,mode,reason,now)
  db.prepare(`UPDATE memory_review_jobs SET state=CASE WHEN dispatched_at IS NULL THEN 'cancelled' ELSE 'held' END,
    reason='capture_excluded',owner_nonce=NULL,lease_until=NULL WHERE workspace=? AND session_id=? AND state IN ('pending','claimed','dispatched','deferred')`).run(workspace,sessionId)
  db.prepare("UPDATE memory_review_states SET lease_nonce=NULL,lease_until=NULL,reason='capture_excluded' WHERE workspace=? AND session_id=?").run(workspace,sessionId)
  db.prepare('UPDATE dsh_memory_finalizations SET capture_admission=?,claim_nonce=NULL,lease_until=NULL WHERE workspace=? AND dsh_session_id=? AND status<>\'completed\'')
    .run(mode,workspace,sessionId)
  db.prepare(`UPDATE dsh_deep_finalizations SET status=CASE WHEN status='pending' THEN 'skipped' ELSE 'uncertain' END,
    error='capture_excluded',lease_until=0 WHERE status IN ('pending','processing')
    AND json_extract(source_json,'$.workspace')=? AND json_extract(source_json,'$.sessionId')=?`).run(workspace,sessionId)
  db.prepare(`UPDATE memory_evolution_jobs SET state='held',reason='capture_excluded',claim_token=NULL,lease_until=NULL
    WHERE state IN ('pending','processing') AND EXISTS(SELECT 1 FROM json_each(input_json) e
    WHERE json_extract(e.value,'$.workspace')=? AND json_extract(e.value,'$.sessionId')=?)`).run(workspace,sessionId)
}
export function captureRefusal(text: string): { mode: 'held'|'excluded'; reason: string }|undefined {
  if (Buffer.byteLength(text) > 1024*1024) return { mode:'held', reason:'capture_input_limit' }
  if (/^(この会話を保存しない|この会話を覚えないで)[。.!！]?$/u.test(text.trim())) return {mode:'excluded',reason:'capture_alias'}
  if (/保存しない|覚えないで|do\s+not\s+remember|don['’]t\s+remember/iu.test(text)) return {mode:'held',reason:'capture_refusal_detected'}
  return undefined
}
