import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'

const migrations = path.resolve(import.meta.dirname, '../../../migrations')

async function migrationDirectoryThrough(version: number): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-dsh-migrations-'))
  const names = (await readdir(migrations)).filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name))
  await Promise.all(names.filter((name) => Number(name.slice(0, 3)) <= version)
    .map((name) => copyFile(path.join(migrations, name), path.join(directory, name))))
  return directory
}

test('migration 024 removes non-DSH graphs and rebuilds DSH route identity', async () => {
  const through23 = await migrationDirectoryThrough(23)
  const database = openConnection(':memory:')
  const now = '2026-09-03T00:00:00.000Z'
  try {
    migrateDatabase(database, through23)
    const insertRun = database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, protocol_version, capture_profile,
        coverage_json, status, metadata_json, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, '1', 'minimal', '{}', 'active', '{}', ?, ?, ?)
    `)
    insertRun.run('dsh-run', 'workspace', 'dsh', now, now, now)
    insertRun.run('legacy-run', 'workspace', 'codex', now, now, now)

    const insertSession = database.prepare(`
      INSERT INTO akinator_sessions (
        id, workspace, task_text, profile_json, status, question_count, created_at, updated_at
      ) VALUES (?, 'workspace', ?, '{"taskType":"build","target":"src","expected":"pass","constraints":null}', 'ready', 0, ?, ?)
    `)
    insertSession.run('dsh-intake', 'DSH task', now, now)
    insertSession.run('legacy-intake', 'legacy task', now, now)
    const insertIntake = database.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, '{}', '[]', ?, ?)
    `)
    insertIntake.run('dsh-run', 'dsh-intake', now, now)
    insertIntake.run('legacy-run', 'legacy-intake', now, now)

    database.prepare(`
      INSERT INTO ledger_events (
        event_id, run_id, sequence, event_type, actor, ingested_at, payload_json,
        redaction_json, previous_hash, event_hash
      ) VALUES ('legacy-event', 'legacy-run', 1, 'run.started', 'legacy', ?, '{}', '[]', ?, ?)
    `).run(now, '0'.repeat(64), '1'.repeat(64))
    database.prepare(`
      INSERT INTO ledger_purge_audit (
        purge_id, run_id, event_id, target_type, target_id, actor, created_at
      ) VALUES ('legacy-audit', 'legacy-run', 'legacy-event', 'event', 'legacy-event', 'legacy', ?)
    `).run(now)
    database.prepare(`
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        created_by, created_at, updated_at
      ) VALUES ('independent-memory', 'workspace', 'candidate', 'untrusted', 1, 1, 'test', ?, ?)
    `).run(now, now)
    database.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES ('independent-memory', 'workspace', 1, 'fact', 'keep', 'keep', '{}', '{}', ?, 'test', ?)
    `).run('5'.repeat(64), now)
    database.prepare(`
      INSERT INTO ledger_memory_links (link_id, run_id, event_id, entry_id, created_at)
      VALUES ('legacy-memory-link', 'legacy-run', 'legacy-event', 'independent-memory', ?)
    `).run(now)
    database.prepare(`
      INSERT INTO gateway_idempotency (scope, key_hash, request_hash, response_json, created_at)
      VALUES ('dsh-intake', ?, ?, '{}', ?)
    `).run('6'.repeat(64), '7'.repeat(64), now)

    database.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_session_id,
        repository_root, task_type, status, revision, confirmation_state,
        contract_json, handoff_json, intake_discovery_json, created_at, updated_at
      ) VALUES (
        'dsh-run', 'workspace', 'dsh-intake', 'dsh', 'dsh-session',
        '/repository', 'build', 'goki_executing', 1, 'approved', '{}', '{}', '{}', ?, ?
      )
    `).run(now, now)
    database.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_session_id,
        repository_root, task_type, status, revision, confirmation_state,
        contract_json, handoff_json, intake_discovery_json, created_at, updated_at
      ) VALUES (
        'legacy-run', 'workspace', 'legacy-intake', 'codex', 'legacy-session',
        '/repository', 'build', 'goki_executing', 1, 'approved', '{}', '{}', '{}', ?, ?
      )
    `).run(now, now)
    database.prepare(`
      INSERT INTO enno_work_units (
        run_id, work_unit_id, contract_revision, order_index, work_unit_json,
        status, created_at, updated_at
      ) VALUES ('dsh-run', 'unit', 1, 0, '{}', 'in_progress', ?, ?)
    `).run(now, now)
    database.prepare(`
      INSERT INTO enno_work_units (
        run_id, work_unit_id, contract_revision, order_index, work_unit_json,
        status, created_at, updated_at
      ) VALUES ('legacy-run', 'legacy-unit', 1, 0, '{}', 'in_progress', ?, ?)
    `).run(now, now)
    database.prepare(`
      INSERT INTO enno_client_continuations (
        run_id, client_kind, source_session_id, contract_revision, mutation_revision,
        attempts, directive_digest, continuation_count, total_count, updated_at
      ) VALUES ('dsh-run', 'dsh', 'dsh-session', 1, 0, 0, ?, 1, 1, ?)
    `).run('2'.repeat(64), now)
    database.prepare(`
      INSERT INTO enno_resume_tokens (
        token_hash, run_id, repository_root, route_epoch, client_kind,
        client_session_id, expires_at, created_at
      ) VALUES (?, 'dsh-run', '/repository', 0, 'dsh', 'dsh-session', '2099-01-01T00:00:00.000Z', ?)
    `).run('3'.repeat(64), now)
    database.prepare(`
      INSERT INTO enno_execution_leases (
        run_id, contract_revision, mutation_revision, work_unit_id, route_epoch,
        owner_client_kind, owner_session_id, lease_token_hash, lease_expires_at,
        heartbeat_at, created_at, updated_at
      ) VALUES ('dsh-run', 1, 0, 'unit', 0, 'dsh', 'dsh-session', ?, '2099-01-01T00:00:00.000Z', ?, ?, ?)
    `).run('4'.repeat(64), now, now, now)

    const before = database.prepare(`
      SELECT run_id, workspace, orchestration_session_id, client_session_id,
             repository_root, task_type, status, revision, confirmation_state,
             contract_json, handoff_json, intake_discovery_json, created_at, updated_at,
             phase, ideal_json, meditation_json, route_epoch
      FROM enno_contracts WHERE run_id = 'dsh-run'
    `).get()

    assert.deepEqual(migrateDatabase(database, migrations).applied, [24])
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_runs WHERE run_id = 'legacy-run'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM run_intakes WHERE run_id = 'legacy-run'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_events WHERE run_id = 'legacy-run'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM enno_contracts WHERE run_id = 'legacy-run'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM akinator_sessions WHERE id = 'legacy-intake'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_purge_audit WHERE purge_id = 'legacy-audit'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_memory_links WHERE link_id = 'legacy-memory-link'").get<{ count: number }>()?.count, 0)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries WHERE id = 'independent-memory'").get<{ count: number }>()?.count, 1)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ledger_runs WHERE run_id = 'dsh-run'").get<{ count: number }>()?.count, 1)

    const after = database.prepare(`
      SELECT run_id, workspace, orchestration_session_id, dsh_session_id AS client_session_id,
             repository_root, task_type, status, revision, confirmation_state,
             contract_json, handoff_json, intake_discovery_json, created_at, updated_at,
             phase, ideal_json, meditation_json, route_epoch
      FROM enno_contracts WHERE run_id = 'dsh-run'
    `).get()
    assert.deepEqual(after, before)
    assert.equal(database.prepare("SELECT dsh_session_id AS id FROM enno_dsh_continuations WHERE run_id = 'dsh-run'").get<{ id: string }>()?.id, 'dsh-session')
    assert.equal(database.prepare("SELECT dsh_session_id AS id FROM enno_resume_tokens WHERE run_id = 'dsh-run'").get<{ id: string }>()?.id, 'dsh-session')
    assert.equal(database.prepare("SELECT dsh_session_id AS id FROM enno_execution_leases WHERE run_id = 'dsh-run'").get<{ id: string }>()?.id, 'dsh-session')
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM dsh_intake_idempotency WHERE scope = 'dsh-intake'").get<{ count: number }>()?.count, 1)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'gateway_idempotency'").get<{ count: number }>()?.count, 0)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    assert.throws(() => insertRun.run('forbidden', 'workspace', 'claude', now, now, now), /client_kind must be dsh/u)
    assert.throws(() => database.prepare("UPDATE ledger_runs SET client_kind = 'opencode' WHERE run_id = 'dsh-run'").run(), /client_kind must be dsh/u)
  } finally {
    database.close()
    await rm(through23, { recursive: true, force: true })
  }
})
