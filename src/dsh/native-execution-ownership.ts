import type { SqliteDatabase } from '../db/adapter.js'
import { readCodingWorkflow } from './coding-workflow/store.js'

export interface NativeJobView {
  readonly id: string
  readonly kind: string
  readonly owner?: string
  readonly status: string
  readonly startedAt: number
}

/** Job liveness is not task authority. Only a native Bash registration in
 * this exact session proves ordinary provenance; unknown producers remain
 * guarded. Managed execution is independently checked in authority storage. */
export function hasUnclassifiedNativeJobs(
  jobs: readonly NativeJobView[],
  session: { id: string; snapshotEvents?(): readonly { type: string; data?: any }[] },
): boolean {
  const events = session.snapshotEvents?.() ?? []
  return jobs.some(job => {
    if (['completed', 'killed', 'failed'].includes(job.status)) return false
    if (!['running', 'stopping'].includes(job.status) || job.kind !== 'bash' || job.owner !== session.id) return true
    const registrations = events.filter(event => event.type === 'job/registered' && event.data?.jobId === job.id)
    if (registrations.length !== 1) return true
    const registration = registrations[0]!.data
    return registration.owner !== session.id || registration.kind !== 'bash' || registration.startedAt !== job.startedAt
      || typeof registration.toolCall?.callId !== 'string' || typeof registration.toolCall?.rootCallId !== 'string'
  })
}

/** A live or unconfirmed native child still needs its parent task authority. */
export function hasUnsettledNativeChildren(db: SqliteDatabase, runId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM dsh_owned_operations
    WHERE run_id=? AND state IN ('started', 'unknown')
      AND json_extract(receipt_json, '$.kind')='native_child'
    LIMIT 1
  `).get(runId) !== undefined
}

/** Safety authority only. Missing/invalid storage is an error, not absence.
 * Successfully completed history may remain in the ledger without owning new
 * native work. Pending/held/ignored/failed work and uncertain effects remain owned. */
export function nativeExecutionOwnership(db: SqliteDatabase, sessionId: string, currentRunId?: string): 'unowned' | 'owned' {
  if (db.prepare('SELECT 1 FROM dsh_execution_owners WHERE dsh_session_id=? LIMIT 1').get(sessionId)) return 'owned'
  const runs = db.prepare(`SELECT run_id,status,task_state,task_pending_stop_json,task_unresolved_json,task_generation,task_revision,task_repository_root FROM ledger_runs
    WHERE COALESCE(task_owner_session_id,dsh_session_id)=?`).all<{
      run_id: string; status: string; task_state: string; task_pending_stop_json: string | null; task_unresolved_json: string | null
      task_generation: number; task_revision: number; task_repository_root: string | null
    }>(sessionId)
  if (currentRunId !== undefined && !runs.some(run => run.run_id === currentRunId)) throw new Error('Current native ownership is missing from authority storage')
  for (const run of runs) {
    if (!['active', 'completed'].includes(run.status) || run.task_state !== 'Done' || run.task_pending_stop_json !== null || run.task_unresolved_json !== null) return 'owned'
    // The compatibility reader tolerates pre-workflow schemas; this authority
    // proof must instead reject an unavailable enrollment table.
    db.prepare('SELECT 1 FROM dsh_coding_workflows WHERE run_id=?').get(run.run_id)
    const workflow = readCodingWorkflow(db, run.run_id)
    if (workflow?.protocol
      && (workflow.protocol.phase !== 'report' || workflow.protocol.pending || workflow.protocol.green?.outcome !== 'passed')) return 'owned'
    for (const operation of db.prepare('SELECT state,session_id,generation,receipt_json FROM dsh_owned_operations WHERE run_id=?').all<{ state: string; session_id: string; generation: string; receipt_json: string }>(run.run_id)) {
      const receipt = JSON.parse(operation.receipt_json)
      if (operation.state !== 'completed' || !receipt || typeof receipt !== 'object' || receipt.state !== 'completed' || receipt.runId !== run.run_id
        || receipt.sessionId !== operation.session_id || receipt.generation !== operation.generation
        || !['kioku_read', 'kioku_write', 'kioku_edit', 'kioku_remove', 'kioku_exec', 'native_child'].includes(receipt.kind)
        || receipt.kind === 'kioku_exec' && receipt.processStopped !== true) return 'owned'
      // A finished producer is not proof that its task authority belonged to
      // this owner/generation. Completion advances the task generation, so
      // settled history may precede it; future or unknown provenance stays fenced.
      const authority = receipt.taskAuthority
      if (receipt.kind !== 'kioku_read' || authority !== undefined) {
        if (!authority || authority.taskId !== run.run_id || authority.sessionId !== sessionId
          || authority.repositoryRoot !== run.task_repository_root
          || !Number.isSafeInteger(authority.generation) || authority.generation < 1 || authority.generation > run.task_generation
          || !Number.isSafeInteger(authority.revision) || authority.revision < 1 || authority.revision > run.task_revision) return 'owned'
      }
    }
  }
  return 'unowned'
}
