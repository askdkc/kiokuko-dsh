import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import {
  activateEmbeddingProfile,
  readEntryEmbedding,
  upsertEntryEmbedding,
} from '../../src/embedding/store.js';
import { claimEmbeddingJobs, listEmbeddingJobs } from '../../src/embedding/jobs.js';
import { createEmbeddingProfile } from '../../src/embedding/profile.js';
import { createEmbeddingRuntime } from '../../src/embedding/runtime.js';
import { EmbeddingProviderError } from '../../src/embedding/provider.js';
import { recordEntry } from '../../src/memory/entries.js';
import { updateCandidateEntry } from '../../src/memory/entries.js';
import type { EmbeddingProvider } from '../../src/embedding/types.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

function profile(model: string) {
  return createEmbeddingProfile(requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: model,
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
  })));
}

const timestamp = '2026-08-30T00:00:00.000Z';

test('active profile activation and entry mutation enqueue current jobs atomically', async () => {
  const database = await temporaryDatabase('embedding-jobs');
  try {
    const active = profile('model-a');
    assert.deepEqual(activateEmbeddingProfile(database, active, { replace: false, now: timestamp }), {
      profileId: active.profileId,
      generation: 1,
      activated: true,
      enqueued: 0,
    });
    const entry = recordEntry(database, {
      workspace: 'project:jobs',
      kind: 'lesson',
      title: 'Queue this entry',
      body: 'A current entry needs one embedding job.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-jobs', now: timestamp });
    assert.deepEqual(listEmbeddingJobs(database), [{
      entryId: entry.id,
      profileId: active.profileId,
      revision: 1,
      contentHash: entry.contentHash,
      state: 'pending',
      attempts: 0,
      availableAt: timestamp,
      leaseId: null,
      leaseExpiresAt: null,
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: 'project:jobs',
    }]);

    const claimed = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: timestamp,
      leaseIdFactory: () => 'lease-one',
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.leaseId, 'lease-one');
    assert.equal(claimed[0]?.attempts, 1);
    assert.equal(claimed[0]?.state, 'leased');
  } finally {
    database.close();
  }
});

test('expired leases are reclaimed and revision changes reset the current job without deleting old vectors', async () => {
  const database = await temporaryDatabase('embedding-revision');
  try {
    const active = profile('model-a');
    activateEmbeddingProfile(database, active, { replace: false, now: timestamp });
    const entry = recordEntry(database, {
      workspace: 'project:revision',
      kind: 'lesson',
      title: 'Original title',
      body: 'Original body',
      createdBy: 'test',
    }, { idFactory: () => 'entry-revision', now: timestamp });
    upsertEntryEmbedding(database, {
      entryId: entry.id,
      profileId: active.profileId,
      revision: 1,
      contentHash: entry.contentHash,
      documentHash: 'c'.repeat(64),
      vector: [1, 0, 0],
      createdAt: timestamp,
    });
    const firstClaim = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: timestamp,
      leaseMs: 1_000,
      leaseIdFactory: () => 'lease-expired',
    });
    assert.equal(firstClaim[0]?.state, 'leased');
    const reclaimed = claimEmbeddingJobs(database, {
      maxJobs: 1,
      now: '2026-08-30T00:00:01.001Z',
      leaseIdFactory: () => 'lease-reclaimed',
    });
    assert.equal(reclaimed[0]?.leaseId, 'lease-reclaimed');
    assert.equal(reclaimed[0]?.attempts, 2);

    const updated = updateCandidateEntry(database, {
      workspace: 'project:revision',
      entryId: entry.id,
      expectedRevision: 1,
      kind: 'lesson',
      title: 'Updated title',
      body: 'Updated body',
      createdBy: 'test',
      now: '2026-08-30T00:00:02.000Z',
    });
    const jobs = listEmbeddingJobs(database);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.revision, 2);
    assert.equal(jobs[0]?.contentHash, updated.contentHash);
    assert.equal(jobs[0]?.state, 'pending');
    assert.equal(jobs[0]?.attempts, 0);
    assert.equal(jobs[0]?.leaseId, null);
    assert.equal(readEntryEmbedding(database, { entryId: entry.id, profileId: active.profileId })?.revision, 1);
  } finally {
    database.close();
  }
});

test('a failed enqueue rolls back the canonical entry write', async () => {
  const database = await temporaryDatabase('embedding-rollback');
  try {
    const active = profile('model-a');
    activateEmbeddingProfile(database, active, { replace: false, now: timestamp });
    database.exec(`
      CREATE TRIGGER reject_embedding_job
      BEFORE INSERT ON embedding_jobs
      BEGIN
        SELECT RAISE(ABORT, 'test enqueue failure');
      END;
    `);
    assert.throws(() => recordEntry(database, {
      workspace: 'project:rollback',
      kind: 'lesson',
      title: 'Must roll back',
      body: 'The queue write is part of the entry transaction.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-rollback', now: timestamp }));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get<{ count: number }>()?.count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
  } finally {
    database.close();
  }
});

test('runtime drains jobs with a fake provider and reuses the query vector cache', async () => {
  const database = await temporaryDatabase('embedding-runtime');
  try {
    const active = profile('model-runtime');
    const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig({
      KIOKUKO_EMBEDDINGS: 'optional',
      KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
      KIOKUKO_EMBEDDING_MODEL: 'model-runtime',
      KIOKUKO_EMBEDDING_DIMENSIONS: '3',
      KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
    }));
    activateEmbeddingProfile(database, active, { replace: false, now: timestamp });
    let calls = 0;
    const provider: EmbeddingProvider = {
      profile: active.identity,
      async embed(inputs) {
        calls += 1;
        return inputs.map(() => new Float32Array([1, 0, 0]));
      },
    };
    const runtime = createEmbeddingRuntime(database, config, { provider, now: () => timestamp });
    const entry = recordEntry(database, {
      workspace: 'project:runtime',
      kind: 'lesson',
      title: 'Runtime worker entry',
      body: 'A fake provider should index this entry.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-runtime', now: timestamp });

    assert.deepEqual(await runtime.drain({ workspace: 'project:runtime', maxJobs: 4, deadlineMs: 5_000 }), {
      claimed: 1,
      completed: 1,
      failed: 0,
      blocked: 0,
      remaining: 0,
    });
    assert.equal(readEntryEmbedding(database, { entryId: entry.id, profileId: active.profileId })?.revision, 1);
    assert.equal(listEmbeddingJobs(database).length, 0);

    const first = await runtime.prepareQuery(database, ' query ');
    const second = await runtime.prepareQuery(database, 'query');
    assert.ok(first);
    assert.ok(second);
    assert.equal(calls, 2);
    assert.equal(first?.vectorHash, second?.vectorHash);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM query_embeddings').get<{ count: number }>()?.count, 1);
    await runtime.close();
  } finally {
    database.close();
  }
});

test('runtime aborts an in-flight provider batch at the caller drain deadline', async () => {
  const database = await temporaryDatabase('embedding-deadline');
  try {
    const active = profile('model-deadline');
    const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig({
      KIOKUKO_EMBEDDINGS: 'optional',
      KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
      KIOKUKO_EMBEDDING_MODEL: 'model-deadline',
      KIOKUKO_EMBEDDING_DIMENSIONS: '3',
      KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
    }));
    activateEmbeddingProfile(database, active, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:deadline',
      kind: 'lesson',
      title: 'Bound the provider call',
      body: 'The drain deadline must abort a provider that does not finish.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-deadline', now: timestamp });
    const provider: EmbeddingProvider = {
      profile: active.identity,
      embed(_inputs, options) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new EmbeddingProviderError('timeout', true));
          }, { once: true });
        });
      },
    };
    const runtime = createEmbeddingRuntime(database, config, { provider, now: () => timestamp });
    const startedAt = Date.now();
    const result = await runtime.drain({ workspace: 'project:deadline', maxJobs: 1, deadlineMs: 20 });

    assert.ok(Date.now() - startedAt < 1_000);
    assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1, blocked: 0, remaining: 1 });
    assert.equal(listEmbeddingJobs(database)[0]?.errorCode, 'timeout');
    await runtime.close();
  } finally {
    database.close();
  }
});
