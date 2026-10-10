import type { SqliteDatabase } from '../db/adapter.js'
import type { DshAgenticReplayBinding, AgenticReplayTrace } from './agenticreplay-types.js'

const fields = ['agenticreplay_run_id','dsh_session_id','recorder_instance_id','recording_generation','workspace_key','store_root','session_cwd','capture_format_version','state','started_at','ended_at','last_error_code','missing_event_count','unresolved_call_count','event_count','recorded_bytes','export_input_bytes'] as const
/** Only metadata is stored here; no event content or host objects. */
export class DshAgenticReplayStore {
  constructor(private readonly db: SqliteDatabase) {}
  recordingChoice(binding: DshAgenticReplayBinding): boolean | undefined {
    const row = this.db.prepare(`SELECT enabled FROM dsh_agenticreplay_session_choices
      WHERE dsh_session_id=? AND workspace_root=? AND session_cwd=? AND store_root=?`)
      .get<{ enabled: number }>(binding.sessionId, binding.workspaceRoot, binding.sessionCwd, binding.storeRoot)
    return row === undefined ? undefined : row.enabled === 1
  }
  saveRecordingChoice(binding: DshAgenticReplayBinding, enabled: boolean): void {
    this.db.prepare(`INSERT INTO dsh_agenticreplay_session_choices VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(dsh_session_id, workspace_root, session_cwd, store_root)
      DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(binding.sessionId, binding.workspaceRoot, binding.sessionCwd, binding.storeRoot, enabled ? 1 : 0, new Date().toISOString())
  }
  save(trace: AgenticReplayTrace): void {
    this.db.prepare(`INSERT INTO dsh_agenticreplay_traces (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})
      ON CONFLICT(agenticreplay_run_id) DO UPDATE SET ${fields.slice(8).map(f => `${f}=excluded.${f}`).join(',')}`)
      .run(...fields.map(f => trace[f]))
  }
  link(runId: string, logicalRunId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO dsh_agenticreplay_trace_run_links VALUES (?, ?)').run(runId, logicalRunId)
  }
  list(sessionId: string, workspaceKey: string): AgenticReplayTrace[] {
    return this.db.prepare('SELECT * FROM dsh_agenticreplay_traces WHERE dsh_session_id=? AND workspace_key=? ORDER BY started_at DESC, agenticreplay_run_id DESC LIMIT 200')
      .all(sessionId, workspaceKey) as unknown as AgenticReplayTrace[]
  }
  get(sessionId: string, workspaceKey: string, runId: string): AgenticReplayTrace | undefined {
    return this.db.prepare('SELECT * FROM dsh_agenticreplay_traces WHERE dsh_session_id=? AND workspace_key=? AND agenticreplay_run_id=?')
      .get(sessionId, workspaceKey, runId) as unknown as AgenticReplayTrace | undefined
  }
  /** Caller supplies proof of a dead owner. Never repair arbitrary process-owned rows. */
  markOwnerIncomplete(instance: string): void {
    this.db.prepare(`UPDATE dsh_agenticreplay_traces SET state='incomplete', last_error_code='owner_terminated', ended_at=?
      WHERE recorder_instance_id=? AND state IN ('starting','recording','finalizing')`).run(new Date().toISOString(), instance)
  }
}
