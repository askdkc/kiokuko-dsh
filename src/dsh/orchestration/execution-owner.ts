import type { SqliteDatabase } from '../../db/adapter.js'
import { KiokukoError } from '../../errors.js'

export type ExecutionOwner = { dsh_session_id: string; workspace: string; mode: 'normal' | 'enno' | 'deep-thinker'; start_id: string; run_id: string | null }
export function readExecutionOwner(db: SqliteDatabase, sessionId: string): ExecutionOwner | undefined {
  return db.prepare('SELECT * FROM dsh_execution_owners WHERE dsh_session_id=?').get<ExecutionOwner>(sessionId)
}
/** Caller holds the write transaction; acquisition and run creation commit together. */
export function claimExecutionOwner(db: SqliteDatabase, input: { sessionId: string; workspace: string; mode: ExecutionOwner['mode']; startId: string; runId?: string }): void {
  const previous = readExecutionOwner(db, input.sessionId)
  if (previous && (previous.workspace !== input.workspace || previous.start_id !== input.startId || previous.run_id !== null && previous.run_id !== input.runId)) {
    throw new KiokukoError('CONFLICT', 'このSessionには実行中・停止中の別のタスクがあります。完了または取消し後に開始してください。')
  }
  const other = db.prepare("SELECT run_id FROM ledger_runs WHERE dsh_session_id=? AND status IN ('intake','active') AND run_id<>? LIMIT 1").get(input.sessionId, input.runId ?? '')
  if (other) throw new KiokukoError('CONFLICT', 'このSessionには未完了のタスクがあります。先に状態を確認してください。')
  db.prepare(`INSERT INTO dsh_execution_owners(dsh_session_id,workspace,mode,start_id,run_id) VALUES(?,?,?,?,?)
    ON CONFLICT(dsh_session_id) DO UPDATE SET run_id=excluded.run_id, mode=excluded.mode`)
    .run(input.sessionId, input.workspace, input.mode, input.startId, input.runId ?? null)
}
