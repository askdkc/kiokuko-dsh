import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareAgentTask } from '../../src/dsh/task-intake.js'
import { openConnection } from '../../src/db/connection.js'
import { inspectMigrationSnapshot } from '../../src/db/migrate.js'
import { initializeDatabase } from '../../src/dsh/database.js'
import { DshRuntime } from '../../src/dsh/runtime.js'
import { registerRepositoryAndLocation } from '../../src/repository/binding.js'
import {
  SAMPLE_DATABASE_BASELINE_VERSION,
  SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT,
  SAMPLE_EXTERNAL_SKILL_ID,
  SAMPLE_GLOBAL_TITLES,
  SAMPLE_PROJECT_TITLES,
  SAMPLE_PROJECT_UNICODE_BODY,
  SAMPLE_PROJECT_WORKSPACE,
} from '../fixtures/sample-database.js'
import {
  CURRENT_MIGRATION_SNAPSHOT,
  CURRENT_MIGRATION_VERSIONS,
  CURRENT_SCHEMA_VERSION,
} from '../fixtures/current-migrations.js'

const sourceRoot = path.resolve(import.meta.dirname, '../..')
const sampleDatabasePath = path.join(sourceRoot, 'tests/sampledb/kiokuko-dsh.sqlite3')
const migrationsDirectory = path.join(sourceRoot, 'migrations')
const dshSessionId = 'sampledb-dsh-session'
const capabilities = [
  { kind: 'skill' as const, name: 'kiokuko-soul', description: 'Routes work through Kiokuko.' },
  { kind: 'skill' as const, name: 'kiokuko-single-purpose-functions', description: 'Shapes focused work contracts.' },
]

function assertCommittedBaselineFixture(): void {
  assert.equal(CURRENT_SCHEMA_VERSION, SAMPLE_DATABASE_BASELINE_VERSION)
  assert.deepEqual(CURRENT_MIGRATION_VERSIONS, [SAMPLE_DATABASE_BASELINE_VERSION])
  const database = openConnection(sampleDatabasePath, { readOnly: true })
  try {
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all<{ version: number }>()
      .map(({ version }) => version)
    assert.deepEqual(
      versions,
      [SAMPLE_DATABASE_BASELINE_VERSION],
      'the committed sample database must stay on the single schema baseline',
    )
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    database.close()
  }
}

function assertBaselineFixture(databasePath: string): void {
  const database = openConnection(databasePath, { readOnly: true })
  try {
    const plan = inspectMigrationSnapshot(database, CURRENT_MIGRATION_SNAPSHOT)
    assert.deepEqual(plan.applied, CURRENT_MIGRATION_VERSIONS)
    assert.deepEqual(plan.pending, [])
    assert.equal(plan.currentVersion, CURRENT_SCHEMA_VERSION)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])

    const projectRows = database.prepare(`
      SELECT r.title, r.body
        FROM entries AS e
        JOIN entry_revisions AS r
          ON r.entry_id = e.id AND r.revision = e.current_revision
       WHERE e.workspace = ?
       ORDER BY r.title
    `).all<{ title: string; body: string }>(SAMPLE_PROJECT_WORKSPACE)
    assert.deepEqual(projectRows.map(({ title }) => title), [...SAMPLE_PROJECT_TITLES].sort())
    assert.equal(
      projectRows.find(({ title }) => title === SAMPLE_PROJECT_TITLES[1])?.body,
      SAMPLE_PROJECT_UNICODE_BODY,
    )

    const globalTitles = database.prepare(`
      SELECT r.title
        FROM entries AS e
        JOIN entry_revisions AS r
          ON r.entry_id = e.id AND r.revision = e.current_revision
       WHERE e.workspace = 'global'
       ORDER BY r.title
    `).all<{ title: string }>().map(({ title }) => title)
    assert.deepEqual(globalTitles, [...SAMPLE_GLOBAL_TITLES].sort())

    const externalDocuments = database.prepare(
      'SELECT COUNT(*) AS count FROM external_skill_entries WHERE skill_id = ?',
    ).get<{ count: number }>(SAMPLE_EXTERNAL_SKILL_ID)?.count
    assert.equal(externalDocuments, SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT)

    const searchDocuments = database.prepare(
      'SELECT COUNT(*) AS count FROM entry_search_documents',
    ).get<{ count: number }>()?.count
    assert.equal(searchDocuments, SAMPLE_PROJECT_TITLES.length + SAMPLE_GLOBAL_TITLES.length + SAMPLE_EXTERNAL_SKILL_DOCUMENT_COUNT)
  } finally {
    database.close()
  }
}

async function main(): Promise<void> {
  assertCommittedBaselineFixture()
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-dsh-sampledb-'))
  const repositoryRoot = path.join(temporaryRoot, 'repository')
  const databasePath = path.join(temporaryRoot, 'data', 'kiokuko-dsh.sqlite3')
  await Promise.all([
    mkdir(path.dirname(databasePath), { recursive: true }),
    mkdir(path.join(repositoryRoot, '.git'), { recursive: true }),
  ])
  await copyFile(sampleDatabasePath, databasePath)
  await chmod(databasePath, 0o600)
  const canonicalRepositoryRoot = realpathSync(repositoryRoot)

  let runtime: DshRuntime | undefined
  try {
    const migration = await initializeDatabase({ databasePath, migrationsDirectory })
    assert.deepEqual(migration.applied, [])
    assert.equal(migration.currentVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(migration.backupPath, null)
    assertBaselineFixture(databasePath)

    const database = openConnection(databasePath)
    try {
      registerRepositoryAndLocation(database, {
        repositoryId: 'repo_sampledb_ci',
        workspace: SAMPLE_PROJECT_WORKSPACE,
        displayName: 'sampledb DSH runtime',
        canonicalRoot: canonicalRepositoryRoot,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 0,
      })
    } finally {
      database.close()
    }

    runtime = new DshRuntime({
      repositoryRoot: canonicalRepositoryRoot,
      databasePath,
      migrationsDirectory,
      embeddingConfig: {
        mode: 'off',
        provider: 'openai-compatible',
        allowRemote: false,
        vectorBackend: 'auto',
        timeoutMs: 1_000,
        batchSize: 1,
      },
    })
    await runtime.start()
    const agent = await runtime.openAgent({ dshSessionId, turn: 1 })
    assert.equal(agent.workspace, SAMPLE_PROJECT_WORKSPACE)

    const prepared = await runtime.withDatabase((database) => prepareAgentTask(database, {
      requestId: 'sampledb-dsh-request',
      cwd: canonicalRepositoryRoot,
      task: 'Verify DSH baseline and exact continuation',
      profileHints: {
        taskType: 'debug',
        target: 'tests/sampledb/kiokuko-dsh.sqlite3',
        expected: 'the baseline DSH run resumes through the exact session',
        constraints: 'preserve every baseline fixture record',
      },
      capabilities,
      dshSessionId,
      skillDiscoveryMode: 'off',
    }))
    assert.equal(prepared.ennoOduno.dshSessionId, dshSessionId)

    const first = await runtime.resume({ dshSessionId, runId: prepared.run.runId })
    assert.equal(first.continue, true)
    assert.equal(first.runId, prepared.run.runId)
    assert.ok(first.resumeToken)

    const second = await runtime.resume({
      dshSessionId,
      runId: prepared.run.runId,
      resumeToken: first.resumeToken!,
    })
    assert.equal(second.continue, true)
    assert.equal(second.runId, prepared.run.runId)

    await runtime.withDatabase((database) => {
      const row = database.prepare(`
        SELECT lr.dsh_session_id AS runDshSessionId, ec.dsh_session_id AS dshSessionId
          FROM ledger_runs AS lr
          JOIN enno_contracts AS ec ON ec.run_id = lr.run_id
         WHERE lr.run_id = ?
      `).get<{ runDshSessionId: string; dshSessionId: string }>(prepared.run.runId)
      assert.equal(row?.runDshSessionId, dshSessionId)
      assert.equal(row?.dshSessionId, dshSessionId)
    })
    assert.equal(runtime.closeAgent({ dshSessionId, turn: 1 }), true)
    process.stdout.write('Sample database baseline initialization and DSH runtime resume verification passed.\n')
  } finally {
    await runtime?.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
