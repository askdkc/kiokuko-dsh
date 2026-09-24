import type { SqliteDatabase } from '../../db/adapter.js'
import { randomUUID } from 'node:crypto'
import { digest, fail, type LispOwner } from './contracts.js'

export interface LispDatabase { <T>(fn: (db: SqliteDatabase) => T): Promise<T> }
export interface Operation extends Record<string, unknown> {
  session_id: string; agent_id: string; operation_id: string; kind: string; digest: string; generation: string;
  state: string; payload: string; result: string | null; updated_at: string
}
export interface Session extends Record<string, unknown> { session_id: string; root_path: string; enabled: number; epoch: string }

/** Only the host uses this store; every mutation stays inside the runtime's DB service. */
export class LispStore {
  constructor(readonly database: LispDatabase) {}
  async start(): Promise<Session[]> {
    return this.database(db => {
      db.prepare("UPDATE dsh_lisp_operations SET state='UNKNOWN',updated_at=? WHERE state IN ('RUNNING','APPLYING','AWAITING_APPROVAL')").run(new Date().toISOString())
      // Older hosts marked evaluation success before applying proposals. A parent
      // without its final changes array is incomplete, not a successful receipt.
      db.prepare(`UPDATE dsh_lisp_operations SET state='UNKNOWN',updated_at=?
        WHERE kind='lisp_eval' AND state='SUCCEEDED' AND json_array_length(result,'$.proposals')>0
        AND json_type(result,'$.changes') IS NULL`).run(new Date().toISOString())
      return db.prepare('SELECT * FROM dsh_lisp_sessions WHERE enabled=1').all<Session>()
    })
  }
  /** Host-issued identity; both transport retries and model logical IDs bind to it. */
  bind(owner: LispOwner, callId: string, logicalId: string, input: unknown): Promise<string> {
    return this.database(db => {
      const hash = digest(input), keys = [`call-${digest(callId)}`, `request-${digest(logicalId)}`]
      const read = db.prepare("SELECT * FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?")
      const existing = keys.map(key => read.get<Operation>(owner.sessionId, owner.agentId, key))
      for (const row of existing) if (row && (row.kind !== 'binding' || row.digest !== hash)) fail('ID_CONFLICT', '同じ呼び出し ID に異なる入力があります。')
      const ids = existing.filter(Boolean).map(row => (JSON.parse(row!.payload) as {id:string}).id)
      if (new Set(ids).size > 1) fail('ID_CONFLICT', '呼び出しと論理要求の対応が一致しません。')
      const id = ids[0] ?? randomUUID()
      const count = db.prepare('SELECT COUNT(*) AS count FROM dsh_lisp_operations WHERE session_id=?').get<{count:number}>(owner.sessionId)!.count
      if (count + existing.filter(row => !row).length > 10000) fail('JOURNAL_LIMIT', 'Lisp 記録の件数上限です。')
      for (const [index, key] of keys.entries()) if (!existing[index]) db.prepare('INSERT INTO dsh_lisp_operations VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(owner.sessionId, owner.agentId, key, 'binding', hash, 'host', 'BOUND', JSON.stringify({ id }), null, new Date().toISOString())
      return id
    })
  }
  /** Keep identity/digest tombstones. Never expire file recovery or unknown outcomes. */
  expireResults(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString()
    return this.database(db => {
      db.prepare("UPDATE dsh_lisp_operations SET result=NULL WHERE kind IN ('lisp_eval','lisp_describe','lisp_inspect','lisp_reset','lisp_cancel') AND state IN ('SUCCEEDED','FAILED','CANCELLED') AND updated_at<? AND result IS NOT NULL").run(cutoff)
    })
  }
  session(id: string): Promise<Session | undefined> { return this.database(db => db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(id)) }
  async decline(owner: LispOwner): Promise<void> {
    await this.database(db => {
      const old = db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(owner.sessionId)
      if (old && (old.root_path !== owner.root || old.enabled)) fail('SCOPE_CONFLICT', 'Lisp の状態が変わっています。現在のセッションを確認してください。')
      db.prepare('INSERT OR IGNORE INTO dsh_lisp_sessions(session_id,root_path,enabled,epoch,updated_at) VALUES(?,?,0,?,?)')
        .run(owner.sessionId, owner.root, randomUUID(), new Date().toISOString())
    })
  }
  async enable(owner: LispOwner): Promise<void> {
    await this.database(db => {
      const old = db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(owner.sessionId)
      if (old && old.root_path !== owner.root) fail('SCOPE_CONFLICT', 'セッションの作業場所が変わっています。')
      db.prepare('INSERT INTO dsh_lisp_sessions(session_id,root_path,enabled,epoch,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET enabled=1,updated_at=excluded.updated_at')
        .run(owner.sessionId, owner.root, randomUUID(), new Date().toISOString())
    })
  }
  async disable(id: string): Promise<void> { await this.database(db => db.prepare('UPDATE dsh_lisp_sessions SET enabled=0,epoch=?,updated_at=? WHERE session_id=?').run(randomUUID(), new Date().toISOString(), id)) }
  get(owner: LispOwner, id: string): Promise<Operation | undefined> {
    return this.database(db => db.prepare('SELECT * FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<Operation>(owner.sessionId, owner.agentId, id))
  }
  async reserve(owner: LispOwner, id: string, kind: string, hash: string, generation: string, payload: unknown): Promise<Operation | undefined> {
    return this.database(db => {
      const old = db.prepare('SELECT * FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<Operation>(owner.sessionId, owner.agentId, id)
      if (old) {
        if (old.digest !== hash || old.kind !== kind) fail('ID_CONFLICT', '同じ操作 ID に異なる内容が指定されました。')
        return old
      }
      const usage = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(payload)+COALESCE(length(result),0)),0) AS bytes FROM dsh_lisp_operations WHERE session_id=?').get<{count:number;bytes:number}>(owner.sessionId)!
      if (usage.count >= 10000 || usage.bytes + Buffer.byteLength(JSON.stringify(payload)) > 1024 ** 3) fail('JOURNAL_LIMIT', 'このセッションの Lisp 記録が上限です。記録を確認するまで新しい操作を停止します。')
      const total = db.prepare('SELECT COALESCE(SUM(length(payload)+COALESCE(length(result),0)),0) AS bytes FROM dsh_lisp_operations').get<{bytes:number}>()!
      if (total.bytes + Buffer.byteLength(JSON.stringify(payload)) > 4 * 1024 ** 3) fail('JOURNAL_LIMIT', 'Lisp 記録の全体上限です。新しい操作を停止します。')
      db.prepare('INSERT INTO dsh_lisp_operations VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(owner.sessionId, owner.agentId, id, kind, hash, generation, 'RUNNING', JSON.stringify(payload), null, new Date().toISOString())
      return undefined
    })
  }
  async transition(owner: LispOwner, id: string, expected: readonly string[], state: string, result: unknown, payload?: unknown): Promise<void> {
    await this.database(db => {
      const old = db.prepare('SELECT state FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<{state:string}>(owner.sessionId, owner.agentId, id)
      if (!old || !expected.includes(old.state)) fail('STATE_CONFLICT', '操作の状態が変わっています。再実行せず状態を確認してください。')
      const encoded = JSON.stringify(result), nextPayload = payload === undefined ? null : JSON.stringify(payload)
      const usage = db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))+COALESCE(length(CAST(result AS BLOB)),0)),0) AS bytes FROM dsh_lisp_operations WHERE session_id=?').get<{bytes:number}>(owner.sessionId)!.bytes
      const total = db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))+COALESCE(length(CAST(result AS BLOB)),0)),0) AS bytes FROM dsh_lisp_operations').get<{bytes:number}>()!.bytes
      const increase = Buffer.byteLength(encoded) + (nextPayload ? Buffer.byteLength(nextPayload) : 0)
      if (usage + increase > 1024 ** 3 || total + increase > 4 * 1024 ** 3) fail('JOURNAL_LIMIT', '結果を安全に保存できる容量がありません。再実行せず状態を確認してください。')
      db.prepare('UPDATE dsh_lisp_operations SET state=?,result=?,payload=COALESCE(?,payload),updated_at=? WHERE session_id=? AND agent_id=? AND operation_id=?')
        .run(state, encoded, nextPayload, new Date().toISOString(), owner.sessionId, owner.agentId, id)
    })
  }
  operations(sessionId: string): Promise<Operation[]> {
    return this.database(db => db.prepare("SELECT * FROM dsh_lisp_operations WHERE session_id=? AND kind!='binding' ORDER BY CASE WHEN state IN ('RUNNING','APPLYING','UNKNOWN','AWAITING_APPROVAL') THEN 0 ELSE 1 END, updated_at DESC").all<Operation>(sessionId))
  }
  operationSummaries(sessionId: string, offset?: number): Promise<{ operations: Pick<Operation, 'operation_id' | 'agent_id' | 'kind' | 'state' | 'updated_at'>[]; count: number; pendingStates: Record<string, number> }> {
    return this.database(db => {
      const where = "session_id=? AND kind!='binding'"
      const count = db.prepare(`SELECT COUNT(*) AS count FROM dsh_lisp_operations WHERE ${where}`).get<{count:number}>(sessionId)!.count
      const states = db.prepare(`SELECT state,COUNT(*) AS count FROM dsh_lisp_operations WHERE ${where} AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL') GROUP BY state`)
        .all<{state:string;count:number}>(sessionId)
      const operations = db.prepare(`SELECT operation_id,agent_id,kind,state,updated_at FROM dsh_lisp_operations WHERE ${where}
        ORDER BY CASE WHEN state IN ('RUNNING','APPLYING','UNKNOWN','AWAITING_APPROVAL') THEN 0 ELSE 1 END,updated_at DESC${offset === undefined ? '' : ' LIMIT 10 OFFSET ?'}`)
        .all<Pick<Operation, 'operation_id' | 'agent_id' | 'kind' | 'state' | 'updated_at'>>(sessionId, ...(offset === undefined ? [] : [offset]))
      return { operations, count, pendingStates: Object.fromEntries(states.map(row => [row.state,row.count])) }
    })
  }
  hasPending(sessionId: string): Promise<boolean> {
    return this.database(db => db.prepare("SELECT 1 FROM dsh_lisp_operations WHERE session_id=? AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL') LIMIT 1").get(sessionId) !== undefined)
  }
  countByKind(sessionId: string, kind: string): Promise<number> {
    return this.database(db => db.prepare('SELECT COUNT(*) AS count FROM dsh_lisp_operations WHERE session_id=? AND kind=?').get<{count:number}>(sessionId,kind)!.count)
  }
  proposalReceipts(owner: LispOwner, evalId: string): Promise<{ id: string; state: string; path: string; result: string | null }[]> {
    return this.database(db => db.prepare(`SELECT operation_id AS id,state,json_extract(payload,'$.request.path') AS path,result
      FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND kind='proposal'
      AND COALESCE(json_extract(payload,'$.evalId'),json_extract(result,'$.evalId'))=? ORDER BY operation_id`)
      .all<{ id: string; state: string; path: string; result: string | null }>(owner.sessionId, owner.agentId, evalId))
  }
  pendingTargets(): Promise<Operation[]> {
    return this.database(db => db.prepare("SELECT * FROM dsh_lisp_operations WHERE kind='proposal' AND state IN ('APPLYING','UNKNOWN')").all<Operation>())
  }
}
