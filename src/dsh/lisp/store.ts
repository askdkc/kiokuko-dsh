import type { SqliteDatabase } from '../../db/adapter.js'
import { randomUUID } from 'node:crypto'
import { digest, fail, type LispOwner } from './contracts.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { ManagedOperationJournal } from '../managed-operation-journal.js'
import { sameProcess } from '../../../lisp/process-identity.mjs'

export interface LispDatabase { <T>(fn: (db: SqliteDatabase) => T): Promise<T> }
export interface Operation extends Record<string, unknown> {
  session_id: string; agent_id: string; operation_id: string; kind: string; digest: string; generation: string;
  state: string; payload: string; result: string | null; updated_at: string
}
export interface Session extends Record<string, unknown> { session_id: string; root_path: string; enabled: number; epoch: string }
export interface SavedState { name: string; revision: number; kind: 'json'|'definition'|'result_ref'; value: unknown; digest: string; updatedAt: string }
export interface LispFallback { fallbackId: string; sessionId: string; agentId: string; state: 'prepared'|'compacted'|'continued'|'failed'; reasonCode: string; handoff: unknown; compaction: unknown; createdAt: string; updatedAt: string }

/** Only the host uses this store; every mutation stays inside the runtime's DB service. */
export class LispStore {
  constructor(readonly database: LispDatabase, readonly authorizePublication: (db: SqliteDatabase, owner: LispOwner) => void = () => {}) {}
  async start(): Promise<Session[]> {
    // Starting another host must never quarantine somebody else's live work.
    return this.database(db => db.prepare('SELECT * FROM dsh_lisp_sessions WHERE enabled=1').all<Session>())
  }
  /** Acquire only the requested session. Process death, never age, permits takeover. */
  claimSession(owner: LispOwner, hostId: string): Promise<void> {
    return this.database(db => withImmediateTransaction(db, () => {
      const session = db.prepare('SELECT root_path FROM dsh_lisp_sessions WHERE session_id=?').get<{root_path:string}>(owner.sessionId)
      if (session && session.root_path !== owner.root) fail('SCOPE_CONFLICT', 'セッションの作業場所が変わっています。')
      const old = db.prepare('SELECT * FROM dsh_lisp_session_hosts WHERE session_id=?')
        .get<{root_path:string;host_id:string;pid:number}>(owner.sessionId)
      if (old?.host_id === hostId && old.pid === process.pid && old.root_path === owner.root) return
      if (old) {
        const identity=old.host_id.match(/^([a-f0-9]{64}):/u)?.[1]
        if (!sameProcess(old.pid,identity)) {
          db.prepare('DELETE FROM dsh_lisp_session_hosts WHERE session_id=? AND host_id=?').run(owner.sessionId, old.host_id)
        }
        if (db.prepare('SELECT 1 FROM dsh_lisp_session_hosts WHERE session_id=?').get(owner.sessionId))
          fail('SESSION_IN_USE', identity ? 'この Lisp セッションは別のホストで使用中です。別のセッションは並行して使えます。'
            : '旧形式の Lisp claim の所有者は PID だけでは確認できません。稼働物を照合してください。claim は自動削除しません。')
      }
      this.recoverSessionInDatabase(db, owner.sessionId)
      db.prepare('INSERT INTO dsh_lisp_session_hosts VALUES(?,?,?,?)').run(owner.sessionId, owner.root, hostId, process.pid)
    }))
  }
  releaseHost(hostId: string): Promise<void> {
    return this.database(db => {
      db.prepare('DELETE FROM dsh_lisp_session_hosts WHERE host_id=? AND pid=?').run(hostId, process.pid)
    })
  }
  private recoverSessionInDatabase(db: SqliteDatabase, sessionId: string): void {
    db.prepare("UPDATE dsh_lisp_operations SET state='UNKNOWN',updated_at=? WHERE session_id=? AND state IN ('RUNNING','APPLYING','AWAITING_APPROVAL')").run(new Date().toISOString(), sessionId)
    // Older hosts marked evaluation success before applying proposals. A parent
    // without its final changes array is incomplete, not a successful receipt.
    db.prepare(`UPDATE dsh_lisp_operations SET state='UNKNOWN',updated_at=?
      WHERE session_id=? AND kind='lisp_eval' AND state='SUCCEEDED' AND json_array_length(result,'$.proposals')>0
      AND json_type(result,'$.changes') IS NULL`).run(new Date().toISOString(), sessionId)
    const journal = new ManagedOperationJournal(db)
    for (const row of db.prepare(`SELECT scope_id FROM dsh_managed_scopes
      WHERE json_extract(scope_json,'$.sessionId')=? AND json_extract(scope_json,'$.runtimeIdentity') LIKE 'sbcl:%'`).all<{scope_id:string}>(sessionId))
      journal.recover(row.scope_id)
  }
  /** Host-issued identity; both transport retries and model logical IDs bind to it. */
  bind(owner: LispOwner, callId: string, logicalId: string, input: unknown): Promise<string> {
    return this.database(db => withImmediateTransaction(db, () => {
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
    }))
  }
  /** Keep identity/digest tombstones. Never expire file recovery or unknown outcomes. */
  expireResults(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString()
    return this.database(db => {
      db.prepare("UPDATE dsh_lisp_operations SET result=NULL WHERE kind IN ('lisp_eval','lisp_describe','lisp_inspect','lisp_reset','lisp_cancel','lisp_recover') AND state IN ('SUCCEEDED','FAILED','CANCELLED') AND updated_at<? AND result IS NOT NULL").run(cutoff)
      db.prepare("UPDATE dsh_lisp_operations SET result=NULL WHERE kind IN ('lisp_define','lisp_call','lisp_observe','task_result','lisp_hot_contract','lisp_hot_install','lisp_hot_call','lisp_hot_deactivate') AND state IN ('SUCCEEDED','FAILED','CANCELLED') AND updated_at<? AND result IS NOT NULL").run(cutoff)
      db.prepare("UPDATE dsh_lisp_operations SET payload='{}',result=NULL WHERE kind='task_tool' AND state='SUCCEEDED' AND updated_at<? AND payload!='{}'").run(cutoff)
    })
  }
  session(id: string): Promise<Session | undefined> { return this.database(db => db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(id)) }
  saveState(owner: LispOwner, name: string, kind: SavedState['kind'], value: unknown): Promise<SavedState> {
    if (!/^[^\p{Cc}\p{Cf}]{1,256}$/u.test(name)) fail('SAVED_STATE_NAME', '保存名が不正です。')
    const encoded = JSON.stringify(value)
    if (encoded === undefined || Buffer.byteLength(encoded) > 16 * 1024 * 1024) fail('SAVED_STATE_VALUE', 'JSON として保存できる 16 MiB 以下の値を指定してください。')
    const hash = digest({ kind, value })
    return this.database(db => withImmediateTransaction(db, () => {
      const session = db.prepare('SELECT root_path,enabled FROM dsh_lisp_sessions WHERE session_id=?').get<{root_path:string;enabled:number}>(owner.sessionId)
      if (!session?.enabled || session.root_path !== owner.root) fail('SCOPE_CONFLICT', '有効な同一作業場所の Lisp セッションだけが状態を保存できます。')
      const old = db.prepare('SELECT revision FROM dsh_lisp_saved_state WHERE session_id=? AND agent_id=? AND name=?')
        .get<{revision:number}>(owner.sessionId, owner.agentId, name)
      if (!old && db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_saved_state WHERE session_id=?').get<{n:number}>(owner.sessionId)!.n >= 1000)
        fail('SAVED_STATE_LIMIT', 'このセッションの保存状態数が上限です。')
      const revision = (old?.revision ?? 0) + 1, now = new Date().toISOString()
      db.prepare(`INSERT INTO dsh_lisp_saved_state(session_id,agent_id,name,revision,kind,value_json,digest,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id,agent_id,name) DO UPDATE SET
        revision=excluded.revision,kind=excluded.kind,value_json=excluded.value_json,digest=excluded.digest,updated_at=excluded.updated_at`)
        .run(owner.sessionId, owner.agentId, name, revision, kind, encoded, hash, now)
      return { name, revision, kind, value: JSON.parse(encoded), digest: hash, updatedAt: now }
    }))
  }
  restoreState(owner: LispOwner, name: string): Promise<SavedState | undefined> {
    return this.database(db => {
      const row = db.prepare(`SELECT name,revision,kind,value_json,digest,updated_at FROM dsh_lisp_saved_state
        WHERE session_id=? AND agent_id=? AND name=?`).get<{name:string;revision:number;kind:SavedState['kind'];value_json:string;digest:string;updated_at:string}>(owner.sessionId, owner.agentId, name)
      if (!row) return
      const value: unknown = JSON.parse(row.value_json)
      if (digest({ kind: row.kind, value }) !== row.digest) fail('SAVED_STATE_CORRUPT', '保存状態の内容が一致しません。')
      return { name: row.name, revision: row.revision, kind: row.kind, value, digest: row.digest, updatedAt: row.updated_at }
    })
  }
  listState(owner: LispOwner): Promise<Omit<SavedState,'value'>[]> {
    return this.database(db => db.prepare(`SELECT name,revision,kind,digest,updated_at FROM dsh_lisp_saved_state
      WHERE session_id=? AND agent_id=? ORDER BY name`).all<{name:string;revision:number;kind:SavedState['kind'];digest:string;updated_at:string}>(owner.sessionId, owner.agentId)
      .map(row => ({ name: row.name, revision: row.revision, kind: row.kind, digest: row.digest, updatedAt: row.updated_at })))
  }
  createFallback(owner: LispOwner, fallbackId: string, reasonCode: string, handoff: unknown): Promise<LispFallback> {
    const encoded = JSON.stringify(handoff)
    if (!encoded || Buffer.byteLength(encoded) > 1024 * 1024) fail('FALLBACK_HANDOFF_LIMIT', '引継ぎ情報が大きすぎます。')
    return this.database(db => withImmediateTransaction(db, () => {
      const existing = db.prepare(`SELECT * FROM dsh_lisp_fallbacks WHERE session_id=? AND state IN ('prepared','compacted','continued')`)
        .get<Record<string,unknown>>(owner.sessionId)
      if (existing) {
        const current = this.fallbackRow(existing)
        if (current.agentId !== owner.agentId || current.fallbackId !== fallbackId || current.reasonCode !== reasonCode || digest(current.handoff) !== digest(JSON.parse(encoded)))
          fail('FALLBACK_CONFLICT', 'このセッションには内容の異なるフォールバック記録があります。')
        return current
      }
      const now = new Date().toISOString()
      db.prepare(`INSERT INTO dsh_lisp_fallbacks(fallback_id,session_id,agent_id,state,reason_code,handoff_json,created_at,updated_at)
        VALUES(?,?,?,'prepared',?,?,?,?)`).run(fallbackId, owner.sessionId, owner.agentId, reasonCode, encoded, now, now)
      return { fallbackId, sessionId: owner.sessionId, agentId: owner.agentId, state: 'prepared', reasonCode,
        handoff: JSON.parse(encoded), compaction: null, createdAt: now, updatedAt: now }
    }))
  }
  activeFallback(sessionId: string): Promise<LispFallback | undefined> {
    return this.database(db => {
      const row = db.prepare(`SELECT * FROM dsh_lisp_fallbacks WHERE session_id=? AND state IN ('prepared','compacted','continued') ORDER BY created_at DESC LIMIT 1`)
        .get<Record<string,unknown>>(sessionId)
      return row ? this.fallbackRow(row) : undefined
    })
  }
  updateFallback(fallbackId: string, state: LispFallback['state'], compaction: unknown): Promise<void> {
    return this.database(db => { db.prepare('UPDATE dsh_lisp_fallbacks SET state=?,compaction_json=?,updated_at=? WHERE fallback_id=?')
      .run(state, JSON.stringify(compaction), new Date().toISOString(), fallbackId) })
  }
  private fallbackRow(row: Record<string,unknown>): LispFallback {
    return { fallbackId: String(row.fallback_id), sessionId: String(row.session_id), agentId: String(row.agent_id),
      state: row.state as LispFallback['state'], reasonCode: String(row.reason_code), handoff: JSON.parse(String(row.handoff_json)),
      compaction: row.compaction_json ? JSON.parse(String(row.compaction_json)) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }
  /** Manual ON is session metadata: one atomic insert, never an unfinished effect journal. */
  manualMode(owner: LispOwner, remember = false): Promise<boolean> {
    return this.database(db => {
      const session = db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(owner.sessionId)
      if (!session?.enabled || session.root_path !== owner.root) return false
      const id = `manual-mode-${session.epoch}`, hash = digest({root:owner.root,epoch:session.epoch})
      if (remember) db.prepare(`INSERT OR IGNORE INTO dsh_lisp_operations
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS
        (SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND root_path=? AND enabled=1 AND epoch=?)`)
        .run(owner.sessionId,'__session__',id,'manual_mode',hash,'host','SUCCEEDED',JSON.stringify({root:owner.root,epoch:session.epoch}),JSON.stringify({enabled:true}),new Date().toISOString(),owner.sessionId,owner.root,session.epoch)
      const saved = db.prepare('SELECT * FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<Operation>(owner.sessionId,'__session__',id)
      const selected = saved?.kind === 'manual_mode' && saved.state === 'SUCCEEDED' && saved.digest === hash
      if (remember && !selected) fail('SCOPE_CONFLICT', 'Manual Lisp selection changed; inspect the session before retrying.')
      return selected
    })
  }
  async decline(owner: LispOwner): Promise<void> {
    await this.database(db => {
      const old = db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(owner.sessionId)
      if (old && (old.root_path !== owner.root || old.enabled)) fail('SCOPE_CONFLICT', 'Lisp の状態が変わっています。現在のセッションを確認してください。')
      db.prepare('INSERT OR IGNORE INTO dsh_lisp_sessions(session_id,root_path,enabled,epoch,updated_at) VALUES(?,?,0,?,?)')
        .run(owner.sessionId, owner.root, randomUUID(), new Date().toISOString())
    })
  }
  async enable(owner: LispOwner): Promise<void> {
    await this.database(db => withImmediateTransaction(db, () => {
      const old = db.prepare('SELECT * FROM dsh_lisp_sessions WHERE session_id=?').get<Session>(owner.sessionId)
      if (old && old.root_path !== owner.root) fail('SCOPE_CONFLICT', 'セッションの作業場所が変わっています。')
      db.prepare('INSERT INTO dsh_lisp_sessions(session_id,root_path,enabled,epoch,updated_at) VALUES(?,?,1,?,?) ON CONFLICT(session_id) DO UPDATE SET enabled=1,updated_at=excluded.updated_at')
        .run(owner.sessionId, owner.root, randomUUID(), new Date().toISOString())
    }))
  }
  async disable(id: string): Promise<void> { await this.database(db => db.prepare('UPDATE dsh_lisp_sessions SET enabled=0,epoch=?,updated_at=? WHERE session_id=?').run(randomUUID(), new Date().toISOString(), id)) }
  get(owner: LispOwner, id: string): Promise<Operation | undefined> {
    return this.database(db => db.prepare('SELECT * FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<Operation>(owner.sessionId, owner.agentId, id))
  }
  async reserve(owner: LispOwner, id: string, kind: string, hash: string, generation: string, payload: unknown): Promise<Operation | undefined> {
    return this.database(db => withImmediateTransaction(db, () => {
      const old = db.prepare('SELECT * FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<Operation>(owner.sessionId, owner.agentId, id)
      if (old) {
        if (old.digest !== hash || old.kind !== kind) fail('ID_CONFLICT', '同じ操作 ID に異なる内容が指定されました。')
        return old
      }
      if (kind === 'proposal') {
        const path = (payload as {before?:{path?:string}}).before?.path
        if (path && db.prepare(`SELECT 1 FROM dsh_lisp_operations WHERE kind='proposal'
          AND state IN ('RUNNING','AWAITING_APPROVAL','APPLYING','UNKNOWN') AND json_extract(payload,'$.before.path')=?`).get(path))
          fail('TARGET_LOCKED', '対象に未確定の変更があります。新しい変更は適用していません。')
      }
      const usage = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(payload)+COALESCE(length(result),0)),0) AS bytes FROM dsh_lisp_operations WHERE session_id=?').get<{count:number;bytes:number}>(owner.sessionId)!
      if (usage.count >= 10000 || usage.bytes + Buffer.byteLength(JSON.stringify(payload)) > 1024 ** 3) fail('JOURNAL_LIMIT', 'このセッションの Lisp 記録が上限です。記録を確認するまで新しい操作を停止します。')
      const total = db.prepare('SELECT COALESCE(SUM(length(payload)+COALESCE(length(result),0)),0) AS bytes FROM dsh_lisp_operations').get<{bytes:number}>()!
      if (total.bytes + Buffer.byteLength(JSON.stringify(payload)) > 4 * 1024 ** 3) fail('JOURNAL_LIMIT', 'Lisp 記録の全体上限です。新しい操作を停止します。')
      db.prepare('INSERT INTO dsh_lisp_operations VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(owner.sessionId, owner.agentId, id, kind, hash, generation, 'RUNNING', JSON.stringify(payload), null, new Date().toISOString())
      return undefined
    }))
  }
  async transition(owner: LispOwner, id: string, expected: readonly string[], state: string, result: unknown, payload?: unknown): Promise<void> {
    await this.database(db => withImmediateTransaction(db, () => {
      const old = db.prepare('SELECT state FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?').get<{state:string}>(owner.sessionId, owner.agentId, id)
      if (!old || !expected.includes(old.state)) fail('STATE_CONFLICT', '操作の状態が変わっています。再実行せず状態を確認してください。')
      if (state === 'SUCCEEDED' || state === 'APPLIED') this.authorizePublication(db, owner)
      const encoded = JSON.stringify(result), nextPayload = payload === undefined ? null : JSON.stringify(payload)
      const usage = db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))+COALESCE(length(CAST(result AS BLOB)),0)),0) AS bytes FROM dsh_lisp_operations WHERE session_id=?').get<{bytes:number}>(owner.sessionId)!.bytes
      const total = db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))+COALESCE(length(CAST(result AS BLOB)),0)),0) AS bytes FROM dsh_lisp_operations').get<{bytes:number}>()!.bytes
      const increase = Buffer.byteLength(encoded) + (nextPayload ? Buffer.byteLength(nextPayload) : 0)
      if (usage + increase > 1024 ** 3 || total + increase > 4 * 1024 ** 3) fail('JOURNAL_LIMIT', '結果を安全に保存できる容量がありません。再実行せず状態を確認してください。')
      db.prepare('UPDATE dsh_lisp_operations SET state=?,result=?,payload=COALESCE(?,payload),updated_at=? WHERE session_id=? AND agent_id=? AND operation_id=?')
        .run(state, encoded, nextPayload, new Date().toISOString(), owner.sessionId, owner.agentId, id)
    }))
  }
  operations(sessionId: string): Promise<Operation[]> {
    return this.database(db => db.prepare("SELECT * FROM dsh_lisp_operations WHERE session_id=? AND kind!='binding' ORDER BY CASE WHEN state IN ('RUNNING','APPLYING','UNKNOWN','AWAITING_APPROVAL') THEN 0 ELSE 1 END, updated_at DESC").all<Operation>(sessionId))
  }
  taskSummary(owner: LispOwner): Promise<{ tools: unknown[]; results: unknown[]; candidates: unknown[]; unresolved: unknown[] }> {
    return this.database(db => {
      const rows = db.prepare(`SELECT operation_id,kind,state,updated_at,result FROM dsh_lisp_operations
        WHERE session_id=? AND agent_id=? AND kind IN ('task_tool','task_result','task_candidate','lisp_verify','lisp_apply')
        ORDER BY updated_at DESC LIMIT 100`).all<Pick<Operation,'operation_id'|'kind'|'state'|'updated_at'|'result'>>(owner.sessionId, owner.agentId)
      const summarize = (kind: string, limit = 5) => rows.filter(row => row.kind === kind).slice(0, limit)
        .map(row => ({ ref: row.operation_id, state: row.state, updatedAt: row.updated_at, available: row.result !== null }))
      return { tools: summarize('task_tool'), results: summarize('task_result'), candidates: summarize('task_candidate'),
        unresolved: rows.filter(row => ['UNKNOWN','RUNNING','APPLYING'].includes(row.state)).slice(0, 5)
          .map(row => ({ ref: row.operation_id, kind: row.kind, state: row.state })) }
    })
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
  /** A stopped evaluation without an accepted result may lose its Lisp state.
   * It still stays UNKNOWN; separate managed and proposal receipts fence effects. */
  hasBlockingRecoveryOperation(owner: LispOwner): Promise<boolean> {
    return this.database(db => db.prepare(`SELECT 1 FROM dsh_lisp_operations WHERE session_id=?
      AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL') AND NOT (
        agent_id=? AND kind='lisp_eval' AND state='UNKNOWN'
        AND COALESCE(json_extract(result,'$.interruptedBeforeResult'),0)=1) LIMIT 1`).get(owner.sessionId, owner.agentId) !== undefined)
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
