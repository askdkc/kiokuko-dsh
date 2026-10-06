import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { canonicalEntryRevisionContentHash, type EntryKind, type JsonObject } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import { readEntry } from './entries.js'
import { readRevisionEvidence } from './evidence.js'
import { provenanceSourceHash, type RetiredSource } from './forgotten.js'

export interface ForgetInput { workspace: string; entryId: string; expectedRevision: number; operationId: string }
export interface ForgetResult { forgotten: true; entryId: string; count: number; scope: 'kiokuko_database'; nativeLogsErased: false }
interface Retirement { ids: Set<string>; reviewJobs: Set<string>; runs: Set<string>; sources: RetiredSource[] }
function references(value: unknown, ids: Set<string>): boolean {
  if (typeof value === 'string') return ids.has(value)
  if (Array.isArray(value)) return value.some(item => references(item, ids))
  return !!value && typeof value === 'object' && Object.values(value).some(item => references(item, ids))
}
/** Dependency manifests are authoritative even when a derived revision is historical. */
function dependentEntries(db: SqliteDatabase, entryId: string): Set<string> {
  const ids = new Set([entryId])
  const derived = [...db.prepare('SELECT entry_id,manifest_json FROM memory_index_facts').all<{entry_id: string; manifest_json: string}>(),
    ...db.prepare('SELECT entry_id,manifest_json FROM memory_derivations').all<{entry_id: string; manifest_json: string}>()]
  const projections = db.prepare('SELECT entry_id,global_entry_id FROM auto_global_projections').all<{entry_id: string; global_entry_id: string}>()
  const manual = db.prepare("SELECT entry_id,provenance_json FROM entry_revisions WHERE json_extract(provenance_json,'$.type')='curator_globalize'")
    .all<{entry_id: string; provenance_json: string}>()
  const links = db.prepare("SELECT from_entry_id,to_entry_id FROM entry_links WHERE relation='derived_from'").all<{from_entry_id: string; to_entry_id: string}>()
  let changed = true
  const add = (id: string) => { if (!ids.has(id)) { ids.add(id); changed = true } }
  while (changed) {
    changed = false
    for (const row of derived) if (references(JSON.parse(row.manifest_json), ids)) add(row.entry_id)
    for (const row of projections) if (ids.has(row.entry_id)) add(row.global_entry_id)
    for (const row of links) if (ids.has(row.to_entry_id)) add(row.from_entry_id)
    for (const row of manual) {
      const provenance = JSON.parse(row.provenance_json) as {reference?: string}
      if (provenance.reference && ids.has(provenance.reference.split('@')[0]!)) add(row.entry_id)
    }
  }
  return ids
}
function eraseEntry(db: SqliteDatabase, id: string, retirement: Retirement, now: string): void {
  const entry = db.prepare('SELECT workspace,current_revision FROM entries WHERE id=?').get<{workspace: string; current_revision: number}>(id)
  if (!entry) throw new KiokukoError('INTEGRITY_ERROR', 'Memory dependency points to missing entry')
  const revisions = db.prepare('SELECT revision,kind,content_hash,provenance_json FROM entry_revisions WHERE entry_id=?')
    .all<{revision: number; kind: EntryKind; content_hash: string; provenance_json: string}>(id)
  const sources: RetiredSource[] = []
  for (const revision of revisions) {
    const provenance = JSON.parse(revision.provenance_json) as JsonObject
    const hash = provenanceSourceHash(provenance)
    if (hash) sources.push({provenanceHash: hash})
    if (typeof provenance.runId === 'string') retirement.runs.add(provenance.runId)
    const evidence = readRevisionEvidence(db, id, revision.revision, entry.workspace)
    if (evidence) for (const source of evidence.claims.flatMap(claim => claim.sources)) sources.push({sessionId: source.sessionId, generation: source.sourceGeneration, hash: source.sourceHash})
  }
  for (const effect of db.prepare('SELECT job_id,run_id,session_id,source_generation,evidence_json FROM memory_review_effects WHERE entry_id=?')
    .all<{job_id: string; run_id: string; session_id: string; source_generation: string; evidence_json: string}>(id)) {
    retirement.reviewJobs.add(effect.job_id); retirement.runs.add(effect.run_id)
    for (const source of JSON.parse(effect.evidence_json) as {normalizedSourceHash: string}[]) sources.push({sessionId: effect.session_id, generation: effect.source_generation, hash: source.normalizedSourceHash})
  }
  for (const row of db.prepare('SELECT run_id FROM dsh_memory_finalization_entries WHERE entry_id=?').all<{run_id: string}>(id)) retirement.runs.add(row.run_id)
  retirement.sources.push(...sources)
  db.prepare('INSERT OR IGNORE INTO memory_forget_tombstones VALUES(?,?,?,?,?,?)')
    .run(id, entry.workspace, entry.current_revision, JSON.stringify(revisions.map(row => row.content_hash)), JSON.stringify(sources), now)
  for (const revision of revisions) {
    const provenance = {type: 'forgotten', reference: `${id}:${revision.revision}`}
    const hash = canonicalEntryRevisionContentHash({kind: revision.kind, title: '[forgotten]', body: '[forgotten]', summary: null, scope: {}, provenance, tags: []})
    db.prepare("UPDATE entry_revisions SET title='[forgotten]',body='[forgotten]',summary=NULL,scope_json='{}',provenance_json=?,content_hash=? WHERE entry_id=? AND revision=?")
      .run(JSON.stringify(provenance), hash, id, revision.revision)
  }
  // Identity shells retain foreign keys and payload-free audit/usage records.
  db.prepare("UPDATE entries SET status='superseded',superseded_by=id,trust_level='untrusted',verified_at=NULL WHERE id=?").run(id)
  for (const table of ['memory_revision_evidence', 'entry_revision_tags', 'entry_search_documents', 'entry_search_signals', 'entry_embeddings', 'embedding_jobs', 'memory_index_sources', 'memory_index_facts', 'memory_derivations']) db.prepare(`DELETE FROM ${table} WHERE entry_id=?`).run(id)
  db.prepare("UPDATE auto_global_queue SET state='held',reason='memory_forgotten' WHERE entry_id=?").run(id)
  db.prepare("UPDATE auto_global_projections SET state='quarantined',reason='memory_forgotten' WHERE entry_id=? OR global_entry_id=?").run(id, id)
  db.prepare("UPDATE audit_events SET details_json='{}' WHERE entry_id=?").run(id)
  db.prepare('UPDATE context_feedback SET comment=NULL WHERE entry_id=?').run(id)
  db.prepare('INSERT OR IGNORE INTO memory_forget_deliveries SELECT delivery_id FROM context_delivery_entries WHERE entry_id=?').run(id)
  for (const binding of db.prepare('SELECT run_id,required_json FROM task_memory_bindings').all<{run_id: string; required_json: string}>()) {
    if (!references(JSON.parse(binding.required_json), new Set([id]))) continue
    db.prepare("UPDATE task_memory_executions SET outcome='stale' WHERE run_id=?").run(binding.run_id)
    const required = (JSON.parse(binding.required_json) as {entryId: string}[]).filter(item => item.entryId !== id)
    db.prepare('UPDATE task_memory_bindings SET epoch=epoch+1,required_json=? WHERE run_id=?').run(JSON.stringify(required), binding.run_id)
  }
  db.prepare('DELETE FROM task_memory_reviews WHERE entry_id=?').run(id)
  db.prepare('DELETE FROM context_delivery_entries WHERE entry_id=?').run(id)
  db.prepare('DELETE FROM context_delivery_omissions WHERE entry_id=?').run(id)
}
function eraseJobs(db: SqliteDatabase, retirement: Retirement): void {
  for (const [kind, table, columns] of [
    ['review', 'memory_review_jobs', ['input_json', 'result_json']],
    ['index', 'memory_index_jobs', ['input_json', 'peers_json', 'drafts_json', 'verdicts_json']],
    ['evolution', 'memory_evolution_jobs', ['input_json']],
  ] as const) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()) {
      const snapshotReferences = columns.some(column => typeof row[column] === 'string' && references(JSON.parse(row[column] as string), retirement.ids))
      const retiredReviewSource = kind === 'review' && retirement.sources.some(source => source.sessionId === row.session_id && source.hash &&
        typeof row.input_json === 'string' && references(JSON.parse(row.input_json), new Set([source.hash])))
      if (!snapshotReferences && !retiredReviewSource && !(kind === 'review' && retirement.reviewJobs.has(String(row.id)))) continue
      db.prepare('INSERT OR IGNORE INTO memory_forget_jobs VALUES(?,?)').run(kind, String(row.id))
      const scrub = kind === 'review' ? "state='cancelled',reason='memory_forgotten',owner_nonce=NULL,input_json='{}',result_json=NULL"
        : kind === 'index' ? "state='held',reason='memory_forgotten',claim_token=NULL,input_json='{}',peers_json='[]',peers_digest=NULL,drafts_json='[]',verdicts_json=NULL"
        : "state='held',reason='memory_forgotten',claim_token=NULL,input_json='[]',seen_json='[]'"
      db.prepare(`UPDATE ${table} SET ${scrub} WHERE id=?`).run(String(row.id))
    }
  }
  for (const row of db.prepare('SELECT run_id,episode_json FROM memory_episodes').all<{run_id: string; episode_json: string}>()) {
    if (references(JSON.parse(row.episode_json), retirement.ids)) db.prepare('DELETE FROM memory_episodes WHERE run_id=?').run(row.run_id)
  }
  for (const runId of retirement.runs) {
    db.prepare("UPDATE dsh_memory_finalizations SET status='failed',claim_nonce=NULL,lease_until=NULL,last_error_code='MEMORY_FORGOTTEN',last_error_message=NULL WHERE run_id=?").run(runId)
    db.prepare("UPDATE memory_review_states SET lease_nonce=NULL,lease_until=NULL,reason='memory_forgotten' WHERE run_id=?").run(runId)
    db.prepare("UPDATE dsh_deep_finalizations SET source_json='{}',status='skipped',process_id=NULL,lease_until=NULL,error='memory_forgotten' WHERE run_id=?").run(runId)
  }
}
/** One atomic erasure; callbacks holding old snapshots lose their claims before commit. */
export function forgetMemory(db: SqliteDatabase, input: ForgetInput): ForgetResult {
  if (!input.operationId || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new KiokukoError('VALIDATION_ERROR', 'Invalid forget identity')
  return withImmediateTransaction(db, () => {
    const receipt = db.prepare('SELECT * FROM memory_forget_receipts WHERE operation_id=?')
      .get<{workspace: string; entry_id: string; expected_revision: number; result_json: string}>(input.operationId)
    if (receipt) {
      if (receipt.workspace !== input.workspace || receipt.entry_id !== input.entryId || receipt.expected_revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Forget operation identity changed')
      return JSON.parse(receipt.result_json) as ForgetResult
    }
    const tombstone=db.prepare('SELECT workspace,revision FROM memory_forget_tombstones WHERE entry_id=?').get<{workspace:string;revision:number}>(input.entryId)
    if(tombstone){
      if(tombstone.workspace!==input.workspace)throw new KiokukoError('NOT_FOUND','Memory not found')
      if(tombstone.revision!==input.expectedRevision)throw new KiokukoError('CONFLICT','Memory revision changed')
      const original=db.prepare('SELECT result_json FROM memory_forget_receipts WHERE workspace=? AND entry_id=? AND expected_revision=? ORDER BY rowid LIMIT 1').get<{result_json:string}>(input.workspace,input.entryId,input.expectedRevision)
      const result:ForgetResult=original?JSON.parse(original.result_json):{forgotten:true,entryId:input.entryId,count:0,scope:'kiokuko_database',nativeLogsErased:false}
      db.prepare('INSERT INTO memory_forget_receipts VALUES(?,?,?,?,?)').run(input.operationId,input.workspace,input.entryId,input.expectedRevision,JSON.stringify(result))
      return result
    }
    const entry = readEntry(db, {workspace: input.workspace, entryId: input.entryId})
    if (entry.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Memory revision changed')
    const retirement: Retirement = {ids: dependentEntries(db, entry.id), reviewJobs: new Set(), runs: new Set(), sources: []}
    for (const id of retirement.ids) eraseEntry(db, id, retirement, new Date().toISOString())
    eraseJobs(db, retirement)
    const result: ForgetResult = {forgotten: true, entryId: entry.id, count: retirement.ids.size, scope: 'kiokuko_database', nativeLogsErased: false}
    db.prepare('INSERT INTO memory_forget_receipts VALUES(?,?,?,?,?)').run(input.operationId, input.workspace, input.entryId, input.expectedRevision, JSON.stringify(result))
    return result
  })
}
