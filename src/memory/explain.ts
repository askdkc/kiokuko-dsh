import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import { readEntry } from './entries.js'
import { readEntryRevision } from './revisions.js'
import { isRetrievableEntry } from './hybrid-retrieval.js'
import { readRevisionEvidence } from './evidence.js'
import { readIndexManifest, indexFactEligible } from './index-reasoning/store.js'
import { evolutionEntryState } from './evolution/store.js'
import { autoGlobalProjectionActive } from './auto-globalization.js'
import type { Episode } from './evolution/contracts.js'

interface Reference { entryId: string; revision: number; workspace: string }
function derivation(db: SqliteDatabase, ref: Reference) {
  const index = readIndexManifest(db, { id: ref.entryId, ...ref })
  if (index) return { kind: 'index', manifest: index, sources: index.sources.map(source => ({ entryId: source.entryId, revision: source.revision, workspace: ref.workspace })) }
  const row = db.prepare('SELECT manifest_json,input_digest,algorithm,kind FROM memory_derivations WHERE entry_id=? AND revision=? AND workspace=?')
    .get<{ manifest_json: string; input_digest: string; algorithm: string; kind: string }>(ref.entryId, ref.revision, ref.workspace)
  if (!row) {
    const revision = readEntryRevision(db, ref)
    const provenance = revision.provenance
    if (!['auto_curator_globalize','curator_globalize'].includes(String(provenance.type))) return null
    const mapping = db.prepare('SELECT entry_id,entry_revision,source_content_hash,evidence_digest FROM auto_global_projections WHERE global_entry_id=?')
      .get<{entry_id:string;entry_revision:number;source_content_hash:string;evidence_digest:string}>(ref.entryId)
    const reference = typeof provenance.reference === 'string' ? /^(.+)@([1-9]\d*)#.+$/u.exec(provenance.reference) : null
    const source = mapping ? {entryId:mapping.entry_id,revision:mapping.entry_revision,contentHash:mapping.source_content_hash}
      : reference ? {entryId:reference[1]!,revision:Number(reference[2])} : null
    // Projection lineage identifies the source; it does not grant access to its workspace.
    return {kind:'global',manifest:{source,workspace:provenance.sourceWorkspace??null,
      evidenceDigest:mapping?.evidence_digest??null,sourceEvidence:'requires_source_workspace_access'},sources:[]}
  }
  const manifest = JSON.parse(row.manifest_json) as Episode[]
  if (!Array.isArray(manifest) || canonicalContentHash({version: row.algorithm, kind: row.kind, episodes: manifest}) !== row.input_digest) throw new KiokukoError('INTEGRITY_ERROR', 'Memory derivation digest mismatch')
  return { kind: 'evolution', manifest, sources: manifest.flatMap(episode => episode.sources.map(source => ({ entryId: source.entryId, revision: source.revision, workspace: ref.workspace }))) }
}
function claims(db: SqliteDatabase, ref: Reference) {
  const evidence = readRevisionEvidence(db, ref.entryId, ref.revision, ref.workspace)
  return { evidenceStatus: evidence ? 'source_attached' as const : 'details_unavailable' as const,
    source: evidence ? { sessionId: evidence.sessionId, sourceGeneration: evidence.sourceGeneration } : null,
    claims: evidence?.claims.map(claim => ({ ...claim, identity: {entryId: ref.entryId, revision: ref.revision, claimId: claim.id},
      ...(claim.supersedes ? { supersedes: {entryId: ref.entryId, ...claim.supersedes} } : {}) })) ?? [] }
}
/** Follow only registered source manifests, with a bounded, cycle-safe traversal. */
function lineage(db: SqliteDatabase, root: Reference) {
  const visited = new Set<string>([`${root.entryId}:${root.revision}`])
  const pending = derivation(db, root)?.sources ?? []
  const result: Array<Reference & ReturnType<typeof claims>> = []
  let truncated = false
  while (pending.length) {
    const ref = pending.shift()!, key = `${ref.entryId}:${ref.revision}`
    if (visited.has(key)) continue
    visited.add(key)
    if (result.length >= 64) { truncated = true; break }
    // A manifest never grants access to another workspace.
    if (ref.workspace !== root.workspace) throw new KiokukoError('INTEGRITY_ERROR', 'Memory lineage crosses workspace')
    readEntryRevision(db, ref)
    result.push({ ...ref, ...claims(db, ref) })
    pending.push(...(derivation(db, ref)?.sources ?? []))
  }
  return { sources: result, truncated }
}
/** Host-authorized read. Optional run IDs are supplied by the host, never tool input. */
export function explainMemory(db: SqliteDatabase, input: { workspace: string; entryId: string; revision?: number | undefined; runId?: string | undefined }) {
  let workspace = input.workspace
  let retrieval: {selection_reason_json: string; rank: number} | undefined
  if (input.runId) {
    const binding = db.prepare('SELECT delivery_id FROM task_memory_bindings WHERE run_id=? AND workspace=?').get<{delivery_id: string | null}>(input.runId, workspace)
    if (!binding) throw new KiokukoError('NOT_FOUND', 'Memory request binding unavailable')
    if (binding.delivery_id) {
      const delivered = db.prepare('SELECT e.workspace,d.selection_reason_json,d.rank FROM context_delivery_entries d JOIN entries e ON e.id=d.entry_id WHERE d.delivery_id=? AND d.entry_id=?')
        .get<{workspace: string; selection_reason_json: string; rank: number}>(binding.delivery_id, input.entryId)
      if (delivered) { workspace = delivered.workspace; retrieval = delivered }
    }
  }
  const current = readEntry(db, {workspace, entryId: input.entryId})
  const revision = input.revision ?? current.revision
  const ref = {entryId: current.id, revision, workspace}
  const value = readEntryRevision(db, ref)
  const derived = derivation(db, ref)
  const eligible = revision === current.revision && current.status !== 'superseded' && isRetrievableEntry(db, current)
  const reason = eligible ? null : revision !== current.revision ? 'historical_revision' : current.status === 'superseded' ? 'superseded'
    : !indexFactEligible(db, current) ? 'index_sources_or_settings_ineligible'
    : !autoGlobalProjectionActive(db, current) ? 'global_projection_ineligible'
    : !evolutionEntryState(db, current).eligible ? 'evolution_sources_feedback_or_settings_ineligible' : 'source_or_policy_ineligible'
  const history = db.prepare('SELECT revision,content_hash FROM entry_revisions WHERE entry_id=? AND workspace=? ORDER BY revision')
    .all<{revision: number; content_hash: string}>(current.id, workspace).map(row => ({revision: row.revision, contentHash: row.content_hash,
      ...claims(db, {...ref, revision: row.revision})}))
  return {entryId: current.id, revision, currentRevision: current.revision, title: value.title, body: value.body,
    scope: value.scope, trust: current.trustLevel, status: current.status, ...claims(db, ref), history,
    derivation: derived ? {kind: derived.kind, manifest: derived.manifest} : null, lineage: lineage(db, ref), eligible, reason,
    retrieval: retrieval ? {selectionReasons: JSON.parse(retrieval.selection_reason_json) as string[], rank: retrieval.rank, scoreMeaning: 'retrieval_rank_not_truth_probability'} : null,
    semanticVerification: 'not_proven'}
}

export function renderMemoryExplanation(value: ReturnType<typeof explainMemory>): string {
  const lines = [`${value.entryId}@${value.revision}: ${value.title}`, value.body,
    `適用条件: ${JSON.stringify(value.scope)}`, `trust: ${value.trust} / 利用: ${value.eligible ? '可能' : value.reason}`,
    value.evidenceStatus === 'source_attached' ? '出典を確認済み。内容の正しさを証明するものではありません。' : '詳細な根拠なし。']
  for (const claim of value.claims) {
    lines.push(`主張 ${claim.id}: ${claim.text}`)
    if (claim.supersedes) lines.push(`訂正対象: ${value.entryId}@${claim.supersedes.revision}/${claim.supersedes.claimId}`)
    for (const source of claim.sources) lines.push(`  ${source.evidenceId} (${source.kind}, seq ${source.sourceSeqs.join(',')}): ${source.supportingText}`)
  }
  lines.push(`履歴: ${value.history.map(row => `${value.entryId}@${row.revision}`).join(', ')}`)
  if (value.derivation) lines.push(`派生元: ${value.derivation.kind === 'global' ? JSON.stringify(value.derivation.manifest) : value.lineage.sources.map(source => `${source.entryId}@${source.revision}`).join(', ')}`)
  if (value.retrieval) lines.push(`取得理由: ${value.retrieval.selectionReasons.join(', ')} (順位 ${value.retrieval.rank})`)
  return lines.join('\n')
}
