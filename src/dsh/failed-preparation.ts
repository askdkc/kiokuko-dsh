import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { LedgerStore } from '../ledger/store.js'
import { readExecutionOwner } from './orchestration/execution-owner.js'
import { dshTurnRequestId } from './intake-profile-resolver.js'

/** Release only the reservation acquired by this failed, never-admitted intake.
 * Keep cancelled history and its exact revision fence; never retire actual work. */
export function releaseFailedPreparation(db: SqliteDatabase, sessionId: string, requestId: string): void {
  withImmediateTransaction(db, () => {
    const owner = readExecutionOwner(db, sessionId)
    if (!owner || owner.mode !== 'normal' || owner.start_id !== requestId || !owner.run_id) return
    const runId = owner.run_id
    const pending = db.prepare(`SELECT 1 FROM ledger_runs WHERE run_id=? AND workspace=? AND dsh_session_id=?
      AND status='intake' AND task_state='ToDo' AND task_managed=0 AND task_resumed=0
      AND task_revision=1 AND task_generation=1 AND COALESCE(task_owner_session_id,dsh_session_id)=dsh_session_id
      AND task_pending_stop_json IS NULL AND task_unresolved_json IS NULL
      AND NOT EXISTS (SELECT 1 FROM dsh_owned_operations WHERE run_id=ledger_runs.run_id)`).get(runId, owner.workspace, sessionId)
    if (!pending) return
    new LedgerStore(db).updateRunStatusInTransaction(runId, 'cancelled')
    // The terminal-outcome trigger increments these fences and leaves task_state
    // Pending. Cancellation is not successful completion and is not Ignore.
    const fence = db.prepare('SELECT task_revision AS revision,task_generation AS generation FROM ledger_runs WHERE run_id=?')
      .get<{ revision: number; generation: number }>(runId)!
    db.prepare("UPDATE ledger_runs SET metadata_json=json_set(metadata_json,'$.failedPreparation',json(?)) WHERE run_id=?")
      .run(JSON.stringify({ version: 1, sessionId, requestId, ...fence }), runId)
    db.prepare("DELETE FROM dsh_execution_owners WHERE dsh_session_id=? AND start_id=? AND run_id=? AND workspace=? AND mode='normal'")
      .run(sessionId, requestId, runId, owner.workspace)
  })
}

type PreparationEvent = { readonly seq: number; readonly type: string; readonly data?: unknown; readonly sourceEventSeqs?: readonly number[] }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Recover a pre-fix reservation only from the current native session's exact
 * failed preparation call/result pair. Missing/compacted/unknown outcomes and
 * unrelated failures are not recovery authority. No replay or text matching. */
export function reconcileFailedPreparation(db: SqliteDatabase, sessionId: string, snapshot: () => readonly PreparationEvent[]): void {
  const owner = readExecutionOwner(db, sessionId)
  if (!owner || owner.mode !== 'normal' || !owner.run_id) return
  const events = snapshot()
  const start = Math.max(0, events.length - 2048)
  for (let i = events.length - 1; i >= start; i--) {
    const result = events[i]!
    if (result.type !== 'tool/result') continue
    const data = record(result.data), message = record(data?.message)
    const turn = data?.turn
    if (message?.role !== 'tool' || message.isError !== true || typeof message.toolCallId !== 'string'
      || record(data?.error)?.code === 'TOOL_OUTCOME_UNKNOWN'
      || typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0
      || dshTurnRequestId({ dshSessionId: sessionId, turn }) !== owner.start_id
      || result.sourceEventSeqs?.length !== 1) continue
    for (let j = i - 1; j >= start; j--) {
      const call = events[j]!
      if (call.seq !== result.sourceEventSeqs[0]) continue
      const called = record(call.data)
      if (call.type === 'tool/call' && called?.name === 'prepare_requested_work'
        && called.turn === turn && called.callId === message.toolCallId) {
        // Legacy owners bind a turn, not a call. Multiple attempts or a missing
        // turn boundary cannot prove which call created this reservation.
        let began = false, preparations = 0
        for (let k = start; k < events.length; k++) {
          const event = events[k]!, item = record(event.data)
          if (item?.turn !== turn) continue
          if (event.type === 'turn/start' && event.seq < call.seq) began = true
          if (event.type === 'tool/call' && item.name === 'prepare_requested_work') preparations++
        }
        if (began && preparations === 1) releaseFailedPreparation(db, sessionId, owner.start_id)
      }
      return
    }
  }
}

/** A failed preparation owns no project work. Any later state transition or
 * operation invalidates this proof; generic cancelled/failed tasks stay fenced. */
export function isReleasedPreparation(db: SqliteDatabase, runId: string, sessionId: string): boolean {
  return db.prepare(`SELECT 1 FROM ledger_runs r WHERE r.run_id=? AND r.dsh_session_id=?
    AND COALESCE(r.task_owner_session_id,r.dsh_session_id)=? AND r.status='cancelled'
    AND r.task_state='Pending' AND r.task_managed=0 AND r.task_resumed=0
    AND r.task_pending_stop_json IS NULL AND r.task_unresolved_json IS NULL
    AND json_extract(r.metadata_json,'$.failedPreparation.version')=1
    AND json_extract(r.metadata_json,'$.failedPreparation.sessionId')=r.dsh_session_id
    AND json_type(r.metadata_json,'$.failedPreparation.requestId')='text'
    AND json_extract(r.metadata_json,'$.failedPreparation.revision')=r.task_revision
    AND json_extract(r.metadata_json,'$.failedPreparation.generation')=r.task_generation
    AND NOT EXISTS (SELECT 1 FROM dsh_execution_owners WHERE run_id=r.run_id)
    AND NOT EXISTS (SELECT 1 FROM dsh_owned_operations WHERE run_id=r.run_id)`)
    .get(runId, sessionId, sessionId) !== undefined
}
