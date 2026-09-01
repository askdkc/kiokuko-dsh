import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupGlobalClients } from '../../src/commands/setup.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

test('setup backs up an existing database before applying pending migrations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-setup-upgrade-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const oldMigrations = path.join(root, 'old-migrations');
  const currentMigrations = path.join(root, 'current-migrations');
  await Promise.all([home, oldMigrations, currentMigrations].map((directory) => mkdir(directory, { recursive: true })));
  const initialSql = `
    CREATE TABLE setup_upgrade_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE repositories (
      repository_id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      remote_fingerprint TEXT,
      binding_schema_version INTEGER NOT NULL,
      agent_template_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE TABLE repository_locations (
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
      canonical_root TEXT NOT NULL UNIQUE,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, canonical_root)
    );
  `;
  await writeFile(path.join(oldMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(currentMigrations, '001_initial.sql'), initialSql);
  await writeFile(path.join(currentMigrations, '002_upgrade.sql'), 'ALTER TABLE setup_upgrade_data ADD COLUMN upgraded INTEGER NOT NULL DEFAULT 1;\n');
  const databasePath = path.join(data, 'kiokuko', 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database, oldMigrations);
    database.prepare('INSERT INTO setup_upgrade_data (id, value) VALUES (1, ?)').run('preserved');
  } finally {
    database.close();
  }

  const result = await setupGlobalClients({
    clients: ['opencode'],
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath,
    migrationsDirectory: currentMigrations,
  });
  assert.deepEqual(result.appliedMigrations, [2]);
  assert.notEqual(result.databaseBackupPath, null);
  await access(result.databaseBackupPath!);

  const backup = openConnection(result.databaseBackupPath!, { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT value FROM setup_upgrade_data WHERE id = 1').get<{ value: string }>()?.value, 'preserved');
    assert.equal(backup.prepare("SELECT 1 AS present FROM pragma_table_info('setup_upgrade_data') WHERE name = 'upgraded'").get(), undefined);
  } finally {
    backup.close();
  }

  const upgraded = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(upgraded.prepare('SELECT value, upgraded FROM setup_upgrade_data WHERE id = 1').get<{ value: string; upgraded: number }>()?.upgraded, 1);
  } finally {
    upgraded.close();
  }
});

test('setup rejects a future-version database before writing client configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-setup-future-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const migrations = path.join(root, 'migrations');
  await Promise.all([home, migrations].map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(path.join(migrations, '001_initial.sql'), 'CREATE TABLE future_setup_data (id INTEGER PRIMARY KEY);\n');
  const databasePath = path.join(data, 'kiokuko', 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database, migrations);
    database.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (2, '002_future.sql', ?, ?)
    `).run('f'.repeat(64), '2026-08-21T00:00:00.000Z');
  } finally {
    database.close();
  }
  const before = await readFile(databasePath);

  await assert.rejects(setupGlobalClients({
    clients: ['opencode'],
    platform: 'linux',
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath,
    migrationsDirectory: migrations,
  }), (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /newer/i.test((error as Error).message));

  assert.deepEqual(await readFile(databasePath), before);
  await assert.rejects(access(path.join(config, 'opencode', 'opencode.json')));
});
