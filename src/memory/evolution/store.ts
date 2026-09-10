import type { SqliteDatabase } from '../../db/adapter.js'
import { recordEntryInTransaction, readEntry, updateCandidateEntryInTransaction, type EntryRecord } from '../entries.js'
import { buildStructuredScope } from '../structured-memory.js'
import { canonicalJson, type JsonObject } from '../../serialization/validate.js'
import { KiokukoError } from '../../errors.js'
import { digest, evidenceReferences, type EpisodeEvidence, supportingEvidenceDigest, episodeSignature, episodeSignals, parseEpisodeDraft, EVOLUTION_VERSION, eligibleAvoidance, independentEpisodes, inductionKind, type Episode, type EvolutionMode, type LessonDraft } from './contracts.js'

export function evolutionInstalled(db: SqliteDatabase): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_episodes'").get()
}
export function configureEvolution(db: SqliteDatabase, requested: EvolutionMode): void {
  db.prepare(`UPDATE memory_evolution_settings SET mode=?, requested_mode=?, generation=generation+1
    WHERE singleton=1 AND (mode<>? OR requested_mode<>?)`).run(requested, requested, requested, requested)
}
export function evolutionSettings(db: SqliteDatabase): { mode: EvolutionMode; requested: EvolutionMode; generation: number } {
  return db.prepare('SELECT mode, requested_mode AS requested, generation FROM memory_evolution_settings WHERE singleton=1')
    .get<{ mode: EvolutionMode; requested: EvolutionMode; generation: number }>()!
}
function adverseFeedback(db: SqliteDatabase, id: string, revision: number): boolean {
  return !!db.prepare(`SELECT 1 FROM context_feedback f JOIN context_delivery_entries d
    ON d.delivery_id=f.delivery_id AND d.entry_id=f.entry_id
    WHERE f.entry_id=? AND d.entry_revision=? AND f.verdict IN ('stale','conflicting') LIMIT 1`).get(id, revision)
}
export function episodeCurrent(db: SqliteDatabase, episode: Episode): boolean {
  const row = db.prepare(`SELECT e.episode_json,e.overview_entry_id, r.status, r.workspace FROM memory_episodes e
    JOIN ledger_runs r ON r.run_id=e.run_id WHERE e.run_id=?`).get<{ episode_json: string; overview_entry_id: string | null; status: string; workspace: string }>(episode.runId)
  if (!row || row.workspace !== episode.workspace || row.status !== episode.outcome || digest(JSON.parse(row.episode_json)) !== digest(episode)) return false
  const overview = db.prepare('SELECT status,current_revision FROM entries WHERE id=?').get<{status:string;current_revision:number}>(row.overview_entry_id)
  if (!overview || overview.status === 'superseded' || overview.current_revision !== 1 || adverseFeedback(db, row.overview_entry_id!, 1)) return false
  return episode.sources.every(source => {
    const entry = db.prepare(`SELECT e.workspace, e.status, e.current_revision AS revision, r.content_hash AS hash
      FROM entries e JOIN entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision WHERE e.id=?`)
      .get<{ workspace: string; status: string; revision: number; hash: string }>(source.entryId)
    return !!entry && entry.workspace === episode.workspace && entry.status !== 'superseded' &&
      entry.revision === source.revision && entry.hash === source.hash && !adverseFeedback(db, source.entryId, source.revision)
  })
}

export function evolutionEntryState(db: SqliteDatabase, entry: Pick<EntryRecord, 'id' | 'revision' | 'workspace' | 'provenance'>): { eligible: boolean; snapshot: unknown } {
  if (!evolutionInstalled(db)) return { eligible: entry.provenance.type !== 'memory-evolution', snapshot: null }
  const rows = db.prepare(`SELECT * FROM memory_derivations WHERE entry_id=? AND revision=?`)
    .all<{ manifest_json: string; state: string; workspace: string; kind: string; algorithm: string; input_digest: string }>(entry.id, entry.revision)
  if (!rows.length) {
    const managed = !!db.prepare('SELECT 1 FROM memory_derivations WHERE entry_id=? LIMIT 1').get(entry.id)
    return { eligible: !managed && entry.provenance.type !== 'memory-evolution', snapshot: managed ? { missingRevision: entry.revision } : null }
  }
  const row = rows[0]!
  const manifest = JSON.parse(row.manifest_json) as Episode[]
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > 6) throw new KiokukoError('INTEGRITY_ERROR', 'Invalid evolution manifest')
  if (digest({version:row.algorithm,kind:row.kind,episodes:manifest}) !== row.input_digest) throw new KiokukoError('INTEGRITY_ERROR', 'Evolution manifest digest does not match')
  const settings = evolutionSettings(db)
  const current = manifest.every(e => e.workspace === entry.workspace && episodeCurrent(db, e))
  const adverse = adverseFeedback(db, entry.id, entry.revision)
  return { eligible: settings.mode === 'active' && row.state === 'ready' && row.workspace === entry.workspace && current && !adverse,
    snapshot: { row, settings, current, adverse } }
}

function recordDerived(db: SqliteDatabase, input: {
  episodes: Episode[]; kind: 'episode' | 'positive' | 'avoidance'; title: string; body: string; now: string
}): EntryRecord {
  const episode = input.episodes[0]!
  const manifest = canonicalJson(input.episodes)
  const inputDigest = digest({ version: EVOLUTION_VERSION, kind: input.kind, episodes: input.episodes })
  const duplicate = db.prepare(`SELECT e.id FROM memory_derivations d JOIN entries e ON e.id=d.entry_id AND e.current_revision=d.revision
    WHERE d.workspace=? AND d.input_digest=? AND d.kind=?`).get<{ id: string }>(episode.workspace, inputDigest, input.kind)
  if (duplicate) {
    const existing = readEntry(db, { workspace: episode.workspace, entryId: duplicate.id })
    if (existing.body !== input.body) throw new Error('derived_replay_conflict')
    return existing
  }
  const scope = buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only',
    memoryClass: input.kind === 'avoidance' ? 'gotcha' : input.kind === 'episode' ? 'reference' : 'workflow',
    signals: { errors: [episode.draft.anchors.error], packages: [episode.draft.anchors.tool] },
  })
  const provenance: JsonObject = { type: 'memory-evolution', reference: `evolution:${inputDigest}`, sourceWorkspace: episode.workspace,
    runId: episode.runId, timestamp: input.now }
  const data = { workspace: episode.workspace, kind: input.kind === 'episode' ? 'reference' as const : 'lesson' as const,
    title: input.title.slice(0, 200), body: input.body, summary: input.body.slice(0, 2000), scope, provenance,
    tags: ['episode-evolution', input.kind, EVOLUTION_VERSION], createdBy: 'kiokuko-evolution', actor: 'kiokuko-evolution' }
  const prior = input.kind === 'episode' ? undefined : db.prepare(`SELECT d.entry_id AS id FROM memory_derivations d JOIN entries e
    ON e.id=d.entry_id AND e.current_revision=d.revision WHERE d.workspace=? AND d.signature=? AND d.kind=? ORDER BY e.updated_at DESC LIMIT 1`)
    .get<{ id: string }>(episode.workspace, episode.signature, input.kind)
  let entry: EntryRecord
  if (prior) {
    const current = readEntry(db, { workspace: episode.workspace, entryId: prior.id })
    if (current.status !== 'candidate') throw new Error('derived_entry_not_candidate')
    entry = updateCandidateEntryInTransaction(db, { ...data, entryId: current.id, expectedRevision: current.revision, now: input.now })
  } else entry = recordEntryInTransaction(db, { ...data, status: 'candidate', trustLevel: 'untrusted', confidence: 0.5 }, { now: input.now })
  db.prepare(`INSERT INTO memory_derivations(entry_id,revision,workspace,signature,kind,algorithm,manifest_json,input_digest,state)
    VALUES(?,?,?,?,?,?,?,?,'ready')`).run(entry.id, entry.revision, entry.workspace, episode.signature, input.kind, EVOLUTION_VERSION, manifest, inputDigest)
  for (const e of input.episodes) db.prepare('INSERT OR IGNORE INTO memory_episode_entries(run_id,entry_id) VALUES(?,?)').run(e.runId, entry.id)
  return entry
}

/** Caller owns the finalization transaction; an optional episode failure rolls back to its savepoint. */
export function saveEpisode(db: SqliteDatabase, episode: Episode, now: string, nativeEvidence?: readonly EpisodeEvidence[]): void {
  const run = db.prepare('SELECT workspace,dsh_session_id AS session,status FROM ledger_runs WHERE run_id=?')
    .get<{ workspace: string; session: string; status: string }>(episode.runId)
  const source = db.prepare('SELECT source_start_seq AS start,source_end_seq AS end FROM dsh_memory_finalizations WHERE run_id=?')
    .get<{ start: number; end: number }>(episode.runId)
  if (!run || run.workspace !== episode.workspace || run.session !== episode.sessionId || run.status !== episode.outcome ||
    !source || source.start !== episode.start || source.end !== episode.end) throw new Error('episode_identity_mismatch')
  if (evolutionSettings(db).mode === 'off') return
  const prior = db.prepare('SELECT episode_json FROM memory_episodes WHERE run_id=?').get<{ episode_json: string }>(episode.runId)
  if (prior) {
    if (digest(JSON.parse(prior.episode_json)) !== digest(episode)) throw new Error('episode_replay_conflict')
    return
  }
  if (!nativeEvidence) throw new Error('episode_native_evidence_required')
  parseEpisodeDraft(episode.draft, nativeEvidence)
  if (nativeEvidence.some(e => e.seq < episode.start || e.seq > episode.end) ||
    digest(episode.evidence) !== digest(evidenceReferences(nativeEvidence)) ||
    episode.signature !== episodeSignature(episode.workspace, episode.draft) ||
    episode.evidenceDigest !== supportingEvidenceDigest(episode.draft, nativeEvidence) ||
    digest(episodeSignals(episode.draft, nativeEvidence)) !== digest({ successful: episode.successful, procedureSupported: episode.procedureSupported, failed: episode.failed, corrective: episode.corrective, alternativeObserved: episode.alternativeObserved, recovered: episode.recovered })) throw new Error('episode_evidence_mismatch')
  for (const source of episode.sources) {
    const entry = readEntry(db, { workspace: episode.workspace, entryId: source.entryId })
    if (entry.workspace !== episode.workspace || entry.revision !== source.revision || entry.contentHash !== source.hash || entry.provenance.type === 'memory-evolution' || !db.prepare('SELECT 1 FROM dsh_memory_finalization_entries WHERE run_id=? AND entry_id=?').get(episode.runId, source.entryId)) throw new Error('episode_source_mismatch')
  }
  db.prepare('INSERT INTO memory_episodes(run_id,workspace,signature,evidence_digest,episode_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(episode.runId, episode.workspace, episode.signature, episode.evidenceDigest, canonicalJson(episode), now)
  for (const source of episode.sources) db.prepare('INSERT INTO memory_episode_entries(run_id,entry_id) VALUES(?,?)').run(episode.runId, source.entryId)
  const overview = recordDerived(db, { episodes: [episode], kind: 'episode', title: episode.draft.goal, now,
    body: `未検証の経験候補 / Unverified episode\nGoal: ${episode.draft.goal}\nApplicability: ${episode.draft.applicability}\nProcedure: ${episode.draft.procedure}\nObserved: ${episode.draft.events.map(e => e.description).join('\n')}\nRun outcome: ${episode.outcome}\nVerification: ${episode.successful ? 'observed passing result' : 'not established'}\nUnresolved: ${episode.draft.unresolved.join('; ')}\nEvidence: native seq ${episode.start}-${episode.end}` })
  db.prepare('UPDATE memory_episodes SET overview_entry_id=? WHERE run_id=?').run(overview.id, episode.runId)
}

export interface EvolutionModel { sessionId?: string; provider: string; model: string; contextWindow?: number; reasoningEffort?: string }
export function scheduleEvolution(db: SqliteDatabase, runId: string, model: EvolutionModel, now: string): void {
  const current = db.prepare('SELECT episode_json FROM memory_episodes WHERE run_id=?').get<{ episode_json: string }>(runId)
  if (!current || evolutionSettings(db).mode === 'off') return
  const trigger = JSON.parse(current.episode_json) as Episode
  if (db.prepare('SELECT 1 FROM memory_evolution_jobs WHERE trigger_run=?').get(runId)) return
  const episodes = independentEpisodes(db.prepare(`SELECT episode_json FROM memory_episodes WHERE workspace=? AND signature=? ORDER BY created_at DESC LIMIT 120`)
    .all<{ episode_json: string }>(trigger.workspace, trigger.signature).map(row => JSON.parse(row.episode_json) as Episode).filter(e => episodeCurrent(db, e)))
  const skip = (reason: string) => db.prepare('INSERT INTO memory_evolution_skips(run_id,workspace,reason) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET reason=excluded.reason').run(runId, trigger.workspace, reason)
  const kind = inductionKind(episodes)
  if (!kind) { skip('insufficient_independent_support'); return }
  const procedures = new Set(episodes.flatMap(e => kind === 'positive' ? [e.draft.procedure] : e.draft.avoidance ? [e.draft.avoidance.alternative] : []))
  if (procedures.size > 1) { skip('conflicting_procedures'); return }
  const previous = db.prepare(`SELECT seen_json FROM memory_evolution_jobs WHERE workspace=? AND signature=? AND kind=? AND algorithm=?`)
    .all<{ seen_json: string }>(trigger.workspace, trigger.signature, kind, EVOLUTION_VERSION)
  const seen = new Set(previous.flatMap(row => JSON.parse(row.seen_json) as string[]))
  if (previous.length && episodes.filter(e => !seen.has(e.evidenceDigest)).length < 3) { skip('waiting_for_three_new_episodes'); return }
  // Reserve the required support, then include new failures as well as successes.
  // Otherwise six old successes can permanently hide later failed observations.
  const ordered = [...episodes].sort((a,b) => Number(seen.has(a.evidenceDigest)) - Number(seen.has(b.evidenceDigest)) || a.runId.localeCompare(b.runId))
  const support = kind === 'positive' ? ordered.filter(e => e.successful && e.procedureSupported).slice(0,2)
    : ordered.filter(e => eligibleAvoidance(e)).sort((a,b) => Number(b.corrective || b.recovered) - Number(a.corrective || a.recovered)).slice(0,2)
  const selected = [...new Map([...support, ...ordered].map(e => [e.runId,e])).values()].slice(0,6)
  if (inductionKind(selected) !== kind) { skip('bounded_support_insufficient'); return }
  db.prepare('DELETE FROM memory_evolution_skips WHERE run_id=?').run(runId)
  const inputDigest = digest({ version: EVOLUTION_VERSION, kind, episodes: selected })
  db.prepare(`INSERT OR IGNORE INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest, trigger.workspace, runId, trigger.signature, kind, canonicalJson(selected), canonicalJson(episodes.map(e => e.evidenceDigest)), inputDigest, canonicalJson({ provider: model.provider, model: model.model, sessionId: trigger.sessionId, ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }), ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) }), EVOLUTION_VERSION, now, now)
}

export function saveLesson(db: SqliteDatabase, episodes: Episode[], kind: 'positive' | 'avoidance', draft: LessonDraft, now: string): EntryRecord {
  if (draft.conflict || episodes.some(e => !episodeCurrent(db, e))) throw new Error('evolution_stale_or_conflicting')
  const ids = new Set(episodes.map(e => e.runId))
  if (draft.evidence.some(id => !ids.has(id)) || new Set(draft.evidence).size !== ids.size) throw new Error('evolution_missing_evidence')
  if (inductionKind(episodes) !== kind) throw new Error('evolution_support_not_met')
  // v1 synthesis is extractive: the model may select observed wording, not invent
  // an unobserved fix. Semantic generalization requires a separate evaluated contract.
  for (const field of ['applicability', 'procedure', 'verification', 'boundary'] as const) {
    const allowed = episodes.flatMap(e => [e.draft[field], ...(kind === 'avoidance' && e.draft.avoidance
      ? [field === 'procedure' ? e.draft.avoidance.alternative : field === 'applicability' ? e.draft.avoidance.trigger : field === 'verification' ? e.draft.avoidance.verification : e.draft.boundary] : [])])
    if (!allowed.includes(draft[field])) throw new Error('evolution_unsupported_synthesis')
  }
  if (kind === 'positive' && new Set(episodes.map(e => e.draft.procedure)).size > 1) throw new Error('evolution_conflicting_procedures')
  if (kind === 'avoidance' && new Set(episodes.flatMap(e => e.draft.avoidance ? [e.draft.avoidance.alternative] : [])).size > 1) throw new Error('evolution_conflicting_procedures')
  const avoided = kind === 'avoidance' ? `Failure causality: not established by run status or tool failure; environment/transport errors are not proof of a code defect.\nAvoid: ${[...new Set(episodes.flatMap(e => e.draft.avoidance ? [e.draft.avoidance.avoid] : []))].join('; ')}\n` : ''
  const basis = episodes.length === 1 ? 'Single observed correction/recovery; not repeated proof' : `${episodes.length} independent episodes; association is not causal proof`
  return recordDerived(db, { episodes, kind, now, title: `${kind === 'avoidance' ? 'Avoidance' : 'Lesson'}: ${episodes[0]!.draft.goal}`,
    body: `未検証の教訓候補 / Unverified lesson\nApplicability: ${draft.applicability}\n${avoided}Procedure: ${draft.procedure}\nVerification: ${draft.verification}\nBoundary: ${draft.boundary}\nSupport: ${basis}\nEvidence: ${episodes.map(e => `${e.runId} seq ${e.start}-${e.end}`).join('; ')}` })
}

export function diversifyEpisodes<T extends { entryId: string; selectionReasons: string[] }>(db: SqliteDatabase, items: T[], packedIds?: ReadonlySet<string>): T[] {
  if (!evolutionInstalled(db) || evolutionSettings(db).mode !== 'active') return items
  const membership = new Map(items.map(item => [item.entryId,
    db.prepare('SELECT run_id AS id FROM memory_episode_entries WHERE entry_id=?').all<{ id: string }>(item.entryId)]))
  const kinds = new Map(items.map(item => [item.entryId,
    db.prepare(`SELECT d.kind FROM memory_derivations d JOIN entries e ON e.id=d.entry_id AND e.current_revision=d.revision
      WHERE d.entry_id=?`).get<{ kind: string }>(item.entryId)?.kind]))
  const lessonRuns = new Set(items.filter(item => (packedIds === undefined || packedIds.has(item.entryId)) && ['positive', 'avoidance'].includes(kinds.get(item.entryId) ?? ''))
    .flatMap(item => membership.get(item.entryId)!.map(run => run.id)))
  const counts = new Map<string, number>()
  return items.filter(item => {
    const runs = membership.get(item.entryId)!
    if (!item.selectionReasons.includes('exact_signal_match')) {
      // A matching lesson represents its own source overviews. Otherwise the
      // ordinary memory + overview can exhaust every slot before the lesson.
      if (kinds.get(item.entryId) === 'episode' && runs.length && runs.every(run => lessonRuns.has(run.id))) return false
      if (runs.some(r => (counts.get(r.id) ?? 0) >= 2)) return false
    }
    runs.forEach(r => counts.set(r.id, (counts.get(r.id) ?? 0) + 1))
    return true
  })
}

export function evolutionStatus(db: SqliteDatabase, workspace: string): Record<string, unknown> {
  const derivations = { ready: 0, held: 0 }
  const rows = db.prepare(`SELECT d.entry_id,d.revision,d.manifest_json,d.state FROM memory_derivations d JOIN entries e ON e.id=d.entry_id AND e.current_revision=d.revision WHERE d.workspace=?`)
    .all<{ entry_id: string; revision: number; manifest_json: string; state: string }>(workspace)
  for (const row of rows) {
    const eligible = row.state === 'ready' && (JSON.parse(row.manifest_json) as Episode[]).every(e => episodeCurrent(db,e)) && !adverseFeedback(db,row.entry_id,row.revision)
    derivations[eligible ? 'ready' : 'held']++
  }
  return { ...evolutionSettings(db), derivations, quality: 'real_model_evaluation_unmeasured',
    jobs: db.prepare('SELECT state,reason,COUNT(*) AS count FROM memory_evolution_jobs WHERE workspace=? GROUP BY state,reason').all(workspace),
    episodes: db.prepare('SELECT COUNT(*) AS count FROM memory_episodes WHERE workspace=?').get(workspace),
    calls: db.prepare('SELECT COUNT(*) AS count,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,SUM(duration_ms) AS durationMs FROM memory_evolution_calls WHERE workspace=?').get(workspace),
    skips: db.prepare('SELECT reason,COUNT(*) AS count FROM memory_evolution_skips WHERE workspace=? GROUP BY reason').all(workspace),
    extraction: db.prepare('SELECT episode_error AS reason,COUNT(*) AS count FROM dsh_memory_finalizations WHERE workspace=? AND episode_error IS NOT NULL GROUP BY episode_error').all(workspace) }
}
