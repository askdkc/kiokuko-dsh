import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { createBackup } from '../../src/commands/backup.js';
import { databaseFileIdentity, openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPreMigrationBackup } from '../../src/db/upgrade-backup.js';
import { KiokukoError } from '../../src/errors.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-init-upgrade-${prefix}-`));
}

async function migrationDirectory(root: string, includeSecond: boolean): Promise<string> {
  const directory = path.join(root, includeSecond ? 'new-migrations' : 'old-migrations');
  await mkdir(directory);
  await writeFile(path.join(directory, '001_initial.sql'), `
    CREATE TABLE preserved_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (includeSecond) {
    await writeFile(path.join(directory, '002_upgrade.sql'), `
      CREATE TABLE upgraded_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  return directory;
}

async function createVersionOneDatabase(root: string): Promise<{ databasePath: string; oldMigrations: string }> {
  const oldMigrations = await migrationDirectory(root, false);
  const databasePath = path.join(root, 'data.sqlite3');
  const database = openConnection(databasePath);
  try {
    migrateDatabase(database, oldMigrations);
    database.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('keep me');
  } finally {
    database.close();
  }
  return { databasePath, oldMigrations };
}

test('initializeDatabase creates and verifies a pre-migration backup before upgrading an existing database', async () => {
  const root = await temporaryDirectory('backup');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);

  const result = await initializeDatabase({ databasePath, migrationsDirectory: newMigrations });
  assert.deepEqual(result.applied, [2]);
  assert.match(
    result.backupPath ?? '',
    /db-data-sqlite3-[a-f0-9]{16}\.pre-upgrade-v1-to-v2-[a-zA-Z0-9_-]+\.sqlite3$/u,
  );
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.backupPath!)).mode & 0o077, 0);
  }
  assert.deepEqual(await readdir(path.dirname(result.backupPath!)), [path.basename(result.backupPath!)]);

  const backup = openConnection(result.backupPath!, { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
    assert.equal(backup.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.equal(backup.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(backup.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'").get(), undefined);
  } finally {
    backup.close();
  }

  const upgraded = openConnection(databasePath);
  try {
    assert.equal(upgraded.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.equal(upgraded.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'").get<{ present: number }>()?.present, 1);
  } finally {
    upgraded.close();
  }
});

test('initializeDatabase upgrades a restored standalone backup without a false data-version conflict', async () => {
  const root = await temporaryDirectory('restored-backup');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const standaloneBackup = path.join(root, 'standalone-backup.sqlite3');

  await createBackup(standaloneBackup, databasePath);
  await copyFile(standaloneBackup, databasePath);
  await Promise.all([
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ].map((sidecar) => rm(sidecar, { force: true })));

  const result = await initializeDatabase({ databasePath, migrationsDirectory: newMigrations });
  assert.deepEqual(result.applied, [2]);
});

test('initializeDatabase preserves stale WAL sidecars left beside a restored standalone backup', async () => {
  const root = await temporaryDirectory('restored-backup-sidecars');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const standaloneBackup = path.join(root, 'standalone-backup.sqlite3');

  await createBackup(standaloneBackup, databasePath);
  await copyFile(standaloneBackup, databasePath);
  await Promise.all([
    writeFile(`${databasePath}-wal`, 'stale WAL sidecar'),
    writeFile(`${databasePath}-shm`, 'stale SHM sidecar'),
  ]);

  const result = await initializeDatabase({ databasePath, migrationsDirectory: newMigrations });
  assert.deepEqual(result.applied, [2]);
  const names = await readdir(root);
  assert.equal(names.filter((name) => name.startsWith('data.sqlite3-wal.before-setup-')).length, 1);
  assert.equal(names.filter((name) => name.startsWith('data.sqlite3-shm.before-setup-')).length, 1);
});

test('pre-migration backup serializes the already-open source across a rename-and-restore ABA', {
  skip: process.platform === 'win32' ? 'Windows prevents renaming the open source database' : false,
}, async () => {
  const root = await temporaryDirectory('backup-source-aba');
  const { databasePath, oldMigrations } = await createVersionOneDatabase(root);
  const originalPath = path.join(root, 'data.original.sqlite3');
  const replacementPath = path.join(root, 'data.replacement.sqlite3');
  const originalIdentity = databaseFileIdentity(databasePath);
  const source = openConnection(databasePath, { readOnly: true, expectedFileIdentity: originalIdentity });
  let created: Awaited<ReturnType<typeof createPreMigrationBackup>> | undefined;
  try {
    created = await createPreMigrationBackup(source, databasePath, 1, 2, {
      async beforeSerialization() {
        await rename(databasePath, originalPath);
        const replacement = openConnection(databasePath);
        try {
          migrateDatabase(replacement, oldMigrations);
          replacement.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('replacement');
        } finally {
          replacement.close();
        }
      },
      async afterArtifactWritten() {
        await rename(databasePath, replacementPath);
        await rename(originalPath, databasePath);
      },
    });
  } finally {
    source.close();
  }
  assert.ok(created !== undefined);
  assert.deepEqual(databaseFileIdentity(databasePath), originalIdentity);

  const backup = openConnection(created.path, { readOnly: true });
  try {
    assert.equal(
      backup.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value,
      'keep me',
    );
  } finally {
    backup.close();
  }
  const replacement = openConnection(replacementPath, { readOnly: true });
  try {
    assert.equal(
      replacement.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value,
      'replacement',
    );
  } finally {
    replacement.close();
  }
});

test('initializeDatabase applies the exact migration snapshot loaded before backup', async () => {
  const root = await temporaryDirectory('migration-snapshot');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const originalPath = path.join(newMigrations, '002_upgrade.sql');
  const originalSql = await readFile(originalPath, 'utf8');
  const originalChecksum = createHash('sha256').update(originalSql).digest('hex');

  const result = await initializeDatabase(
    { databasePath, migrationsDirectory: newMigrations },
    {
      async afterPreflight() {
        await rename(originalPath, path.join(newMigrations, '002_upgrade.original'));
        await writeFile(path.join(newMigrations, '002_replaced.sql'), `
          CREATE TABLE replacement_data (id INTEGER PRIMARY KEY);
        `);
      },
    },
  );

  assert.deepEqual(result.applied, [2]);
  const upgraded = openConnection(databasePath, { readOnly: true });
  try {
    assert.ok(upgraded.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get());
    assert.equal(upgraded.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'replacement_data'",
    ).get(), undefined);
    assert.deepEqual(
      { ...upgraded.prepare('SELECT name, checksum FROM schema_migrations WHERE version = 2').get() },
      { name: '002_upgrade.sql', checksum: originalChecksum },
    );
  } finally {
    upgraded.close();
  }
});

test('initializeDatabase rejects in-place backup tampering before writable database open', async () => {
  const root = await temporaryDirectory('backup-content-tamper');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const backups = await readdir(path.join(root, 'backups'));
          assert.equal(backups.length, 1);
          await writeFile(path.join(root, 'backups', backups[0]!), 'TAMPERED BACKUP');
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Pre-migration backup changed/u.test(error.message),
  );

  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a handoff replacement and never deletes the replacement', async () => {
  const root = await temporaryDirectory('backup-handoff-replacement');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const replacement = Buffer.from('handoff replacement must survive');
  let backupPath: string | undefined;
  let attestedPath: string | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterBackupArtifactWritten(output) {
          backupPath = output;
          attestedPath = `${output}.attested`;
          await rename(output, attestedPath);
          await writeFile(output, replacement, { flag: 'wx' });
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'DATABASE_ERROR'
      && (error as Error & { cause?: unknown }).cause instanceof KiokukoError
      && ((error as Error & { cause: KiokukoError }).cause.code === 'INTEGRITY_ERROR'
        || (error as Error & { cause: KiokukoError }).cause.code === 'CONFLICT'),
  );

  assert.ok(backupPath !== undefined);
  assert.ok(attestedPath !== undefined);
  assert.deepEqual(await readFile(backupPath), replacement);
  assert.ok((await stat(attestedPath)).size > 0);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects in-place artifact tampering during attested handoff', async () => {
  const root = await temporaryDirectory('backup-handoff-content');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const databaseBefore = await readFile(databasePath);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterBackupArtifactWritten(output) {
          await writeFile(output, 'tampered after writer attestation');
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'DATABASE_ERROR'
      && (error as Error & { cause?: unknown }).cause instanceof KiokukoError
      && ((error as Error & { cause: KiokukoError }).cause.code === 'INTEGRITY_ERROR'
        || (error as Error & { cause: KiokukoError }).cause.code === 'CONFLICT'),
  );

  assert.deepEqual(await readFile(databasePath), databaseBefore);
});

test('initializeDatabase rejects replacement of the bound backup path before writable database open', async () => {
  const root = await temporaryDirectory('backup-path-replacement');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const backupDirectory = path.join(root, 'backups');
          const backups = await readdir(backupDirectory);
          assert.equal(backups.length, 1);
          const backupPath = path.join(backupDirectory, backups[0]!);
          await rename(backupPath, `${backupPath}.original`);
          await writeFile(backupPath, 'REPLACEMENT BACKUP');
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Pre-migration backup changed/u.test(error.message),
  );

  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a backup whose private mode changes before migration', {
  skip: process.platform === 'win32' ? 'Windows mode bits do not provide POSIX permission semantics' : false,
}, async () => {
  const root = await temporaryDirectory('backup-mode-tamper');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  let backupPath: string | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const backups = await readdir(path.join(root, 'backups'));
          assert.equal(backups.length, 1);
          backupPath = path.join(root, 'backups', backups[0]!);
          await chmod(backupPath, 0o644);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Pre-migration backup changed/u.test(error.message),
  );

  assert.ok(backupPath !== undefined);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o644);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects symlink substitution of the bound backup path', async () => {
  const root = await temporaryDirectory('backup-symlink-tamper');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  let backupPath: string | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const backups = await readdir(path.join(root, 'backups'));
          assert.equal(backups.length, 1);
          backupPath = path.join(root, 'backups', backups[0]!);
          const realBackupPath = `${backupPath}.real`;
          await rename(backupPath, realBackupPath);
          await symlink(realBackupPath, backupPath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Pre-migration backup changed/u.test(error.message),
  );

  assert.ok(backupPath !== undefined);
  assert.equal((await lstat(backupPath)).isSymbolicLink(), true);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects symlink substitution of the bound backup directory before migration', async () => {
  const root = await temporaryDirectory('backup-directory-post-create-symlink');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const backupDirectory = path.join(root, 'backups');
  const displacedBackupDirectory = path.join(root, 'backups-displaced');

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const backups = await readdir(backupDirectory);
          assert.equal(backups.length, 1);
          await rename(backupDirectory, displacedBackupDirectory);
          await symlink(
            displacedBackupDirectory,
            backupDirectory,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /backup directory changed/u.test(error.message),
  );

  assert.equal((await lstat(backupDirectory)).isSymbolicLink(), true);
  assert.equal((await readdir(displacedBackupDirectory)).length, 1);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rolls back migration SQL when the bound backup changes before commit', async () => {
  const root = await temporaryDirectory('backup-precommit-tamper');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  let boundBackupPath: string | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const backups = await readdir(path.join(root, 'backups'));
          assert.equal(backups.length, 1);
          boundBackupPath = path.join(root, 'backups', backups[0]!);
        },
        beforeCommit() {
          assert.ok(boundBackupPath !== undefined);
          writeFileSync(boundBackupPath, 'TAMPERED BEFORE COMMIT');
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Pre-migration backup changed/u.test(error.message),
  );

  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a database that appears after an absent preflight without mutation', async () => {
  const root = await temporaryDirectory('database-appearance');
  const databasePath = path.join(root, 'data.sqlite3');
  const oldMigrations = await migrationDirectory(root, false);
  const newMigrations = await migrationDirectory(root, true);
  let before: Buffer | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          const appeared = openConnection(databasePath);
          try {
            assert.deepEqual(migrateDatabase(appeared, oldMigrations).applied, [1]);
            appeared.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('appeared intact');
            appeared.exec('PRAGMA journal_mode = DELETE');
          } finally {
            appeared.close();
          }
          before = await readFile(databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /appeared after the existence preflight/u.test(error.message),
  );

  assert.ok(before !== undefined);
  assert.deepEqual(await readFile(databasePath), before);
  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.deepEqual(
      unchanged.prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all<Record<string, unknown>>()
        .map((row) => ({ ...row })),
      [{ version: 1, name: '001_initial.sql' }],
    );
    assert.equal(unchanged.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'appeared intact');
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a concurrent migration even when the writable plan is already current', async () => {
  const root = await temporaryDirectory('concurrent-completion');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        afterPreflight() {
          const concurrent = openConnection(databasePath);
          try {
            assert.deepEqual(migrateDatabase(concurrent, newMigrations).applied, [2]);
            concurrent.prepare('UPDATE preserved_data SET value = ? WHERE id = 1').run('concurrent value');
          } finally {
            concurrent.close();
          }
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /database changed while setup was preparing it/u.test(error.message),
  );

  const live = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(live.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'concurrent value');
    assert.ok(live.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get());
  } finally {
    live.close();
  }
  const backups = await readdir(path.join(root, 'backups'));
  assert.equal(backups.length, 1);
  const backup = openConnection(path.join(root, 'backups', backups[0]!), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
    assert.equal(backup.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    backup.close();
  }
});

test('initializeDatabase rejects replacement of the backed-up database path before writable open', async () => {
  const root = await temporaryDirectory('database-replacement');
  const { databasePath, oldMigrations } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const replacementPath = path.join(root, 'replacement.sqlite3');
  const movedOriginalPath = path.join(root, 'original.sqlite3');
  const replacement = openConnection(replacementPath);
  try {
    assert.deepEqual(migrateDatabase(replacement, oldMigrations).applied, [1]);
    replacement.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('replacement intact');
    replacement.exec('PRAGMA journal_mode = DELETE');
  } finally {
    replacement.close();
  }
  const original = openConnection(databasePath);
  try {
    original.exec('PRAGMA journal_mode = DELETE');
  } finally {
    original.close();
  }
  const replacementBefore = await readFile(replacementPath);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPreflight() {
          await rename(databasePath, movedOriginalPath);
          await rename(replacementPath, databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /file identity changed/u.test(error.message),
  );

  assert.deepEqual(await readFile(databasePath), replacementBefore);
  const live = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(live.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.equal(live.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'replacement intact');
    assert.equal(live.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    live.close();
  }
  const backups = await readdir(path.join(root, 'backups'));
  assert.equal(backups.length, 1);
  const backup = openConnection(path.join(root, 'backups', backups[0]!), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
  } finally {
    backup.close();
  }
});

test('initializeDatabase rejects replacement of its reserved fresh path before SQLite opens it', async () => {
  const root = await temporaryDirectory('reserved-path-replacement');
  const databasePath = path.join(root, 'data.sqlite3');
  const reservedPath = path.join(root, 'reserved-empty.sqlite3');
  const oldMigrations = await migrationDirectory(root, false);
  const newMigrations = await migrationDirectory(root, true);
  let replacementBefore: Buffer | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterPathReserved() {
          await rename(databasePath, reservedPath);
          const replacement = openConnection(databasePath);
          try {
            assert.deepEqual(migrateDatabase(replacement, oldMigrations).applied, [1]);
            replacement.prepare('INSERT INTO preserved_data (id, value) VALUES (1, ?)').run('reserved replacement intact');
            replacement.exec('PRAGMA journal_mode = DELETE');
          } finally {
            replacement.close();
          }
          replacementBefore = await readFile(databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /file identity changed/u.test(error.message),
  );

  assert.ok(replacementBefore !== undefined);
  assert.deepEqual(await readFile(databasePath), replacementBefore);
  assert.equal((await readdir(root)).includes('backups'), false);
  const live = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(live.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
    assert.equal(live.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'reserved replacement intact');
    assert.equal(live.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    live.close();
  }
});

test('initializeDatabase rejects persistent metadata written to the reserved inode before SQLite opens it', async () => {
  const root = await temporaryDirectory('reserved-inode-metadata');
  const databasePath = path.join(root, 'data.sqlite3');
  const migrations = await migrationDirectory(root, false);
  let rivalBefore: Buffer | undefined;

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: migrations },
      {
        async afterPathReserved() {
          const rival = openConnection(databasePath);
          try {
            rival.exec('PRAGMA user_version = 77; PRAGMA application_id = 1234; PRAGMA journal_mode = DELETE;');
          } finally {
            rival.close();
          }
          rivalBefore = await readFile(databasePath);
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /Reserved database file changed/u.test(error.message),
  );

  assert.ok(rivalBefore !== undefined);
  assert.deepEqual(await readFile(databasePath), rivalBefore);
  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, 77);
    assert.equal(unchanged.prepare('PRAGMA application_id').get<{ application_id: number }>()?.application_id, 1234);
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a commit to the fresh inode before acquiring its write lock', async () => {
  const root = await temporaryDirectory('fresh-inode-commit');
  const databasePath = path.join(root, 'data.sqlite3');
  const migrations = await migrationDirectory(root, false);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: migrations },
      {
        afterWritableOpen() {
          const rival = openConnection(databasePath);
          try {
            rival.exec('PRAGMA user_version = 77; PRAGMA application_id = 1234;');
          } finally {
            rival.close();
          }
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /changed before its write lock/u.test(error.message),
  );

  assert.equal((await readdir(root)).includes('backups'), false);
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version, 77);
    assert.equal(unchanged.prepare('PRAGMA application_id').get<{ application_id: number }>()?.application_id, 1234);
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('expected database identity fails before writable chmod or journal configuration', async () => {
  const root = await temporaryDirectory('connection-identity');
  const originalPath = path.join(root, 'data.sqlite3');
  const movedOriginalPath = path.join(root, 'moved-original.sqlite3');
  const migrations = await migrationDirectory(root, false);
  const original = openConnection(originalPath);
  try {
    assert.deepEqual(migrateDatabase(original, migrations).applied, [1]);
    original.exec('PRAGMA journal_mode = DELETE');
  } finally {
    original.close();
  }
  const expectedIdentity = databaseFileIdentity(originalPath);
  await rename(originalPath, movedOriginalPath);

  const replacement = openConnection(originalPath);
  try {
    assert.deepEqual(migrateDatabase(replacement, migrations).applied, [1]);
    replacement.exec('PRAGMA journal_mode = DELETE');
  } finally {
    replacement.close();
  }
  if (process.platform !== 'win32') await chmod(originalPath, 0o644);
  const replacementBefore = await readFile(originalPath);

  assert.throws(
    () => openConnection(originalPath, { expectedFileIdentity: expectedIdentity }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && /file identity changed/u.test(error.message),
  );
  assert.deepEqual(await readFile(originalPath), replacementBefore);
  if (process.platform !== 'win32') {
    assert.equal((await stat(originalPath)).mode & 0o777, 0o644);
  }
  const unchanged = openConnection(originalPath, { readOnly: true });
  try {
    assert.equal(unchanged.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>()?.journal_mode, 'delete');
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase aborts before migration when the pre-migration backup cannot be created', async () => {
  const root = await temporaryDirectory('backup-failure');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const blocker = 'blocks the backup directory';
  await writeFile(path.join(root, 'backups'), blocker);

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: newMigrations }),
    (error: unknown) => {
      assert.ok(error instanceof KiokukoError);
      assert.equal(error.code, 'DATABASE_ERROR');
      assert.equal(error.message, 'Could not create and verify the pre-migration backup; the database was not migrated');
      assert.deepEqual(error.details, {});
      assert.ok((error as Error & { cause?: unknown }).cause instanceof Error);
      return true;
    },
  );
  assert.equal(await readFile(path.join(root, 'backups'), 'utf8'), blocker);

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 1);
    assert.equal(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'").get(), undefined);
    assert.equal(database.prepare('SELECT value FROM preserved_data WHERE id = 1').get<{ value: string }>()?.value, 'keep me');
  } finally {
    database.close();
  }
});

test('initializeDatabase rejects a symlinked backup directory without writing outside the database directory', async () => {
  const root = await temporaryDirectory('backup-directory-symlink');
  const outside = await temporaryDirectory('backup-directory-outside');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  if (process.platform !== 'win32') await chmod(outside, 0o755);
  await symlink(outside, path.join(root, 'backups'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: newMigrations }),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'DATABASE_ERROR'
      && /pre-migration backup/u.test(error.message),
  );

  assert.deepEqual(await readdir(outside), []);
  if (process.platform !== 'win32') {
    assert.equal((await stat(outside)).mode & 0o777, 0o755);
  }
  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects backup-directory replacement after binding without an outside write', {
  skip: process.platform === 'win32' ? 'Windows prevents renaming the held backup directory' : false,
}, async () => {
  const root = await temporaryDirectory('backup-directory-interposition');
  const outside = await temporaryDirectory('backup-directory-interposition-outside');
  const { databasePath } = await createVersionOneDatabase(root);
  const newMigrations = await migrationDirectory(root, true);
  const backupDirectory = path.join(root, 'backups');
  const displacedBackupDirectory = path.join(root, 'backups-displaced');
  const databaseBefore = await readFile(databasePath);
  const databaseModeBefore = (await stat(databasePath)).mode;
  await chmod(outside, 0o755);

  await assert.rejects(
    initializeDatabase(
      { databasePath, migrationsDirectory: newMigrations },
      {
        async afterBackupDirectoryBound() {
          await rename(backupDirectory, displacedBackupDirectory);
          await symlink(outside, backupDirectory, 'dir');
        },
      },
    ),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'DATABASE_ERROR'
      && /pre-migration backup/u.test(error.message),
  );

  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(displacedBackupDirectory), []);
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  assert.equal((await lstat(backupDirectory)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(databasePath), databaseBefore);
  assert.equal((await stat(databasePath)).mode, databaseModeBefore);

  const unchanged = openConnection(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      unchanged.prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all<{ version: number }>()
        .map((row) => row.version),
      [1],
    );
    assert.equal(unchanged.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'upgraded_data'",
    ).get(), undefined);
  } finally {
    unchanged.close();
  }
});

test('initializeDatabase rejects a future-version database before opening it for writes', async () => {
  const root = await temporaryDirectory('future-version');
  const { databasePath, oldMigrations } = await createVersionOneDatabase(root);
  const database = openConnection(databasePath);
  try {
    database.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (2, '002_future.sql', ?, ?)
    `).run('f'.repeat(64), '2026-08-21T00:00:00.000Z');
  } finally {
    database.close();
  }
  const before = await readFile(databasePath);

  await assert.rejects(
    initializeDatabase({ databasePath, migrationsDirectory: oldMigrations }),
    (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /newer/i.test((error as Error).message),
  );
  assert.deepEqual(await readFile(databasePath), before);
});
