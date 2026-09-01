import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { canonicalJson } from '../../src/ledger/hash.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { identifyEnnoClientKind } from '../../src/enno-oduno/harness.js';

const initialMigrations = path.resolve(import.meta.dirname, '../../migrations');

async function migrationDirectoryThrough(version: number): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-enno-dsh-migrations-'));
  const names = (await readdir(initialMigrations)).filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name));
  for (const name of names) {
    if (Number(name.slice(0, 3)) <= version) await copyFile(path.join(initialMigrations, name), path.join(directory, name));
  }
  return directory;
}

test('migration 023 preserves Enno rows and adds the dsh route to every binding table', async () => {
  const oldMigrations = await migrationDirectoryThrough(22);
  const fullMigrations = await migrationDirectoryThrough(23);
  const database = openConnection(':memory:');
  const timestamp = '2026-09-01T00:00:00.000Z';
  const runId = 'run-enno-dsh-migration';
  const workspace = 'project:enno-dsh-migration';
  const sessionId = 'session-enno-dsh-migration';
  const profile = { taskType: 'build', target: 'dsh plugin', expected: 'route persists', constraints: null } as const;

  try {
    assert.deepEqual(migrateDatabase(database, oldMigrations).applied, [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
    new LedgerStore(database, { now: () => timestamp }).createRun({
      runId,
      workspace,
      protocolVersion: '1',
      client: { kind: 'test' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'dsh migration', query: 'dsh migration', profileHints: profile },
      startedAt: timestamp,
    });
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'dsh migration', ?, 'ready', 0, ?, ?)
    `).run(sessionId, workspace, canonicalJson(profile), timestamp, timestamp);
    database.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, '[]', ?, ?)
    `).run(
      runId,
      sessionId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      canonicalContentHash(profile),
      timestamp,
      timestamp,
    );
    database.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_version, client_session_id,
        repository_root, task_type, status, revision, confirmation_state, contract_json,
        handoff_json, intake_discovery_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'codex', '1.0.0', 'codex-session', '/tmp/repository', 'build', 'goki_executing', 1, 'approved', '{}', '{}', '{}', ?, ?)
    `).run(runId, workspace, sessionId, timestamp, timestamp);
    database.prepare(`
      INSERT INTO enno_work_units (
        run_id, work_unit_id, contract_revision, order_index, work_unit_json, status, created_at, updated_at
      ) VALUES (?, 'u1', 1, 0, '{}', 'in_progress', ?, ?)
    `).run(runId, timestamp, timestamp);
    database.prepare(`
      INSERT INTO enno_client_continuations (
        run_id, client_kind, source_session_id, contract_revision, mutation_revision, attempts,
        directive_digest, continuation_count, total_count, updated_at
      ) VALUES (?, 'codex', 'codex-session', 1, 0, 0, ?, 1, 1, ?)
    `).run(runId, 'a'.repeat(64), timestamp);
    database.prepare(`
      INSERT INTO enno_resume_tokens (
        token_hash, run_id, repository_root, route_epoch, client_kind, client_session_id, expires_at, created_at
      ) VALUES (?, ?, '/tmp/repository', 0, 'codex', 'codex-session', ?, ?)
    `).run('b'.repeat(64), runId, '2026-09-01T00:15:00.000Z', timestamp);
    database.prepare(`
      INSERT INTO enno_execution_leases (
        run_id, contract_revision, mutation_revision, work_unit_id, route_epoch,
        owner_client_kind, owner_session_id, lease_token_hash, lease_expires_at,
        heartbeat_at, created_at, updated_at
      ) VALUES (?, 1, 0, 'u1', 0, 'codex', 'codex-session', ?, ?, ?, ?, ?)
    `).run(runId, 'c'.repeat(64), '2026-09-01T00:15:00.000Z', timestamp, timestamp, timestamp);
    database.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, 'plan_submit', 'plan', ?, 'completed', '{}', ?, ?)
    `).run(runId, 'd'.repeat(64), timestamp, timestamp);
    database.prepare(`
      INSERT INTO enno_advisory_rounds (
        round_id, run_id, contract_revision, mutation_revision, phase, input_digest,
        policy_version, source, state, degraded, aggregate_json, created_at, updated_at
      ) VALUES ('round-1', ?, 1, 0, 'planning', ?, 1, 'host_reported', 'aggregated', 0, '{}', ?, ?)
    `).run(runId, 'e'.repeat(64), timestamp, timestamp);
    database.prepare(`
      INSERT INTO enno_advisory_contributions (
        round_id, slot_id, slot_rank, outcome, contribution_json, created_at
      ) VALUES ('round-1', 'slot-1', 0, 'unavailable', '{}', ?)
    `).run(timestamp);
    database.prepare(`
      INSERT INTO enno_verifier_runs (
        verifier_run_id, run_id, work_unit_id, contract_revision, mutation_revision,
        verifier_id, verifier_json, status, exit_code, duration_ms, stdout_preview,
        stderr_preview, stdout_digest, stderr_digest, started_at, finished_at
      ) VALUES ('verifier-1', ?, 'u1', 1, 0, 'u1', '{}', 'passed', 0, 1, '', '', ?, ?, ?, ?)
    `).run(runId, 'f'.repeat(64), '0'.repeat(64), timestamp, timestamp);

    assert.deepEqual(migrateDatabase(database, fullMigrations).applied, [23]);
    for (const table of [
      'enno_contracts',
      'enno_client_continuations',
      'enno_resume_tokens',
      'enno_execution_leases',
    ]) {
      const sql = database.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get<{ sql: string }>('table', table)?.sql ?? '';
      assert.match(sql, /dsh/u, `${table} does not advertise dsh`);
    }
    assert.equal(database.prepare('SELECT client_kind AS clientKind FROM enno_contracts WHERE run_id = ?').get<{ clientKind: string }>(runId)?.clientKind, 'codex');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_client_continuations WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_resume_tokens WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_execution_leases WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_advisory_contributions WHERE round_id = ?').get<{ count: number }>('round-1')?.count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM enno_verifier_runs WHERE run_id = ?').get<{ count: number }>(runId)?.count, 1);

    database.prepare('UPDATE enno_contracts SET client_kind = ?, client_version = ?, client_session_id = ? WHERE run_id = ?').run('dsh', '0.1.2-alpha.3', 'dsh-session', runId);
    database.prepare(`
      INSERT INTO enno_client_continuations (
        run_id, client_kind, source_session_id, contract_revision, mutation_revision, attempts,
        directive_digest, continuation_count, total_count, updated_at
      ) VALUES (?, 'dsh', 'dsh-session', 1, 0, 0, ?, 1, 1, ?)
    `).run(runId, '1'.repeat(64), timestamp);
    database.prepare(`
      INSERT INTO enno_resume_tokens (
        token_hash, run_id, repository_root, route_epoch, client_kind, client_session_id, expires_at, created_at
      ) VALUES (?, ?, '/tmp/repository', 0, 'dsh', 'dsh-session', ?, ?)
    `).run('2'.repeat(64), runId, '2026-09-01T00:15:00.000Z', timestamp);
    database.prepare('UPDATE enno_execution_leases SET owner_client_kind = ?, owner_session_id = ? WHERE run_id = ?').run('dsh', 'dsh-session', runId);
    assert.equal(identifyEnnoClientKind('deepseek-harness'), 'dsh');
    assert.throws(() => database.prepare('UPDATE enno_contracts SET client_kind = ? WHERE run_id = ?').run('unsupported', runId), /constraint/i);
    assert.equal(database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('trigger', 'enno_contract_identity_insert_guard')?.name, 'enno_contract_identity_insert_guard');
    assert.equal(database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('index', 'idx_enno_contracts_session_status')?.name, 'idx_enno_contracts_session_status');
  } finally {
    database.close();
  }
});
