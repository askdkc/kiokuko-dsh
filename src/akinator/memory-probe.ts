import { performance } from 'node:perf_hooks';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SqliteDatabase, SqliteValue } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import type { TaskProfile } from './types.js';
import { AkinatorMemoryConfig, type MemoryProbeResult, type ProbeConfig, type ProfileMemoryCandidate } from './memory-probe-types.js';
import { profileCoverageComplete, readProfileMemorySource } from './profile-memory-store.js';
import { resolveProfileMemory } from './profile-memory-resolver.js';

export interface MemoryProbeScope {
  workspace: string;
  repositoryId: string;
  repositoryRoot: string;
  allowed: boolean;
  /** Current task path tokens verified before entering the write transaction. */
  verifiedTargets: readonly string[];
}

/** Only literal path tokens qualify. No guessed paths, prefix matching, or repository-wide expansion. */
export function verifyTaskTargets(task: string, repositoryRoot: string, cwd = repositoryRoot): string[] {
  const tokens = [...new Set(task.slice(0, 16384).split(/[\s`"'<>()[\]{},;:!?。、]+/u))]
    .filter(token => token.length <= 1024 && /[./]/u.test(token)).slice(0, 32);
  const result: string[] = [];
  for (const token of tokens) {
    if (cwd !== repositoryRoot && !isAbsolute(token)) continue;
    if (token.includes('..') || token.includes('\\') || token.includes('://')) continue;
    const absolute = resolve(repositoryRoot, token);
    const rel = relative(repositoryRoot, absolute);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      const canonical = realpathSync(absolute);
      const canonicalRelative = relative(repositoryRoot, canonical);
      if (!canonicalRelative || canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) continue;
      // Symlinks and aliases do not prove the exact requested target in v1.
      if (canonical !== absolute) continue;
      result.push(token);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'ELOOP') throw error;
    }
  }
  return result;
}

export function shouldProbe(profile: TaskProfile, config: ProbeConfig, scope?: MemoryProbeScope): boolean {
  return config.mode !== 'off' && scope?.allowed === true && profile.taskType !== 'chat'
    && (profile.taskType === null || profile.target === null || profile.expected === null);
}

/** Bounded synchronous local search. Elapsed budget is checked between queries, not a SQL hard timeout. */
export function probeProfileMemory(database: SqliteDatabase, input: {
  task: string; profile: TaskProfile; config: ProbeConfig; scope?: MemoryProbeScope; now: string;
}): MemoryProbeResult {
  const config = AkinatorMemoryConfig.parse(input.config);
  const result: MemoryProbeResult = { policyVersion: 'profile-memory-v1', mode: config.mode, status: 'skipped',
    coverage: 'partial', resolutions: [], scannedCandidates: 0, expandedProfiles: 0,
    queryCount: 0, elapsedMs: 0, truncated: false };
  if (!shouldProbe(input.profile, config, input.scope)) return result;
  const scope = input.scope!;
  const started = performance.now();
  const registered = database.prepare(`SELECT 1 FROM repositories r JOIN repository_locations l USING(repository_id)
    WHERE r.workspace = ? AND r.repository_id = ? AND l.canonical_root = ?`)
    .get(scope.workspace, scope.repositoryId, scope.repositoryRoot);
  if (!registered) throw new KiokukoError('CONFLICT', 'Profile probe repository location changed');
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'akinator_profile_documents'").get()) {
    return { ...result, status: 'unavailable', elapsedMs: performance.now() - started };
  }
  result.coverage = profileCoverageComplete(database, scope.workspace, scope.repositoryId) ? 'complete' : 'partial';
  const ids = new Map<number, number>();
  const query = (sql: string, parameters: SqliteValue[], score: number) => {
    if (performance.now() - started >= config.maxElapsedMs || ids.size >= config.maxCandidates) {
      result.truncated = true; return;
    }
    result.queryCount++;
    const rows = database.prepare(sql).all<{ id: number }>(...parameters, config.maxCandidates + 1);
    if (rows.length > config.maxCandidates) result.truncated = true;
    for (const row of rows) {
      if (ids.has(row.id)) continue;
      if (ids.size >= config.maxCandidates) { result.truncated = true; break; }
      ids.set(row.id, score);
    }
  };
  if (scope.verifiedTargets.length) query(`SELECT DISTINCT document_id AS id FROM akinator_profile_signals
    WHERE workspace = ? AND repository_id = ? AND kind = 'target'
      AND value IN (${scope.verifiedTargets.map(() => '?').join(',')}) ORDER BY document_id LIMIT ?`,
    [scope.workspace, scope.repositoryId, ...scope.verifiedTargets], 100);
  const words = [...new Set(input.task.slice(0, 4096).match(/[\p{L}\p{N}_./-]+/gu) ?? [])]
    .filter(word => word.length <= 128).slice(0, 16);
  for (const lane of ['akinator_profile_fts', 'akinator_profile_trigram'] as const) {
    const terms = words.filter(word => lane !== 'akinator_profile_trigram' || [...word].length >= 3);
    if (!terms.length) continue;
    const match = terms.map(word => '"' + word.replaceAll('"', '""') + '"').join(' OR ');
    query(`SELECT d.id FROM ${lane} JOIN akinator_profile_documents d ON d.id = ${lane}.rowid
      WHERE ${lane} MATCH ? AND d.workspace = ? AND d.repository_id = ? ORDER BY rank, d.id LIMIT ?`,
      [match, scope.workspace, scope.repositoryId], lane === 'akinator_profile_fts' ? 60 : 40);
  }
  const candidates: ProfileMemoryCandidate[] = [];
  for (const [id, rankingScore] of ids) {
    if (performance.now() - started >= config.maxElapsedMs) { result.truncated = true; break; }
    const doc = database.prepare('SELECT * FROM akinator_profile_documents WHERE id = ?')
      .get<{ run_id: string; workspace: string; repository_id: string; profile_hash: string; sources_hash: string; snapshot_hash: string; task_text: string; target_text: string; version: number }>(id);
    if (!doc || doc.workspace !== scope.workspace || doc.repository_id !== scope.repositoryId) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Profile search projection scope mismatch');
    }
    result.expandedProfiles++;
    const source = readProfileMemorySource(database, scope.workspace, doc.run_id);
    if (!source || source.profileHash !== doc.profile_hash || source.sourcesHash !== doc.sources_hash
      || source.snapshotHash !== doc.snapshot_hash || doc.version !== 1
      || doc.task_text !== source.session.task.slice(0, 4096) || doc.target_text !== (source.session.profile.target ?? '').slice(0, 1024)) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Profile search projection is stale or corrupt');
    }
    if (source.run.status !== 'completed') continue;
    candidates.push({ profile: source.session.profile, sources: source.link.profileSources, completed: true,
      exactTarget: source.session.profile.target !== null && scope.verifiedTargets.includes(source.session.profile.target),
      rankingScore, evidence: { sessionId: source.session.id, runId: source.run.runId, workspace: scope.workspace,
        repositoryId: scope.repositoryId, profileHash: source.profileHash, sourceMapHash: source.sourcesHash,
        snapshotHash: source.snapshotHash, originalSource: 'inferred', observedAt: source.session.updatedAt } });
  }
  result.scannedCandidates = ids.size;
  result.status = result.truncated || result.coverage === 'partial' ? 'incomplete' : 'complete';
  result.resolutions = resolveProfileMemory({ profile: input.profile, candidates, complete: result.status === 'complete', config });
  result.elapsedMs = performance.now() - started;
  return result;
}
