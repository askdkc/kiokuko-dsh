import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { readAkinatorAnswer, readAkinatorSession, readRunIntakeLink } from './store.js';
import { profileHash } from './domain.js';
import { MemoryProbeResultSchema, AkinatorMemoryConfig, type MemoryProbeResult, type ProbeConfig, type ProfileMemoryHint } from './memory-probe-types.js';

export function readProfileMemorySource(database: SqliteDatabase, workspace: string, runId: string) {
  const link = readRunIntakeLink(database, { workspace, runId });
  const session = readAkinatorSession(database, { workspace, sessionId: link.sessionId });
  const run = new LedgerStore(database).readRun(runId);
  if (!run || run.workspace !== workspace) throw new KiokukoError('INTEGRITY_ERROR', 'Profile source run scope mismatch');
  const binding = run.metadata.kiokukoProjectManifestBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  if (binding.version !== 1 || typeof binding.repositoryId !== 'string'
    || typeof binding.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.manifestDigest)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Profile source repository binding is invalid');
  }
  const repository = database.prepare('SELECT repository_id FROM repositories WHERE workspace = ?')
    .get<{ repository_id: string }>(workspace);
  if (!repository || repository.repository_id !== binding.repositoryId) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Profile source repository binding mismatch');
  }
  if (session.status !== 'ready' || link.finalizedAt === null) return null;
  if (link.initialProfileHash !== profileHash(session.profile)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Finalized profile hash mismatch');
  }
  for (const field of ['taskType', 'target', 'expected', 'constraints'] as const) {
    if (link.profileSources[field] === 'user_answer') {
      const answer = readAkinatorAnswer(database, { workspace, sessionId: session.id, questionId: field });
      if (!answer || answer.answer !== session.profile[field]) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Profile source answer mismatch');
      }
    }
  }
  return { link, session, run, repositoryId: repository.repository_id,
    profileHash: profileHash(session.profile), sourcesHash: canonicalContentHash(link.profileSources),
    snapshotHash: canonicalContentHash({ task: session.task, profile: session.profile, sources: link.profileSources,
      repositoryId: repository.repository_id, binding, updatedAt: session.updatedAt }),
  };
}

/** Refresh one finalized source inside the caller's write transaction. No history scan. */
export function projectProfileMemory(database: SqliteDatabase, workspace: string, runId: string): void {
  // Old-schema fixtures and explicit compatibility reads have no projection yet.
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'akinator_profile_documents'").get()) return;
  const source = readProfileMemorySource(database, workspace, runId);
  if (!source) return;
  const { session } = source;
  database.prepare(`INSERT INTO akinator_profile_documents
    (run_id, session_id, workspace, repository_id, task_text, target_text, profile_hash, sources_hash, snapshot_hash, version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(run_id) DO UPDATE SET task_text=excluded.task_text, target_text=excluded.target_text,
      profile_hash=excluded.profile_hash, sources_hash=excluded.sources_hash, snapshot_hash=excluded.snapshot_hash,
      updated_at=excluded.updated_at
  `).run(runId, session.id, workspace, source.repositoryId, session.task.slice(0, 4096),
    (session.profile.target ?? '').slice(0, 1024), source.profileHash, source.sourcesHash, source.snapshotHash, session.updatedAt);
  const document = database.prepare('SELECT id FROM akinator_profile_documents WHERE run_id = ?').get<{ id: number }>(runId)!;
  database.prepare('DELETE FROM akinator_profile_signals WHERE document_id = ?').run(document.id);
  if (session.profile.target && session.profile.target.length <= 1024) {
    database.prepare(`INSERT INTO akinator_profile_signals(document_id, workspace, repository_id, kind, value)
      VALUES (?, ?, ?, 'target', ?)`)
      .run(document.id, workspace, source.repositoryId, session.profile.target);
  }
}

/** Explicit, resumable maintenance. A batch and its cursor commit together. */
export function backfillProfileMemory(database: SqliteDatabase, batchSize = 100, rebuild = false) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new KiokukoError('VALIDATION_ERROR', 'Backfill batch size must be between 1 and 1000');
  }
  return withImmediateTransaction(database, () => {
    if (rebuild) {
      database.exec("DELETE FROM akinator_profile_documents; UPDATE akinator_profile_backfill SET cursor = '', complete = 0 WHERE version = 1;");
    }
    const state = database.prepare('SELECT cursor FROM akinator_profile_backfill WHERE version = 1').get<{ cursor: string }>()!;
    const rows = database.prepare(`SELECT ri.run_id, lr.workspace FROM run_intakes ri
      JOIN ledger_runs lr ON lr.run_id = ri.run_id WHERE ri.run_id > ? ORDER BY ri.run_id LIMIT ?`)
      .all<{ run_id: string; workspace: string }>(state.cursor, batchSize);
    for (const row of rows) projectProfileMemory(database, row.workspace, row.run_id);
    const complete = rows.length < batchSize;
    database.prepare('UPDATE akinator_profile_backfill SET cursor = ?, complete = ? WHERE version = 1')
      .run(rows.at(-1)?.run_id ?? state.cursor, complete ? 1 : 0);
    return { processed: rows.length, complete };
  });
}

export function profileCoverageComplete(database: SqliteDatabase, workspace: string, repositoryId: string): boolean {
  return !database.prepare(`SELECT 1 AS missing FROM run_intakes ri
    JOIN ledger_runs lr ON lr.run_id = ri.run_id JOIN akinator_sessions s ON s.id = ri.session_id
    LEFT JOIN akinator_profile_documents d ON d.run_id = ri.run_id
    WHERE lr.workspace = ? AND s.status = 'ready' AND ri.finalized_at IS NOT NULL
      AND json_extract(lr.metadata_json, '$.kiokukoProjectManifestBinding.repositoryId') = ?
      AND d.id IS NULL LIMIT 1`).get(workspace, repositoryId);
}

export function saveMemoryResolution(database: SqliteDatabase, input: {
  runId: string; baseHash: string; resultHash: string; config: ProbeConfig; result: MemoryProbeResult; now: string;
}): void {
  const result = MemoryProbeResultSchema.parse(input.result);
  const config = AkinatorMemoryConfig.parse(input.config);
  database.prepare(`INSERT INTO akinator_memory_resolutions
    (run_id, base_hash, result_hash, config_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.runId, input.baseHash, input.resultHash, canonicalJson(config), canonicalJson(result), input.now);
  const sources = new Set(result.resolutions.flatMap(r => r.evidence.map(e => e.runId)));
  for (const source of sources) database.prepare('INSERT INTO akinator_memory_resolution_sources(run_id, source_run_id) VALUES (?, ?)')
    .run(input.runId, source);
}

/** Revalidate source records before displaying a saved suggestion. Never restore an old profile. */
export function readMemoryHints(database: SqliteDatabase, input: {
  runId: string; workspace: string; repositoryId: string; enabled: boolean;
}): ProfileMemoryHint[] {
  if (!input.enabled) return [];
  const row = database.prepare('SELECT result_json FROM akinator_memory_resolutions WHERE run_id = ?')
    .get<{ result_json: string }>(input.runId);
  if (!row) return [];
  let result: MemoryProbeResult;
  try { result = MemoryProbeResultSchema.parse(JSON.parse(row.result_json)); }
  catch { throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory resolution is invalid'); }
  if (result.mode !== 'suggest' && result.mode !== 'resolve') return [];
  const hints: ProfileMemoryHint[] = [];
  for (const resolution of result.resolutions) {
    if (resolution.decision !== 'suggest' || resolution.value === null) continue;
    const evidence = resolution.evidence[0];
    if (!evidence || evidence.workspace !== input.workspace || evidence.repositoryId !== input.repositoryId) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile suggestion scope mismatch');
    }
    // Missing source links are expected after purge; no stale candidate body is displayed.
    if (!database.prepare('SELECT 1 FROM run_intakes WHERE run_id = ?').get(evidence.runId)) continue;
    const source = readProfileMemorySource(database, input.workspace, evidence.runId);
    if (!source || source.snapshotHash !== evidence.snapshotHash || source.profileHash !== evidence.profileHash
      || source.sourcesHash !== evidence.sourceMapHash || source.session.id !== evidence.sessionId
      || source.session.profile[resolution.field] !== resolution.value
      || source.link.profileSources[resolution.field] !== evidence.originalSource
      || source.run.status !== 'completed') continue;
    hints.push({ field: resolution.field, value: resolution.value,
      source: { runId: evidence.runId, observedAt: evidence.observedAt } });
  }
  return hints;
}
