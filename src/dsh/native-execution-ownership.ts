import type { SqliteDatabase } from '../db/adapter.js'
import { readCodingWorkflow } from './coding-workflow/store.js'

/** Safety authority only. Missing/invalid storage is an error, not absence.
 * Successfully completed history may remain in the ledger without owning new
 * native work. Pending/held/ignored/failed work and uncertain effects remain owned. */
export function nativeExecutionOwnership(db: SqliteDatabase, sessionId: string, currentRunId?: string): 'unowned' | 'owned' {
  if (db.prepare('SELECT 1 FROM dsh_execution_owners WHERE dsh_session_id=? LIMIT 1').get(sessionId)) return 'owned'
  const runs = db.prepare(`SELECT run_id,status,task_state,task_pending_stop_json,task_unresolved_json FROM ledger_runs
    WHERE COALESCE(task_owner_session_id,dsh_session_id)=?`).all<{
      run_id: string; status: string; task_state: string; task_pending_stop_json: string | null; task_unresolved_json: string | null
    }>(sessionId)
  if (currentRunId !== undefined && !runs.some(run => run.run_id === currentRunId)) throw new Error('Current native ownership is missing from authority storage')
  for (const run of runs) {
    if (!['active', 'completed'].includes(run.status) || run.task_state !== 'Done' || run.task_pending_stop_json !== null || run.task_unresolved_json !== null) return 'owned'
    // The compatibility reader tolerates pre-workflow schemas; this authority
    // proof must instead reject an unavailable enrollment table.
    db.prepare('SELECT 1 FROM dsh_coding_workflows WHERE run_id=?').get(run.run_id)
    const workflow = readCodingWorkflow(db, run.run_id)
    if (workflow && (workflow.state !== 'completed' || workflow.pendingScopeChange || workflow.protocol
      && (workflow.protocol.phase !== 'report' || workflow.protocol.pending || workflow.protocol.green?.outcome !== 'passed'))) return 'owned'
    if (db.prepare("SELECT 1 FROM enno_contracts WHERE run_id=? AND status<>'completed' LIMIT 1").get(run.run_id)) return 'owned'
    for (const operation of db.prepare('SELECT state,receipt_json FROM dsh_owned_operations WHERE run_id=?').all<{ state: string; receipt_json: string }>(run.run_id)) {
      const receipt = JSON.parse(operation.receipt_json)
      if (operation.state !== 'completed' || !receipt || typeof receipt !== 'object' || receipt.state !== 'completed' || receipt.runId !== run.run_id
        || !['kioku_read', 'kioku_write', 'kioku_edit', 'kioku_remove', 'kioku_exec'].includes(receipt.kind)
        || receipt.kind === 'kioku_exec' && receipt.processStopped !== true) return 'owned'
    }
  }
  return 'unowned'
}
