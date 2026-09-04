import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { loadMigrationSnapshot, migrateDatabase } from '../../../src/db/migrate.js'

const migrationsDirectory = path.resolve(import.meta.dirname, '../../../migrations')

test('the schema keeps 001 immutable and appends the DSH finalization migration', async () => {
  const entries = await readdir(migrationsDirectory)
  const sqlFiles = entries.filter((name) => name.endsWith('.sql'))
  assert.deepEqual(sqlFiles, ['001_baseline.sql', '002_dsh_memory_finalization.sql'])
  assert.ok(!entries.some((name) => name === 'down'), 'migrations/down must not exist')

  const snapshot = loadMigrationSnapshot(migrationsDirectory)
  assert.equal(snapshot.migrations.length, 2)
  assert.equal(snapshot.migrations[0]!.version, 1)
  assert.equal(snapshot.migrations[0]!.name, '001_baseline.sql')
  assert.equal(snapshot.migrations[1]!.version, 2)
  assert.equal(snapshot.migrations[1]!.name, '002_dsh_memory_finalization.sql')
})

test('baseline initialization creates the complete DSH schema with clean integrity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-baseline-'))
  try {
    const databasePath = path.join(root, 'kiokuko-dsh.sqlite3')
    const database = openConnection(databasePath)
    try {
      const migration = migrateDatabase(database, migrationsDirectory)
      assert.deepEqual(migration.applied, [1, 2])
      assert.equal(migration.currentVersion, 2)

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
        'dsh_intake_idempotency',
        'dsh_memory_finalization_entries',
        'dsh_memory_finalizations',
        'dsh_run_log_boundaries',
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
