import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { recordEntry } from '../../src/memory/entries.js';
import { canonicalEntryRevisionContentHash } from '../../src/serialization/validate.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const currentMigrations = path.join(repositoryRoot, 'migrations');

test('initializeDatabase keeps the verified backup and rolls back a failing migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-migration-failure-'));
  const oldMigrations = path.join(root, 'old-migrations');
  const brokenMigrations = path.join(root, 'broken-migrations');
  await Promise.all([oldMigrations, brokenMigrations].map((directory) => mkdir(directory)));
  const initialSql = 'CREATE TABLE preserved_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n';
  await writeFile(path.join(oldMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(brokenMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(brokenMigrations, '002_broken.sql'), `
    CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);
    SELECT missing_column FROM missing_table;
  `);
  const databasePath = path.join(root, 'data.sqlite3');
  const initial = openConnection(databasePath);
  try {
    migrateDatabase(initial, oldMigrations);
    initial.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('keep me');
  } finally {
    initial.close();
  }

  await assert.rejects(initializeDatabase({ databasePath, migrationsDirectory: brokenMigrations }), /missing_table|no such/i);
  const backups = (await readdir(path.join(root, 'backups'))).filter((name) => name.endsWith('.sqlite3'));
  assert.equal(backups.length, 1);

  for (const candidate of [databasePath, path.join(root, 'backups', backups[0]!)]) {
    const database = openConnection(candidate, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
      assert.equal(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(), undefined);
    } finally {
      database.close();
    }
  }
});

test('initializeDatabase rejects source foreign-key corruption before backup or migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-source-foreign-key-'));
  const oldMigrations = path.join(root, 'old-migrations');
  await mkdir(oldMigrations);
  const migrationNames = await readdir(currentMigrations);
  for (let version = 1; version <= 8; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationNames.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(currentMigrations, name), path.join(oldMigrations, name));
  }
  const databasePath = path.join(root, 'data.sqlite3');
  const source = openConnection(databasePath);
  try {
    assert.deepEqual(migrateDatabase(source, oldMigrations).applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    source.exec('PRAGMA foreign_keys = OFF');
    source.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, 1, ?)')
      .run('missing-entry', 'orphan');
    source.exec('PRAGMA foreign_keys = ON');
  } finally {
    source.close();
  }

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: currentMigrations }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && error.details.stage === 'before',
  );
  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    assert.equal(
      unchanged.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'external_skills'").get(),
      undefined,
    );
    assert.equal(
      unchanged.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_task_skill_discovery_attempts'").get(),
      undefined,
    );
    assert.equal(unchanged.prepare('PRAGMA foreign_key_check').all().length, 1);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rolls back a migration batch whose final foreign-key check fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-post-foreign-key-'));
  const oldMigrations = path.join(root, 'old-migrations');
  const newMigrations = path.join(root, 'new-migrations');
  await Promise.all([oldMigrations, newMigrations].map((directory) => mkdir(directory)));
  const initialSql = 'CREATE TABLE parent_rows (id INTEGER PRIMARY KEY);\n';
  await writeFile(path.join(oldMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(newMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(newMigrations, '002_deferred_orphan.sql'), `
    PRAGMA defer_foreign_keys = ON;
    CREATE TABLE orphan_rows (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent_rows(id) DEFERRABLE INITIALLY DEFERRED
    );
    INSERT INTO orphan_rows (id, parent_id) VALUES (1, 999);
  `);
  const databasePath = path.join(root, 'data.sqlite3');
  const source = openConnection(databasePath);
  try {
    assert.deepEqual(migrateDatabase(source, oldMigrations).applied, [1]);
  } finally {
    source.close();
  }

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: newMigrations }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'INTEGRITY_ERROR'
      && error.details.stage === 'after',
  );
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(
      unchanged.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'orphan_rows'").get(),
      undefined,
    );
    assert.deepEqual(unchanged.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    unchanged.close();
  }
});

test('migration 005 rolls back its SQL, application projection rebuild, and marker together, then retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-projection-migration-'));
  const oldMigrations = path.join(root, 'old-migrations');
  const newMigrations = path.join(root, 'new-migrations');
  await Promise.all([oldMigrations, newMigrations].map((directory) => mkdir(directory)));
  const migrationNames = await readdir(currentMigrations);
  for (let version = 1; version <= 5; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationNames.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    if (version <= 4) await copyFile(path.join(currentMigrations, name), path.join(oldMigrations, name));
    await copyFile(path.join(currentMigrations, name), path.join(newMigrations, name));
  }

  const databasePath = path.join(root, 'data.sqlite3');
  const initial = openConnection(databasePath);
  try {
    assert.deepEqual(migrateDatabase(initial, oldMigrations).applied, [1, 2, 3, 4]);
    const timestamp = '2026-08-25T00:00:00.000Z';
    const title = 'Migration projection';
    const body = 'Rebuild this structured search projection.';
    const scope = { schemaVersion: 3, signals: { symbols: ['MigrationHookSentinel'] }, visibility: 'project' };
    const tags = ['migration-tag'];
    const contentHash = canonicalEntryRevisionContentHash({
      kind: 'lesson',
      title,
      body,
      summary: null,
      scope,
      provenance: {},
      tags,
    });
    initial.prepare(`
      INSERT INTO entries (
        id, workspace, status, trust_level, confidence, current_revision,
        superseded_by, created_by, created_at, updated_at, verified_at
      ) VALUES (?, ?, 'verified', 'source_verified', 1, 1, NULL, 'migration-test', ?, ?, ?)
    `).run('entry-migration-005', 'project:migration-005', timestamp, timestamp, timestamp);
    initial.prepare(`
      INSERT INTO entry_revisions (
        entry_id, workspace, revision, kind, title, body, summary, scope_json,
        provenance_json, content_hash, created_by, created_at
      ) VALUES (?, ?, 1, 'lesson', ?, ?, NULL, ?, '{}', ?, 'migration-test', ?)
    `).run(
      'entry-migration-005',
      'project:migration-005',
      title,
      body,
      '{"schemaVersion":3,"signals":{"symbols":["MigrationHookSentinel"]},"visibility":"project"}',
      contentHash,
      timestamp,
    );
    initial.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, 1, ?)')
      .run('entry-migration-005', tags[0]!);
  } finally {
    initial.close();
  }

  const migration005Path = path.join(newMigrations, '005_hybrid_search.sql');
  const migration005 = await readFile(migration005Path, 'utf8');
  await writeFile(migration005Path, `${migration005}\n
    CREATE TRIGGER fail_migration_005_application_rebuild
    BEFORE INSERT ON entry_search_signals
    WHEN NEW.signal_type = 'symbol'
    BEGIN
      SELECT RAISE(ABORT, 'injected migration 005 projection rebuild failure');
    END;
  `);

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: newMigrations }),
    /injected migration 005 projection rebuild failure/u,
  );
  const rolledBack = openConnection(databasePath);
  try {
    assert.deepEqual(
      rolledBack.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => ({ ...row })),
      [1, 2, 3, 4].map((version) => ({ version })),
    );
    for (const table of ['entries_trigram', 'entry_search_signals']) {
      assert.equal(
        rolledBack.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        undefined,
      );
    }
    assert.equal(rolledBack.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
  } finally {
    rolledBack.close();
  }

  await writeFile(migration005Path, migration005);
  const retried = await initializeDatabase({ databasePath, migrationsDirectory: newMigrations });
  assert.deepEqual(retried.applied, [5]);
  const upgraded = openConnection(databasePath);
  try {
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 5);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM entries_fts').get<{ count: number }>()?.count, 1);
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM entries_trigram').get<{ count: number }>()?.count, 1);
    assert.deepEqual(
      upgraded.prepare(`
        SELECT signal_type, normalized_value
          FROM entry_search_signals
         WHERE entry_id = ?
         ORDER BY signal_type, normalized_value
      `).all<Record<string, unknown>>('entry-migration-005').map((row) => ({ ...row })),
      [
        { signal_type: 'symbol', normalized_value: 'migrationhooksentinel' },
        { signal_type: 'tag', normalized_value: 'migration-tag' },
      ],
    );
  } finally {
    upgraded.close();
  }
});

test('migration 009 atomically removes stale unversioned signals and rolls back schema when rebuild fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-v9-projection-'));
  const oldMigrations = path.join(root, 'old-migrations');
  const newMigrations = path.join(root, 'new-migrations');
  await Promise.all([oldMigrations, newMigrations].map((directory) => mkdir(directory)));
  const migrationNames = await readdir(currentMigrations);
  for (let version = 1; version <= 9; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationNames.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    if (version <= 8) await copyFile(path.join(currentMigrations, name), path.join(oldMigrations, name));
    await copyFile(path.join(currentMigrations, name), path.join(newMigrations, name));
  }

  const databasePath = path.join(root, 'data.sqlite3');
  const initial = openConnection(databasePath);
  let entryId: string;
  try {
    assert.deepEqual(migrateDatabase(initial, oldMigrations).applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    const entry = recordEntry(initial, {
      workspace: 'project:v8-unversioned-projection',
      kind: 'lesson',
      title: 'Unversioned legacy signal',
      body: 'The v9 rebuild must stop treating this arbitrary scope key as typed metadata.',
      scope: { signals: { symbols: ['StaleUnversionedSignal'] } },
    });
    entryId = entry.id;
    initial.prepare(`
      INSERT INTO entry_search_signals (entry_id, signal_type, normalized_value)
      VALUES (?, 'symbol', 'staleunversionedsignal')
    `).run(entry.id);
    initial.exec(`
      CREATE TRIGGER fail_migration_009_projection_rebuild
      BEFORE DELETE ON entry_search_signals
      WHEN OLD.normalized_value = 'staleunversionedsignal'
      BEGIN
        SELECT RAISE(ABORT, 'injected migration 009 projection rebuild failure');
      END;
    `);
  } finally {
    initial.close();
  }

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: newMigrations }),
    /injected migration 009 projection rebuild failure/u,
  );
  const rolledBack = openConnection(databasePath);
  try {
    assert.equal(rolledBack.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    assert.equal(
      rolledBack.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'external_skills'").get(),
      undefined,
    );
    assert.equal(
      rolledBack.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_task_skill_discovery_attempts'").get(),
      undefined,
    );
    assert.equal(rolledBack.prepare(`
      SELECT COUNT(*) AS count
        FROM entry_search_signals
       WHERE entry_id = ? AND signal_type = 'symbol' AND normalized_value = 'staleunversionedsignal'
    `).get<{ count: number }>(entryId)?.count, 1);
    rolledBack.exec('DROP TRIGGER fail_migration_009_projection_rebuild');
  } finally {
    rolledBack.close();
  }

  const retried = await initializeDatabase({ databasePath, migrationsDirectory: newMigrations });
  assert.deepEqual(retried.applied, [9]);
  const upgraded = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 9);
    assert.ok(upgraded.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'external_skills'").get());
    assert.ok(upgraded.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_task_skill_discovery_attempts'").get());
    assert.equal(upgraded.prepare(`
      SELECT COUNT(*) AS count
        FROM entry_search_signals
       WHERE entry_id = ? AND signal_type = 'symbol' AND normalized_value = 'staleunversionedsignal'
    `).get<{ count: number }>(entryId)?.count, 0);
  } finally {
    upgraded.close();
  }
});
