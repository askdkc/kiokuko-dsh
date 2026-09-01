import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createModelManifest } from '../../src/embedding/model-manifest.js';
import { runEmbeddingSetup } from '../../src/embedding/setup-service.js';

function fakeProvider() {
  return {
    profile: { providerKind: 'local-transformers' } as never,
    embed: async (inputs: readonly string[]) => inputs.map(() => {
      const vector = new Float32Array(384);
      vector[0] = 1;
      return vector;
    }),
  };
}

test('dry-run performs no setup writes', async () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const before = database.prepare('SELECT COUNT(*) AS count FROM embedding_setup_runs').get<{ count: number }>()?.count;
    const result = await runEmbeddingSetup(database, { presetId: 'local-small', confirmed: false, dryRun: true, offline: false, replace: false });
    assert.equal(result.semanticEnabled, false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM embedding_setup_runs').get<{ count: number }>()?.count, before);
  } finally {
    database.close();
  }
});

test('setup activates the v2 profile, queues current entries, and drains them', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'kiokuko-embedding-setup-'));
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    recordEntry(database, {
      workspace: 'project:setup',
      kind: 'lesson',
      title: 'Idempotent jobs',
      body: 'Duplicate requests do not corrupt results.',
      createdBy: 'setup-test',
    }, { idFactory: () => 'entry-setup', now: '2026-08-31T00:00:00.000Z' });
    const installedDirectory = path.join(dataDirectory, 'models', 'embeddings', 'local-small', LOCAL_SMALL_PRESET.revision);
    const result = await runEmbeddingSetup(database, { presetId: 'local-small', confirmed: true, dryRun: false, offline: false, replace: false }, {
      env: { KIOKUKO_DATA_DIR: dataDirectory },
      provider: fakeProvider(),
      installer: async () => ({
        installation: 'installed',
        directory: installedDirectory,
        relativePath: 'models/embeddings/local-small/revision',
        totalBytes: LOCAL_SMALL_PRESET.files.reduce((sum, file) => sum + file.size, 0),
        manifestHash: createModelManifest(LOCAL_SMALL_PRESET).artifactManifestHash,
      }),
    });
    assert.equal(result.semanticEnabled, true);
    assert.equal(result.embeddings.eligible, 1);
    assert.equal(result.embeddings.completed, 1);
    assert.equal(result.embeddings.remaining, 0);
    assert.equal(database.prepare('SELECT schema_version, provider_kind FROM embedding_profiles').get<{ schema_version: number; provider_kind: string }>()?.schema_version, 2);
    assert.equal(database.prepare('SELECT setup_state FROM embedding_settings').get<{ setup_state: string }>()?.setup_state, 'ready');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_embeddings').get<{ count: number }>()?.count, 1);
  } finally {
    database.close();
  }
});
