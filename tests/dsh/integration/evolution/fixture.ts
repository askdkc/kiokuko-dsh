import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { recordEntry } from '../../../../src/memory/entries.js'
import { saveEpisode } from '../../../../src/memory/evolution/store.js'
import { digest, evidenceReferences, supportingEvidenceDigest, episodeSignature, episodeSignals, type EpisodeDraft, type EpisodeEvidence, type Episode } from '../../../../src/memory/evolution/contracts.js'
import type { SqliteDatabase } from '../../../../src/db/adapter.js'
export const NOW = '2026-09-10T00:00:00.000Z'
export function fixture(databasePath = ':memory:') {
  const db = openConnection(databasePath); migrateDatabase(db)
  return { db, runtime: { withDatabase: async <T>(f: (database: SqliteDatabase, embedding: never) => T | PromiseLike<T>): Promise<T> => await f(db,undefined as never) } }
}
export function createRun(db: SqliteDatabase, id: string, workspace = 'project:test') {
  db.prepare(`INSERT OR IGNORE INTO repositories VALUES(?,?,?,NULL,1,0,?,?)`).run(workspace, workspace, 'test', NOW, NOW)
  db.prepare(`INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at)
    VALUES(?,?,?,'1','test','{}','active','{}',?,?,?)`).run(id,workspace,`session-${id}`,NOW,NOW,NOW)
  db.prepare(`INSERT INTO dsh_run_log_boundaries VALUES(?,?,?,1,1,?,?)`).run(id,workspace,`session-${id}`,NOW,NOW)
}
export function draft(): EpisodeDraft {
  return { goal: 'Fix migration lock', applicability: 'SQLITE_BUSY sqlite migration 3.46',
    anchors: { error: 'SQLITE_BUSY', tool: 'sqlite', target: 'migration', version: '3.46' },
    events: [{ kind: 'failure', description: 'Write transaction blocked migration', evidence: [2] },
      { kind: 'action', description: 'Release the writer', evidence: [3] },
      { kind: 'verification', description: 'Migration test passed', evidence: [4] }],
    procedure: 'Release the write transaction before retrying migration.', verification: 'Run the migration test.', boundary: 'Not for corrupt databases.', unresolved: [], avoidance: null }
}
export function evidence(id: string): EpisodeEvidence[] {
  return [{ seq: 1, kind: 'user', text: `SQLITE_BUSY sqlite migration 3.46 case ${id}`, outcome: 'unknown' },
    { seq: 2, kind: 'result', text: `SQLITE_BUSY case ${id}`, outcome: 'failed' },
    { seq: 3, kind: 'action', text: 'Release the write transaction before retrying migration.', outcome: 'unknown' },
    { seq: 4, kind: 'result', text: 'Run the migration test.', outcome: 'passed' }]
}
export function seed(db: SqliteDatabase, id: string, options: { draft?: EpisodeDraft; workspace?: string; outcome?: 'completed' | 'failed'; evidence?: EpisodeEvidence[] } = {}): Episode {
  const workspace = options.workspace ?? 'project:test'; createRun(db,id,workspace)
  const outcome = options.outcome ?? 'completed'
  db.prepare('UPDATE ledger_runs SET status=? WHERE run_id=?').run(outcome,id)
  db.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,extraction_version)
    VALUES(?,?,?,1,5,'completed',1,?,?,2)`).run(id,workspace,`session-${id}`,NOW,NOW)
  const original = recordEntry(db,{ workspace,kind:'lesson',title:`SQLITE_BUSY ${id}`,body:`Release writer ${id}`,createdBy:'fixture',scope:{ visibility:'project' } })
  db.prepare('INSERT INTO dsh_memory_finalization_entries(run_id,entry_id,ordinal,created_at) VALUES(?,?,0,?)').run(id,original.id,NOW)
  const d = options.draft ?? draft(); const observations = options.evidence ?? evidence(id)
  const e: Episode = { runId:id,workspace,sessionId:`session-${id}`,start:1,end:5,logDigest:digest(id),evidenceDigest:supportingEvidenceDigest(d,observations),signature:episodeSignature(workspace,d),outcome,
    draft:d,evidence:evidenceReferences(observations),sources:[{entryId:original.id,revision:original.revision,hash:original.contentHash}],...episodeSignals(d,observations) }
  withImmediateTransaction(db,()=>saveEpisode(db,e,NOW,observations)); return e
}
