import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmbeddingBaseUrl, parseEmbeddingConfig, requireEnabledEmbeddingConfig, findDeprecatedEmbeddingEnvironmentVariables } from '../../src/embedding/config.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { readPersistedEmbeddingSettings } from '../../src/embedding/settings.js';

function enabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_PROVIDER: 'openai-compatible',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: 'test-model',
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
    ...overrides,
  };
}

test('defaults embeddings to off without requiring provider configuration', () => {
  const config = parseEmbeddingConfig({});

  assert.equal(config.mode, 'off');
  assert.equal(config.provider, 'openai-compatible');
  assert.equal(config.allowRemote, false);
  assert.equal(config.vectorBackend, 'auto');
  assert.equal(config.timeoutMs, 30_000);
  assert.equal(config.batchSize, 16);
  assert.equal(config.baseUrl, undefined);
});

test('strictly parses an enabled loopback configuration', () => {
  const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig(enabledEnvironment({
    KIOKUKO_EMBEDDING_TIMEOUT_MS: '5000',
    KIOKUKO_EMBEDDING_BATCH_SIZE: '4',
    KIOKUKO_EMBEDDING_API_KEY: 'local-key',
  })));

  assert.deepEqual({
    mode: config.mode,
    baseUrl: config.baseUrl,
    model: config.model,
    dimensions: config.dimensions,
    distanceCeiling: config.distanceCeiling,
    timeoutMs: config.timeoutMs,
    batchSize: config.batchSize,
    apiKey: config.apiKey,
  }, {
    mode: 'optional',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'test-model',
    dimensions: 3,
    distanceCeiling: 0.8,
    timeoutMs: 5000,
    batchSize: 4,
    apiKey: 'local-key',
  });
});

test('rejects unsupported values and incomplete enabled configuration', () => {
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_EMBEDDINGS: 'sometimes' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_VECTOR_BACKEND: 'native' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig(enabledEnvironment({ KIOKUKO_EMBEDDING_DIMENSIONS: '1' })), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig(enabledEnvironment({ KIOKUKO_EMBEDDING_DISTANCE_CEILING: '2' })), { code: 'VALIDATION_ERROR' });
  assert.throws(() => parseEmbeddingConfig({ KIOKUKO_EMBEDDINGS: 'required' }), { code: 'VALIDATION_ERROR' });
});

test('enforces endpoint privacy and transport policy', () => {
  assert.equal(normalizeEmbeddingBaseUrl('http://localhost:9000/embeddings', false), 'http://localhost:9000/embeddings');
  assert.equal(normalizeEmbeddingBaseUrl('https://api.example.test/v1', true), 'https://api.example.test/v1');
  for (const value of [
    'http://example.test/v1',
    'https://api.example.test/v1',
    'http://user:password@localhost/v1',
    'http://localhost/v1?secret=value',
    'http://localhost/v1#fragment',
    'file:///tmp/embedding',
  ]) {
    assert.throws(() => normalizeEmbeddingBaseUrl(value, false), { code: 'VALIDATION_ERROR' });
  }
});

test('reads persisted off settings without consulting embedding environment values', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const config = readPersistedEmbeddingSettings(database);
    assert.equal(config.mode, 'off');
    assert.equal(config.provider, 'openai-compatible');
    assert.equal(config.vectorBackend, 'auto');
  } finally {
    database.close();
  }
});

test('detects deprecated embedding setting names without returning values', () => {
  const names = findDeprecatedEmbeddingEnvironmentVariables({
    KIOKUKO_EMBEDDING_API_KEY: 'do-not-return',
    KIOKUKO_EMBEDDINGS: 'optional',
  });
  assert.deepEqual(names, ['KIOKUKO_EMBEDDINGS', 'KIOKUKO_EMBEDDING_API_KEY']);
  assert.equal(JSON.stringify(names).includes('do-not-return'), false);
});
