import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { fail, LispError, type LispOwner } from './contracts.js'

export async function stopBeforeReset(stop: () => Promise<void>, timeoutMs = 10000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([stop(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LispError('STOP_UNCONFIRMED', 'Lisp の停止処理が期限を超えました。実行記録は保持し、新しい SBCL は起動していません。')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** Clear the stopped session's disposable execution state. DSH retains history;
 * completed tools/definitions and other sessions are not execution debris. */
export function resetStoppedSessionRecords(db: SqliteDatabase, owner: LispOwner) {
  return withImmediateTransaction(db, () => {
    const session = db.prepare('SELECT root_path FROM dsh_lisp_sessions WHERE session_id=?').get<{root_path:string}>(owner.sessionId)
    if (!session || session.root_path !== owner.root) fail('SCOPE_CONFLICT', 'リセット対象のセッションとリポジトリが一致しません。')
    const scopes = db.prepare("SELECT scope_id FROM dsh_managed_scopes WHERE json_extract(scope_json,'$.sessionId')=?")
      .all<{scope_id:string}>(owner.sessionId)
    let deletedManaged = 0
    for (const scope of scopes) {
      const pending = db.prepare("SELECT operation_id FROM dsh_managed_operations WHERE scope_id=? AND state IN ('prepared','dispatching','running','unknown','abandoned')")
        .all<{operation_id:string}>(scope.scope_id)
      if (!pending.length) continue
      // Snapshots contain copies of the same stale state. No JSON decoding or
      // user-authored reconciliation is needed to discard disposable records.
      db.prepare('DELETE FROM dsh_managed_snapshots WHERE scope_id=?').run(scope.scope_id)
      for (const row of pending) db.prepare('DELETE FROM dsh_managed_transitions WHERE operation_id=?').run(row.operation_id)
      db.prepare("DELETE FROM dsh_managed_operations WHERE scope_id=? AND state IN ('prepared','dispatching','running','unknown','abandoned')").run(scope.scope_id)
      deletedManaged += pending.length
    }
    const pending = db.prepare("SELECT operation_id FROM dsh_lisp_operations WHERE session_id=? AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL','ABANDONED') AND kind!='binding'")
      .all<{operation_id:string}>(owner.sessionId)
    db.prepare("DELETE FROM dsh_lisp_operations WHERE session_id=? AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL','ABANDONED') AND kind!='binding'")
      .run(owner.sessionId)
    return { deletedOperations: pending.length, deletedManaged, reexecuted: false, effectsReverted: false }
  })
}
