import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackup } from '../../src/commands/backup.js';
import { exportWorkspace } from '../../src/commands/export.js';
import { importWorkspace } from '../../src/commands/import.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { inspectEmbeddingHealth } from '../../src/embedding/diagnostics.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import { createEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateEmbeddingProfile, readEntryEmbedding, upsertEntryEmbedding } from '../../src/embedding/store.js';
import { listEmbeddingJobs } from '../../src/embedding/jobs.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';

const environment = {
  KIOKUKO_EMBEDDINGS: 'optional',
  KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
  KIOKUKO_EMBEDDING_MODEL: 'maintenance-model',
  KIOKUKO_EMBEDDING_DIMENSIONS: '3',
  KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
  KIOKUKO_VECTOR_BACKEND: 'javascript',
} satisfies NodeJS.ProcessEnv;
const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig(environment));
const profile = createEmbeddingProfile(config);
const timestamp = '2026-08-31T00:00:00.000Z';

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-embedding-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  const db = openConnection(databasePath);
  migrateDatabase(db);
  activateEmbeddingProfile(db, profile, { replace: false, now: timestamp });
  return { db, databasePath, directory };
}

function recordEmbeddedEntry(db: ReturnType<typeof openConnection>, workspace: string, id: string) {
  const entry = recordEntry(db, {
    workspace,
    kind: 'lesson',
    title: 'Portable canonical memory',
    body: 'Derived vectors are rebuilt from canonical memory after import.',
    createdBy: 'test',
  }, { idFactory: () => id, now: timestamp });
  upsertEntryEmbedding(db, {
    entryId: entry.id,
    profileId: profile.profileId,
    revision: entry.revision,
    contentHash: entry.contentHash,
    documentHash: 'b'.repeat(64),
    vector: [1, 0, 0],
    createdAt: timestamp,
  });
  return entry;
}

test('workspace export omits derived embedding rows and import enqueues regeneration', async () => {
  const source = await database('archive-source');
  const target = await database('archive-target');
  const workspace = 'project:embedding-archive';
  const archivePath = path.join(source.directory, 'workspace.jsonl');
  try {
    const entry = recordEmbeddedEntry(source.db, workspace, 'entry-embedding-archive');
    const archive = exportWorkspace(source.db, { workspace }).content;
    const records = archive.trimEnd().split('\n').map((line) => JSON.parse(line) as { type?: string });
    assert.deepEqual([...new Set(records.map((record) => record.type))].sort(), ['audit', 'checksum', 'entry', 'manifest']);
    assert.doesNotMatch(archive, /embedding_profiles|entry_embeddings|embedding_jobs|query_embeddings/u);

    await writeFile(archivePath, archive, 'utf8');
    const result = await importWorkspace(target.db, { input: archivePath });
    assert.equal(result.imported, 1);
    assert.deepEqual(listEmbeddingJobs(target.db).map((job) => ({ entryId: job.entryId, state: job.state })), [
      { entryId: entry.id, state: 'pending' },
    ]);
    assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM entry_embeddings').get<{ count: number }>()?.count, 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('full SQLite backup preserves vectors and restored doctor detects later corruption', async () => {
  const source = await database('backup-source');
  const backupPath = path.join(source.directory, 'full-backup.sqlite3');
  const entry = recordEmbeddedEntry(source.db, 'project:embedding-backup', 'entry-embedding-backup');
  try {
    await createBackup(backupPath, source.databasePath);
  } finally {
    source.db.close();
  }

  const restored = openConnection(backupPath);
  try {
    assert.deepEqual([...readEntryEmbedding(restored, { entryId: entry.id, profileId: profile.profileId })!.vector], [1, 0, 0]);
    const backend = new JavaScriptVectorSearchBackend();
    const healthy = inspectEmbeddingHealth(restored, environment, backend);
    assert.equal(healthy.check.ok, true);
    assert.equal(healthy.status.readyVectors, 1);

    const mismatched = inspectEmbeddingHealth(restored, {
      ...environment,
      KIOKUKO_EMBEDDING_MODEL: 'different-model',
    }, backend);
    assert.equal(mismatched.check.ok, false);
    assert.ok(mismatched.check.count > 0);

    updateCandidateEntry(restored, {
      workspace: entry.workspace,
      entryId: entry.id,
      expectedRevision: entry.revision,
      kind: entry.kind,
      title: 'Updated canonical memory',
      body: entry.body,
      createdBy: 'test',
      now: '2026-08-31T00:00:01.000Z',
    });
    const stale = inspectEmbeddingHealth(restored, environment, backend);
    assert.equal(stale.status.staleVectors, 1);
    assert.equal(stale.status.missingVectors, 1);

    restored.prepare('UPDATE entry_embeddings SET vector_hash = ? WHERE entry_id = ?').run('c'.repeat(64), entry.id);
    const corrupt = inspectEmbeddingHealth(restored, environment, backend);
    assert.equal(corrupt.check.ok, false);
    assert.ok(corrupt.check.count > 0);
  } finally {
    restored.close();
  }
});
