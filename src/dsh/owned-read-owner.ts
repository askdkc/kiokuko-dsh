import type { SqliteDatabase } from '../db/adapter.js'
import type { ExecutionIdentity, ExecutionReceipt } from './owned-execution.js'
import { findSessionTask } from './task-state.js'

/** Read-only lookup after terminal runs leave the live host map. Caller must
 * already prove the exact registered native agent, session and repository. */
export function readOwnedIdentity(db: SqliteDatabase, agent: any, repositoryRoot: string, operationId?: unknown): ExecutionIdentity | undefined {
  const sessionId = agent.session.id as string
  if (typeof operationId === 'string') {
    const row = db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND session_id=?').get<{receipt_json:string}>(operationId, sessionId)
    if (row) {
      const receipt = JSON.parse(row.receipt_json) as ExecutionReceipt
      if (receipt.repositoryRoot !== repositoryRoot || receipt.sessionId !== sessionId) return undefined
      const run = db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<{workspace:string}>(receipt.runId)
      return run ? { runId: receipt.runId, sessionId, repositoryRoot, generation: receipt.generation, workspace: run.workspace, agent } : undefined
    }
  }
  const task = findSessionTask(db, { sessionId, repositoryRoot }, { includeLatestTerminal: true })
  if (!task) return undefined
  const run = db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<{workspace:string}>(task.taskId)
  return run ? { runId: task.taskId, sessionId, repositoryRoot, generation: `read:${task.revision}:${task.generation}`, workspace: run.workspace, agent } : undefined
}
