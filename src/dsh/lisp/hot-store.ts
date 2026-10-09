import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SqliteDatabase } from '../../db/adapter.js'
import { digest, fail, type LispOwner } from './contracts.js'
import { HotName, boundedJson, parseHotBundle, parseHotContract, type Bundle, type HotContract } from './hot-contracts.js'
import type { LispStore } from './store.js'

interface Head extends Record<string, unknown> { name: string; revision: number; contract_ref: string; bundle_ref: string | null; updated_at: string }
interface Saved extends Record<string, unknown> { name: string; digest: string; payload: string }
interface Version extends Saved { contract_ref: string }
export interface HotHead { name: string; revision: number; contractRef: string; bundleRef: string | null; activeContractRef: string | null; updatedAt: string }

function head(db: SqliteDatabase, project: string, name: string): Head | undefined {
  return db.prepare('SELECT * FROM dsh_lisp_hot_heads WHERE project_root=? AND name=?').get<Head>(project, name)
}
function loadContract(db: SqliteDatabase, project: string, ref: string, name?: string): HotContract & { contractRef: string } {
  const row = db.prepare('SELECT * FROM dsh_lisp_hot_contracts WHERE project_root=? AND contract_ref=?').get<Saved>(project, z.uuid().parse(ref))
  if (!row || (name !== undefined && row.name !== name)) fail('HOT_CONTRACT_MISSING', 'このプロジェクトの承認済み条件がありません。')
  const contract = parseHotContract(JSON.parse(row.payload))
  if (contract.name !== row.name || digest({ project, contract }) !== row.digest) fail('HOT_INTEGRITY', '保存された条件が変化しています。')
  return { ...contract, contractRef: ref }
}
function quota(db: SqliteDatabase, project: string, extraBytes: number): void {
  const sql = `SELECT project_root,length(CAST(payload AS BLOB)) AS bytes FROM dsh_lisp_hot_contracts
    UNION ALL SELECT project_root,length(CAST(payload AS BLOB)) AS bytes FROM dsh_lisp_hot_versions`
  const local = db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM (${sql}) WHERE project_root=?`).get<{ count: number; bytes: number }>(project)!
  const total = db.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes FROM (${sql})`).get<{ bytes: number }>()!
  if (local.count >= 10000 || local.bytes + extraBytes > 1024 ** 3 || total.bytes + extraBytes > 4 * 1024 ** 3)
    fail('HOT_CATALOG_LIMIT', '共有コードの保存上限です。稼働版を消さずに新しい登録を停止します。')
}
function authority(db: SqliteDatabase, owner: LispOwner, epoch: string, operationId: string, kind: string, project: string): { payload: Record<string, unknown>; result: Record<string, unknown> } {
  const session = db.prepare('SELECT enabled,root_path,epoch FROM dsh_lisp_sessions WHERE session_id=?')
    .get<{ enabled: number; root_path: string; epoch: string }>(owner.sessionId)
  if (!session?.enabled || session.root_path !== owner.root || session.epoch !== epoch) fail('HOT_SCOPE', 'セッションの権限または世代が変わりました。')
  const operation = db.prepare('SELECT kind,state,generation,payload,result FROM dsh_lisp_operations WHERE session_id=? AND agent_id=? AND operation_id=?')
    .get<{ kind: string; state: string; generation: string; payload: string; result: string | null }>(owner.sessionId, owner.agentId, operationId)
  const state = kind === 'lisp_hot_install' || kind === 'lisp_hot_call' ? 'RUNNING' : 'AWAITING_APPROVAL'
  if (!operation || operation.kind !== kind || operation.state !== state || operation.generation !== epoch
    || (JSON.parse(operation.payload) as { projectRoot?: string }).projectRoot !== project)
    fail('STATE_CONFLICT', '有効な操作記録がありません。')
  return { payload: JSON.parse(operation.payload) as Record<string, unknown>, result: JSON.parse(operation.result ?? '{}') as Record<string, unknown> }
}
function receipt(db: SqliteDatabase, owner: LispOwner, operationId: string, value: unknown, maxBytes = 8192): void {
  const encoded = boundedJson(value, maxBytes)
  const size = 'length(CAST(payload AS BLOB))+COALESCE(length(CAST(result AS BLOB)),0)'
  const local = db.prepare(`SELECT COALESCE(SUM(${size}),0) AS bytes FROM dsh_lisp_operations WHERE session_id=?`).get<{ bytes: number }>(owner.sessionId)!.bytes
  const total = db.prepare(`SELECT COALESCE(SUM(${size}),0) AS bytes FROM dsh_lisp_operations`).get<{ bytes: number }>()!.bytes
  if (local + Buffer.byteLength(encoded) > 1024 ** 3 || total + Buffer.byteLength(encoded) > 4 * 1024 ** 3) fail('JOURNAL_LIMIT', '操作結果を安全に保存できる容量がありません。')
  db.prepare("UPDATE dsh_lisp_operations SET state='SUCCEEDED',result=?,updated_at=? WHERE session_id=? AND agent_id=? AND operation_id=?")
    .run(encoded, new Date().toISOString(), owner.sessionId, owner.agentId, operationId)
}
function transaction<T>(db: SqliteDatabase, perform: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = perform(); db.exec('COMMIT'); return result }
  catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve the COMMIT error; caller reads its durable receipt. */ } throw error }
}

/** Host-only catalog: project code never grants access to another session's journal. */
export class HotToolStore {
  constructor(private readonly store: LispStore) {}
  status(project: string, name?: string, offset = 0): Promise<HotHead[]> {
    if (name !== undefined) HotName.parse(name)
    return this.store.database(db => db.prepare(`SELECT h.*,v.contract_ref AS active_contract_ref FROM dsh_lisp_hot_heads h
      LEFT JOIN dsh_lisp_hot_versions v ON v.bundle_ref=h.bundle_ref AND v.project_root=h.project_root
      WHERE h.project_root=?${name === undefined ? '' : ' AND h.name=?'} ORDER BY h.name LIMIT 11 OFFSET ?`)
      .all<Head & { active_contract_ref: string | null }>(project, ...(name === undefined ? [] : [name]), offset)
      .map(row => ({ name: row.name, revision: row.revision, contractRef: row.contract_ref, bundleRef: row.bundle_ref,
        activeContractRef: row.active_contract_ref, updatedAt: row.updated_at })))
  }
  contract(project: string, ref: string, name?: string) { return this.store.database(db => loadContract(db, project, ref, name)) }
  active(project: string, name: string): Promise<{ bundleRef: string; revision: number; contractRef: string; bundle: Bundle }> {
    HotName.parse(name)
    return this.store.database(db => {
      const selected = head(db, project, name)
      if (!selected?.bundle_ref) fail('HOT_NOT_ACTIVE', 'このプロジェクトに有効な共有関数がありません。')
      const row = db.prepare('SELECT * FROM dsh_lisp_hot_versions WHERE project_root=? AND bundle_ref=?').get<Version>(project, selected.bundle_ref)
      if (!row) fail('HOT_INTEGRITY', '稼働版のコードがありません。')
      const bundle = parseHotBundle(JSON.parse(row.payload))
      const contract = loadContract(db, project, row.contract_ref, name)
      if (row.name !== name || bundle.name !== name || bundle.contractRef !== row.contract_ref
        || digest({ project, bundle }) !== row.digest || digest(bundle.inputSchema) !== digest(contract.inputSchema)
        || digest(bundle.outputSchema) !== digest(contract.outputSchema)) fail('HOT_INTEGRITY', '稼働版の内容が変化しています。')
      return { bundleRef: selected.bundle_ref, revision: selected.revision, contractRef: row.contract_ref, bundle }
    })
  }
  approve(owner: LispOwner, epoch: string, project: string, id: string, value: HotContract) {
    const contract = parseHotContract(value), payload = boundedJson(contract, 65536)
    return this.store.database(db => transaction(db, () => {
      const operation = authority(db, owner, epoch, id, 'lisp_hot_contract', project)
      if (digest(operation.payload.request) !== digest(contract)) fail('STATE_CONFLICT', '確認画面の条件と保存対象が一致しません。')
      const old = head(db, project, contract.name)
      if ((old?.contract_ref ?? null) !== contract.expectedContractRef) fail('HOT_CONTRACT_CONFLICT', '承認中に検証条件が更新されました。')
      quota(db, project, Buffer.byteLength(payload))
      const ref = randomUUID(), now = new Date().toISOString()
      db.prepare('INSERT INTO dsh_lisp_hot_contracts VALUES(?,?,?,?,?,?,?,?)')
        .run(ref, project, contract.name, digest({ project, contract }), payload, owner.sessionId, owner.agentId, now)
      db.prepare(`INSERT INTO dsh_lisp_hot_heads VALUES(?,?,0,?,NULL,?) ON CONFLICT(project_root,name)
        DO UPDATE SET contract_ref=excluded.contract_ref,updated_at=excluded.updated_at`).run(project, contract.name, ref, now)
      const result = { ok: true, operationId: id, projectRoot: project, name: contract.name, contractRef: ref, revision: old?.revision ?? 0, approval: operation.payload.approval ?? 'manual' }
      receipt(db, owner, id, result); return result
    }))
  }
  activate(owner: LispOwner, epoch: string, project: string, id: string,
    request: { name: string; contractRef: string; expectedRevision: number; bundle: Bundle }) {
    const bundle = parseHotBundle(request.bundle), payload = boundedJson(bundle, 1048576)
    return this.store.database(db => transaction(db, () => {
      const operation = authority(db, owner, epoch, id, 'lisp_hot_install', project)
      if (operation.payload.name !== request.name || operation.payload.contractRef !== request.contractRef
        || operation.payload.expectedRevision !== request.expectedRevision || operation.payload.sourceDigest !== digest(bundle.source))
        fail('STATE_CONFLICT', '検証対象と公開対象が一致しません。')
      const old = head(db, project, request.name)
      if (!old || old.contract_ref !== request.contractRef) fail('HOT_CONTRACT_CONFLICT', '検証中に承認条件が変わりました。')
      if (old.revision !== request.expectedRevision || !Number.isSafeInteger(old.revision + 1)) fail('HOT_REVISION_CONFLICT', '検証中に稼働版が変わりました。')
      const contract = loadContract(db, project, request.contractRef, request.name)
      if (operation.result.phase !== 'checking' || operation.result.checked !== contract.properties.length || operation.result.total !== contract.properties.length)
        fail('STATE_CONFLICT', 'すべての検証条件の成功記録が必要です。')
      if (bundle.name !== request.name || bundle.contractRef !== request.contractRef
        || digest(bundle.inputSchema) !== digest(contract.inputSchema) || digest(bundle.outputSchema) !== digest(contract.outputSchema))
        fail('HOT_CONTRACT_CONFLICT', '検証したコードと承認条件が一致しません。')
      quota(db, project, Buffer.byteLength(payload))
      const ref = randomUUID(), now = new Date().toISOString(), revision = old.revision + 1
      db.prepare('INSERT INTO dsh_lisp_hot_versions VALUES(?,?,?,?,?,?,?)')
        .run(ref, project, request.name, request.contractRef, digest({ project, bundle }), payload, now)
      db.prepare('UPDATE dsh_lisp_hot_heads SET bundle_ref=?,revision=?,updated_at=? WHERE project_root=? AND name=?')
        .run(ref, revision, now, project, request.name)
      const result = { ok: true, operationId: id, projectRoot: project, name: request.name, contractRef: request.contractRef,
        bundleRef: ref, revision, checked: contract.properties.length }
      receipt(db, owner, id, result); return result
    }))
  }
  deactivate(owner: LispOwner, epoch: string, project: string, id: string, request: { name: string; expectedRevision: number }) {
    return this.store.database(db => transaction(db, () => {
      const operation = authority(db, owner, epoch, id, 'lisp_hot_deactivate', project)
      if (operation.payload.name !== request.name || operation.payload.expectedRevision !== request.expectedRevision)
        fail('STATE_CONFLICT', '確認画面の対象と無効化対象が一致しません。')
      const old = head(db, project, request.name)
      if (!old?.bundle_ref) fail('HOT_NOT_ACTIVE', '稼働版がありません。')
      if (old.revision !== request.expectedRevision || !Number.isSafeInteger(old.revision + 1)) fail('HOT_REVISION_CONFLICT', '承認中に稼働版が変わりました。')
      const revision = old.revision + 1
      db.prepare('UPDATE dsh_lisp_hot_heads SET bundle_ref=NULL,revision=?,updated_at=? WHERE project_root=? AND name=?')
        .run(revision, new Date().toISOString(), project, request.name)
      const result = { ok: true, operationId: id, projectRoot: project, name: request.name, revision, bundleRef: null, contractRef: old.contract_ref, approval: operation.payload.approval ?? 'manual' }
      receipt(db, owner, id, result); return result
    }))
  }
  /** A call's private result and replay receipt are one commit, including quota failures. */
  completeCall(owner: LispOwner, epoch: string, project: string, id: string, ref: string,
    payload: { operationId: string; bundleRef: string; sourceRefs: string[] }, value: unknown, response: unknown): Promise<void> {
    const resultJson = boundedJson({ value }, 64 * 1024 * 1024), payloadJson = boundedJson(payload, 1024 * 1024)
    return this.store.database(db => transaction(db, () => {
      const operation = authority(db, owner, epoch, id, 'lisp_hot_call', project)
      if (payload.operationId !== id || payload.bundleRef !== operation.payload.bundleRef) fail('STATE_CONFLICT', '呼び出し結果の版が一致しません。')
      const usage = db.prepare('SELECT COUNT(*) AS count FROM dsh_lisp_operations WHERE session_id=?').get<{ count: number }>(owner.sessionId)!
      if (usage.count >= 10000) fail('JOURNAL_LIMIT', 'Lisp 記録の件数上限です。')
      db.prepare('INSERT INTO dsh_lisp_operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(owner.sessionId, owner.agentId, z.uuid().parse(ref),
        'task_result', digest(value), epoch, 'SUCCEEDED', payloadJson, resultJson, new Date().toISOString())
      receipt(db, owner, id, response, 64 * 1024 * 1024)
    }))
  }
  expire(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString()
    return this.store.database(db => transaction(db, () => {
      db.prepare(`DELETE FROM dsh_lisp_hot_versions WHERE created_at<?
        AND bundle_ref NOT IN (SELECT bundle_ref FROM dsh_lisp_hot_heads WHERE bundle_ref IS NOT NULL)
        AND bundle_ref NOT IN (SELECT json_extract(payload,'$.bundleRef') FROM dsh_lisp_operations
          WHERE kind='lisp_hot_call' AND state IN ('RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL')
          AND json_extract(payload,'$.bundleRef') IS NOT NULL)`).run(cutoff)
      db.prepare(`DELETE FROM dsh_lisp_hot_contracts WHERE created_at<?
        AND contract_ref NOT IN (SELECT contract_ref FROM dsh_lisp_hot_heads)
        AND contract_ref NOT IN (SELECT contract_ref FROM dsh_lisp_hot_versions)
        AND contract_ref NOT IN (SELECT json_extract(payload,'$.contractRef') FROM dsh_lisp_operations
          WHERE kind='lisp_hot_install' AND state IN ('RUNNING','UNKNOWN','AWAITING_APPROVAL') AND json_extract(payload,'$.contractRef') IS NOT NULL)
        AND contract_ref NOT IN (SELECT json_extract(payload,'$.request.expectedContractRef') FROM dsh_lisp_operations
          WHERE kind='lisp_hot_contract' AND state IN ('RUNNING','UNKNOWN','AWAITING_APPROVAL') AND json_extract(payload,'$.request.expectedContractRef') IS NOT NULL)`).run(cutoff)
    }))
  }
}
