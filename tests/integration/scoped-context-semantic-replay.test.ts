import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { queryScopedContext, queryScopedContextGated } from '../../src/context/scoped-broker.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { JavaScriptVectorSearchBackend } from '../../src/embedding/javascript-backend.js';
import { createEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateEmbeddingProfile, upsertEntryEmbedding } from '../../src/embedding/store.js';
import type { HybridSearchRuntime } from '../../src/memory/hybrid-retrieval.js';
import { recordEntry } from '../../src/memory/entries.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';

const timestamp = '2026-08-30T00:00:00.000Z';

function profile() {
  return createEmbeddingProfile(requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: 'semantic-scoped-model',
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
        vectorHash: 'r'.repeat(64),
        backendId: backend.id,
        distanceCeiling: active.identity.distanceCeiling,
      },
    },
  };
}

test('binds scoped replay to semantic query and projection state, then rejects a vector race', async () => {
  const database = openConnection(':memory:');
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-scoped-semantic-replay-'));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { typescript: '^5.0.0' } }));
  try {
    migrateDatabase(database);
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    const service = new AgentGatewayService(database, { now: () => timestamp });
    const taskProfile = {
      taskType: 'build' as const,
      target: 'semantic scoped replay',
      expected: 'vector state binding',
      constraints: null,
    };
    const opened = service.openRun({
      idempotencyKey: 'semantic-scoped-replay-run',
      request: {
        apiVersion: '1',
        workspace: project.workspace,
        client: { kind: 'semantic-scoped-replay-test' },
        task: {
          title: 'Semantic scoped replay',
          query: 'semantic scoped replay',
          profileHints: taskProfile,
        },
        captureProfile: 'minimal',
        coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
        metadata: {},
      },
    });
    const active = profile();
    activateEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Semantic scoped replay entry',
      body: 'The semantic query should select this entry and replay it exactly.',
    }, { idFactory: () => 'entry-semantic-scoped-replay', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: active.profileId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      documentHash: 'a'.repeat(64),
      vector: [1, 0, 0],
      createdAt: timestamp,
    });
    const query = {
      project,
      runId: opened.runId,
      task: 'semantic scoped replay',
      taskProfile,
      limit: 5,
      characterBudget: 1_000,
    };
    const prepared = runtime(active);
    const first = await queryScopedContext(database, query, prepared);
    assert.equal(first.policyVersion, 'context-ranking-v6');
    assert.equal(first.items[0]?.entryId, entry.id);
    assert.equal(first.items[0]?.selectionReasons.includes('semantic_match'), true);
    const replay = await queryScopedContext(database, query, prepared);
    assert.equal(replay.deliveryId, first.deliveryId);
    assert.deepEqual(replay.items, first.items);

    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: active.profileId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      documentHash: 'b'.repeat(64),
      vector: [0, 1, 0],
      createdAt: timestamp,
    });
    const refreshed = await queryScopedContext(database, query, prepared);
    assert.notEqual(refreshed.queryHash, first.queryHash);
    assert.notEqual(refreshed.deliveryId, first.deliveryId);

    const raceQuery = { ...query, task: 'semantic scoped replay race' };
    await assert.rejects(
      queryScopedContextGated(database, raceQuery, () => {
        upsertEntryEmbedding(database, {
          entryId: entry.id,
          profileId: active.profileId,
          revision: entry.revision,
          contentHash: entry.contentHash,
          documentHash: 'c'.repeat(64),
          vector: [1, 0, 0],
          createdAt: timestamp,
        });
        return { persist: true, value: null };
      }, prepared),
      (error: unknown) => (error as { code?: string }).code === 'CONFLICT'
        && (error as Error).message === 'Scoped context catalog changed after ranking',
    );
  } finally {
    database.close();
  }
});
