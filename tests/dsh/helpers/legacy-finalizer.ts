import type { SqliteDatabase } from '../../../src/db/adapter.js'
import type { ScheduleDshMemoryFinalizationInput } from '../../../src/dsh/session-memory-finalizer.js'

/** Reserve a pre-v4 job to verify its original prompt, input mode and adoption. */
export function scheduleLegacyFinalizer(db: SqliteDatabase, input: ScheduleDshMemoryFinalizationInput, inputMode = 'prefix_reuse'): void {
  const boundary = db.prepare('SELECT source_start_seq FROM dsh_run_log_boundaries WHERE run_id=?').get<{source_start_seq: number}>(input.runId)!
  const now = new Date().toISOString()
  db.prepare(`INSERT OR IGNORE INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,input_mode,scheduled_at,updated_at)
    VALUES(?,?,?,?,?,'pending',0,?,?,?)`).run(input.runId, input.workspace, input.dshSessionId, boundary.source_start_seq, input.sourceEndSeq, inputMode, now, now)
}
