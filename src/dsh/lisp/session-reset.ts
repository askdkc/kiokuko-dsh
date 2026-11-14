import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { ManagedOperationJournal } from '../managed-operation-journal.js'
import { fail, LispError, type LispOwner } from './contracts.js'

export async function stopBeforeReset(stop: () => Promise<void>, timeoutMs = 10000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([stop(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LispError('STOP_UNCONFIRMED', 'Lisp の停止処理が期限を超えました。実行記録は保持し、新しい SBCL は起動していません。')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** Human-requested reset after owned processes have stopped. Preserve payloads,
 * definitions and results; abandoned means unknown effects, never success. */
export function resetStoppedSessionRecords(db: SqliteDatabase, owner: LispOwner) {
  return withImmediateTransaction(db, () => {
    const session = db.prepare('SELECT root_path FROM dsh_lisp_sessions WHERE session_id=?').get<{root_path:string}>(owner.sessionId)
    if (!session || session.root_path !== owner.root) fail('SCOPE_CONFLICT', 'リセット対象のセッションとリポジトリが一致しません。')
    const journal = new ManagedOperationJournal(db)
    const scopes = db.prepare("SELECT scope_id FROM dsh_managed_scopes WHERE json_extract(scope_json,'$.sessionId')=?")
      .all<{scope_id:string}>(owner.sessionId)
    let abandonedManaged = 0
    let cancelledBeforeDispatch = 0
    for (const scope of scopes) {
      for (const row of db.prepare("SELECT operation_id FROM dsh_managed_operations WHERE scope_id=? AND state='prepared'")
        .all<{operation_id:string}>(scope.scope_id)) {
        journal.transition(row.operation_id, { state: 'cancelled-before-dispatch' })
        cancelledBeforeDispatch++
      }
      journal.recover(scope.scope_id)
      const rows = db.prepare("SELECT operation_id FROM dsh_managed_operations WHERE scope_id=? AND state='unknown'")
        .all<{operation_id:string}>(scope.scope_id)
      for (const row of rows) {
        journal.abandon(row.operation_id, 'Human requested session reset; owned workers stopped; earlier effects remain unknown and are not replayed.')
        abandonedManaged++
      }
    }
    const pending = db.prepare("SELECT operation_id FROM dsh_lisp_operations WHERE session_id=? AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL') AND kind!='binding'")
      .all<{operation_id:string}>(owner.sessionId)
    // Do not parse damaged result/payload JSON, discard backups, or alter IDs.
    db.prepare("UPDATE dsh_lisp_operations SET state='ABANDONED',updated_at=? WHERE session_id=? AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL') AND kind!='binding'")
      .run(new Date().toISOString(), owner.sessionId)
    return { abandonedOperations: pending.length, abandonedManaged, cancelledBeforeDispatch, reexecuted: false, effectsReverted: false }
  })
}
