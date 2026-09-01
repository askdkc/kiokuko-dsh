import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { CURRENT_MIGRATION_VERSIONS, CURRENT_SCHEMA_VERSION } from '../fixtures/current-migrations.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const initialMigrations = path.join(repositoryRoot, 'migrations');

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

async function copyMigrationRange(directory: string, firstVersion: number, lastVersion: number): Promise<void> {
  const migrationFiles = await readdir(initialMigrations);
  for (let version = firstVersion; version <= lastVersion; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(directory, name));
  }
}

const embeddingTables = [
  'embedding_profiles',
  'embedding_runtime',
  'entry_embeddings',
  'embedding_jobs',
  'query_embeddings',
] as const;

test('migration 021 installs the derived embedding schema without provider I/O', async () => {
  const directory = await temporaryDirectory('embedding-migration');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('provider I/O is forbidden during migration');
  }) as typeof fetch;
  try {
    const result = migrateDatabase(database);
    assert.equal(result.currentVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(result.applied, CURRENT_MIGRATION_VERSIONS);
    for (const table of embeddingTables) {
      assert.equal(
        database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.present,
        1,
        `missing ${table}`,
      );
    }
    const runtime = database.prepare('SELECT singleton, active_profile_id, generation, activated_at FROM embedding_runtime').get();
    assert.deepEqual(runtime === undefined ? undefined : { ...runtime }, {
      singleton: 1,
      active_profile_id: null,
      generation: 1,
      activated_at: null,
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual({ ...(database.prepare('SELECT mode, provider_kind, setup_state FROM embedding_settings').get() as object) }, {
      mode: 'off',
      provider_kind: null,
      setup_state: 'disabled',
    });
    assert.deepEqual(migrateDatabase(database).applied, []);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('migration 021 applies cleanly to a database stopped at migration 020', async () => {
  const directory = await temporaryDirectory('embedding-migration-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 20);
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    await copyFile(
      path.join(initialMigrations, '021_semantic_embeddings.sql'),
      path.join(migrationsDirectory, '021_semantic_embeddings.sql'),
    );
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, [21]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 21);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('migration 021 profile rows are immutable and its manual rollback removes only derived tables', async () => {
  const directory = await temporaryDirectory('embedding-migration-rollback');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    const migrationsDirectory = path.join(directory, 'migrations');
    await mkdir(migrationsDirectory);
    await copyMigrationRange(migrationsDirectory, 1, 21);
    migrateDatabase(database, migrationsDirectory);
    const profileId = 'a'.repeat(64);
    database.prepare(`
      INSERT INTO embedding_profiles (
        profile_id, provider_kind, endpoint_fingerprint, model, dimensions,
        distance_metric, distance_ceiling, document_template_version,
        query_template_version, created_at
      ) VALUES (?, 'openai-compatible', ?, 'test-model', 3, 'cosine', 0.8, 1, 1, ?)
    `).run(profileId, 'b'.repeat(64), '2026-08-30T00:00:00.000Z');
    assert.throws(
      () => database.prepare('UPDATE embedding_profiles SET model = ? WHERE profile_id = ?').run('changed', profileId),
      /immutable/iu,
    );

    const rollback = await readFile(path.join(initialMigrations, 'down/021_semantic_embeddings.sql'), 'utf8');
    database.exec(rollback);
    for (const table of embeddingTables) {
      assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), undefined);
    }
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get<{ version: number }>()?.version, 20);
    assert.equal(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get()?.present, 1);
  } finally {
    database.close();
  }
});

test('migration 022 preserves an active v1 profile and all semantic projections', async () => {
  const directory = await temporaryDirectory('embedding-migration-v1-preservation');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 21);
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(database, migrationsDirectory);
    const profileId = 'a'.repeat(64);
    database.prepare(`
      INSERT INTO embedding_profiles (
        profile_id, provider_kind, endpoint_fingerprint, model,
        dimensions, distance_metric, distance_ceiling, document_template_version,
        query_template_version, created_at
      ) VALUES (?, 'openai-compatible', ?, 'legacy-model', 3, 'cosine', 0.8, 1, 1, ?)
    `).run(profileId, 'b'.repeat(64), '2026-08-30T00:00:00.000Z');
    database.prepare('UPDATE embedding_runtime SET active_profile_id = ?').run(profileId);
    const before = database.prepare('SELECT profile_id, provider_kind, model, dimensions FROM embedding_profiles').all();
    await copyFile(path.join(initialMigrations, '022_embedding_setup_v2.sql'), path.join(migrationsDirectory, '022_embedding_setup_v2.sql'));
    migrateDatabase(database, migrationsDirectory);
    assert.deepEqual(database.prepare('SELECT profile_id, provider_kind, model, dimensions FROM embedding_profiles').all(), before);
    assert.equal(database.prepare('SELECT legacy_profile_id, setup_state FROM embedding_settings').get<{ legacy_profile_id: string; setup_state: string }>()?.legacy_profile_id, profileId);
    assert.equal(database.prepare('SELECT setup_state FROM embedding_settings').get<{ setup_state: string }>()?.setup_state, 'requires_setup');
  } finally {
    database.close();
  }
});
