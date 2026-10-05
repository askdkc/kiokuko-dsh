import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NodeSqliteAdapter } from '../../../src/db/adapter.js';
import { runBackupWorker } from '../../../src/db/backup-worker.js';
import { createSerializedBackupArtifact } from '../../../src/db/upgrade-backup.js';

test('backup worker drains large stdin while the parent remains responsive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-worker-flow-'));
  const marker = join(root, 'parent-ready');
  const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
  const expected = createHash('sha256').update(bytes).digest('hex');
  const script = `
    const fs = require('node:fs');
    const bytes = fs.readFileSync(0);
    const wait = setInterval(() => {
      if (!fs.existsSync(process.argv[1])) return;
      clearInterval(wait);
      process.stdout.write(require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
    }, 5);
  `;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = runBackupWorker({ directory: root, script, request: marker, bytes, deadlineMs: 5000, outputLimitBytes: 1024 });
    const wake = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { void writeFile(marker, 'ready').then(() => resolve(), reject); }, 20);
    });
    const [output] = await Promise.all([result, wake]);
    assert.equal(output.toString(), expected);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
});

test('backup worker deadline kills and reaps the child before rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-worker-deadline-'));
  const pidFile = join(root, 'pid');
  try {
    await assert.rejects(runBackupWorker({ directory: root,
      script: "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);",
      request: pidFile, bytes: Buffer.alloc(0), deadlineMs: 1000, outputLimitBytes: 1024 }), { code: 'ETIMEDOUT' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup worker bounds stdout and stderr together', async () => {
  await assert.rejects(runBackupWorker({ directory: tmpdir(),
    script: "process.stdout.write('a'.repeat(17)); process.stderr.write('b'.repeat(17));",
    request: '', bytes: Buffer.alloc(0), deadlineMs: 5000, outputLimitBytes: 32 }), { code: 'ENOBUFS' });
});

test('backup worker propagates spawn and early input failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-worker-failure-'));
  try {
    await assert.rejects(runBackupWorker({ directory: join(root, 'missing'), script: '', request: '',
      bytes: Buffer.alloc(0), deadlineMs: 5000, outputLimitBytes: 1024 }), { code: 'ENOENT' });
    await assert.rejects(runBackupWorker({ directory: root, script: 'process.exit(7)', request: '',
      bytes: Buffer.alloc(4 * 1024 * 1024), deadlineMs: 5000, outputLimitBytes: 1024 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup worker excludes inherited application environment', async () => {
  const previous = process.env.KIOKUKO_BACKUP_ENV_CANARY;
  process.env.KIOKUKO_BACKUP_ENV_CANARY = 'parent-only';
  try {
    const result = await runBackupWorker({ directory: tmpdir(),
      script: "process.stdout.write(JSON.stringify({canary: process.env.KIOKUKO_BACKUP_ENV_CANARY ?? null}));",
      request: '', bytes: Buffer.alloc(0), deadlineMs: 5000, outputLimitBytes: 1024 });
    assert.deepEqual(JSON.parse(result.toString()), { canary: null });
  } finally {
    if (previous === undefined) delete process.env.KIOKUKO_BACKUP_ENV_CANARY;
    else process.env.KIOKUKO_BACKUP_ENV_CANARY = previous;
  }
});

async function snapshotFixture(operation: (root: string, source: NodeSqliteAdapter, original: Uint8Array) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bound-backup-'));
  const database = new DatabaseSync(':memory:');
  const source = new NodeSqliteAdapter(':memory:', database);
  try {
    source.exec('CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES(zeroblob(2 * 1024 * 1024));');
    await operation(root, source, source.serializeDatabase());
  } finally { source.close(); await rm(root, { recursive: true, force: true }); }
}

test('large serialized backup retains byte and descriptor attestations', async () => {
  await snapshotFixture(async (root, source, original) => {
    const backup = await createSerializedBackupArtifact(source, join(root, 'backup.sqlite3'));
    const bytes = await readFile(backup.path);
    assert.ok(bytes.equals(Buffer.from(original)));
    assert.equal(backup.artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(backup.artifact.size, BigInt(bytes.length));
    assert.equal(backup.artifact.linkCount, 1n);
    if (process.platform !== 'win32') assert.equal(backup.artifact.mode & 0o777n, 0o600n);
    assert.deepEqual(source.serializeDatabase(), original);
  });
});

test('backup refuses existing files and symbolic links without changing source or target', async () => {
  await snapshotFixture(async (root, source, original) => {
    const target = join(root, 'existing.sqlite3');
    await writeFile(target, 'retain');
    await assert.rejects(createSerializedBackupArtifact(source, target), /already exists/);
    if (process.platform !== 'win32') {
      const link = join(root, 'linked.sqlite3');
      await symlink(target, link);
      await assert.rejects(createSerializedBackupArtifact(source, link));
    }
    assert.equal(await readFile(target, 'utf8'), 'retain');
    assert.deepEqual(source.serializeDatabase(), original);
  });
});

test('backup rejects a directory replaced before the worker starts', async () => {
  await snapshotFixture(async (root, source, original) => {
    const directory = join(root, 'bound');
    await mkdir(directory);
    await assert.rejects(createSerializedBackupArtifact(source, join(directory, 'backup.sqlite3'), {
      async afterDirectoryBound() { await rename(directory, join(root, 'moved')); await mkdir(directory); },
    }), /directory identity changed/);
    await assert.rejects(readFile(join(directory, 'backup.sqlite3')), { code: 'ENOENT' });
    assert.deepEqual(source.serializeDatabase(), original);
  });
});

test('backup rejects an artifact modified after writer attestation', async () => {
  await snapshotFixture(async (root, source, original) => {
    await assert.rejects(createSerializedBackupArtifact(source, join(root, 'backup.sqlite3'), {
      async afterArtifactWritten(output) { await writeFile(output, 'changed'); },
    }));
    assert.deepEqual(source.serializeDatabase(), original);
  });
});
