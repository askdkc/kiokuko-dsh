import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { loadMigrationSnapshot, migrateDatabase } from '../../../src/db/migrate.js'

const migrationsDirectory = path.resolve(import.meta.dirname, '../../../migrations')

test('the schema keeps 001 immutable and appends forward-only DSH runtime migrations', async () => {
  const entries = await readdir(migrationsDirectory)
  const sqlFiles = entries.filter((name) => name.endsWith('.sql'))
  assert.deepEqual(sqlFiles, ['001_baseline.sql', '002_dsh_memory_finalization.sql', '003_dsh_turn_process.sql', '004_dsh_loop_guard.sql'])
  assert.ok(!entries.some((name) => name === 'down'), 'migrations/down must not exist')

  const snapshot = loadMigrationSnapshot(migrationsDirectory)
  assert.equal(snapshot.migrations.length, 4)
  assert.equal(snapshot.migrations[0]!.version, 1)
  assert.equal(snapshot.migrations[0]!.name, '001_baseline.sql')
  assert.equal(snapshot.migrations[1]!.version, 2)
  assert.equal(snapshot.migrations[1]!.name, '002_dsh_memory_finalization.sql')
  assert.equal(snapshot.migrations[2]!.version, 3)
  assert.equal(snapshot.migrations[2]!.name, '003_dsh_turn_process.sql')
  assert.equal(snapshot.migrations[3]!.version, 4)
  assert.equal(snapshot.migrations[3]!.name, '004_dsh_loop_guard.sql')
})

test('baseline initialization creates the complete DSH schema with clean integrity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-baseline-'))
  try {
    const databasePath = path.join(root, 'kiokuko-dsh.sqlite3')
    const database = openConnection(databasePath)
    try {
      const migration = migrateDatabase(database, migrationsDirectory)
      assert.deepEqual(migration.applied, [1, 2, 3, 4])
      assert.equal(migration.currentVersion, 4)

      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')

      const expectedTables = [
        'agent_task_skill_discovery_attempts',
        'akinator_answers',
        'akinator_reasoning_paths',
        'akinator_sessions',
        'audit_events',
        'context_deliveries',
        'context_delivery_entries',
        'context_feedback',
        'dsh_boundary_jobs',
        'dsh_continuation_outbox',
        'dsh_input_claim_backups',
        'dsh_intake_idempotency',
        'dsh_loop_guard_claims',
        'dsh_loop_guard_states',
        'dsh_memory_finalization_entries',
        'dsh_memory_finalizations',
        'dsh_run_log_boundaries',
        'dsh_session_cache_health',
        'dsh_temporary_memories',
        'dsh_turn_handoffs',
        'dsh_turn_intents',
        'dsh_turn_receipts',
        'embedding_jobs',
        'embedding_model_installations',
        'embedding_profiles',
        'embedding_runtime',
        'embedding_settings',
        'embedding_setup_runs',
        'enno_advisory_contributions',
        'enno_advisory_rounds',
        'enno_contracts',
        'enno_dsh_continuations',
        'enno_execution_leases',
        'enno_operation_receipts',
        'enno_resume_tokens',
        'enno_verifier_runs',
        'enno_work_units',
        'entries',
        'entries_fts',
        'entries_trigram',
        'entry_embeddings',
        'entry_links',
        'entry_revision_tags',
        'entry_revisions',
        'entry_search_documents',
        'entry_search_signals',
        'external_skill_entries',
        'external_skill_generation_clock',
        'external_skill_generation_tokens',
        'external_skills',
        'intake_feedback',
        'knowledge_sources',
        'ledger_events',
        'ledger_evidence',
        'ledger_memory_links',
        'ledger_purge_audit',
        'ledger_runs',
        'nudge_deliveries',
        'query_embeddings',
        'repositories',
        'repository_fingerprints',
        'repository_locations',
        'run_feedback',
        'run_intakes',
        'schema_migrations',
        'skill_audit_failure_cache',
        'skill_discovery_cache',
        'skill_source_failure_cache',
      ]
      const tables = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'entries_fts_%' AND name NOT LIKE 'entries_trigram_%' ORDER BY name",
      ).all<{ name: string }>().map(({ name }) => name)
      assert.deepEqual(tables, expectedTables)

      // The ledger binds every run to exactly one DSH session identity.
      const runColumns = database.prepare('PRAGMA table_info(ledger_runs)').all<{ name: string }>().map(({ name }) => name)
      assert.ok(runColumns.includes('dsh_session_id'))
      assert.ok(!runColumns.includes('client_kind'))
      assert.ok(!runColumns.includes('client_version'))
      assert.ok(!runColumns.includes('source_session_id'))

      const boundaryColumns = database.prepare('PRAGMA table_info(dsh_boundary_jobs)')
        .all<{ name: string }>().map(({ name }) => name)
      for (const name of ['progress_digest', 'progress_count', 'progress_claim_attempt', 'progress_waiting']) {
        assert.ok(boundaryColumns.includes(name), `missing bounded boundary progress column ${name}`)
      }

      // CJK-capable search projection is present from the baseline.
      const trigramSql = database.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'entries_trigram'",
      ).get<{ sql: string }>()?.sql ?? ''
      assert.match(trigramSql, /tokenize\s*=\s*'trigram'/u)

      const searchDocuments = database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('entry_search_documents_ai','entry_search_documents_ad','entry_search_documents_au')",
      ).get<{ count: number }>()?.count
      assert.equal(searchDocuments, 3)

      // Intake idempotency is DSH-native from the start.
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dsh_intake_idempotency'",
        ).get<{ count: number }>()?.count,
        1,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an existing version-3 database upgrades forward to the durable loop guard', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-loop-migration-'))
  try {
    const version3Directory = path.join(root, 'v3')
    await mkdir(version3Directory)
    for (const name of ['001_baseline.sql', '002_dsh_memory_finalization.sql', '003_dsh_turn_process.sql']) {
      await copyFile(path.join(migrationsDirectory, name), path.join(version3Directory, name))
    }
    const database = openConnection(path.join(root, 'kiokuko-dsh.sqlite3'))
    try {
      assert.deepEqual(migrateDatabase(database, version3Directory).applied, [1, 2, 3])
      const upgraded = migrateDatabase(database, migrationsDirectory)
      assert.deepEqual(upgraded.applied, [4])
      assert.equal(upgraded.currentVersion, 4)
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'dsh_loop_guard_states'").get<{ count: number }>()?.count, 1)
    } finally {
      database.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
