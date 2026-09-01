import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import { createEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateEmbeddingProfile, upsertEntryEmbedding } from '../../src/embedding/store.js';
import type { HybridSearchRuntime } from '../../src/memory/hybrid-retrieval.js';
import { recordEntry } from '../../src/memory/entries.js';
import { retrieveFederatedMemory } from '../../src/memory/federated-retrieval.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';

const timestamp = '2026-08-30T00:00:00.000Z';

function profile() {
  return createEmbeddingProfile(requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: 'semantic-federated-model',
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
  })));
}

function runtime(active: ReturnType<typeof profile>): HybridSearchRuntime {
  const backend = new JavaScriptVectorSearchBackend();
  return {
    semantic: {
      backend,
      query: {
        profileId: active.profileId,
        dimensions: 3,
        vector: new Float32Array([1, 0, 0]),
        vectorHash: 'q'.repeat(64),
        backendId: backend.id,
        distanceCeiling: active.identity.distanceCeiling,
      },
    },
  };
}

test('discovers a compatible ecosystem workspace from semantic hits without structured signals', async () => {
  const database = openConnection(':memory:');
  const sourceRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-semantic-federated-source-'));
  const targetRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-semantic-federated-target-'));
  execFileSync('git', ['init', '-q', sourceRoot]);
  execFileSync('git', ['init', '-q', targetRoot]);
  await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  await writeFile(path.join(targetRoot, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  try {
    migrateDatabase(database);
    const source = await resolveProjectWorkspace(database, sourceRoot);
    const target = await resolveProjectWorkspace(database, targetRoot);
    assert.ok(source);
    assert.ok(target);
    const active = profile();
    activateEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Durable release guidance',
      body: 'Use a reversible rollout and verify the rollback boundary.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        applicability: { languages: ['TypeScript'] },
      }),
    }, { idFactory: () => 'entry-semantic-federated-only', now: timestamp });
    database.prepare('DELETE FROM entry_search_signals WHERE entry_id = ?').run(entry.id);
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: active.profileId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      documentHash: 'd'.repeat(64),
      vector: [1, 0, 0],
      createdAt: timestamp,
    });

    const result = await retrieveFederatedMemory(database, {
      project: target,
      scope: 'ecosystem',
      query: 'unrelated semantic rollout paraphrase',
      limit: 5,
    }, runtime(active));
    const item = result.ecosystem?.items.find((candidate) => candidate.id === entry.id);
    assert.equal(item?.origin, 'ecosystem');
    assert.equal(item?.sourceWorkspace, source.workspace);
    assert.equal(item?.selectionReasons.includes('semantic_match'), true);
  } finally {
    database.close();
  }
});
