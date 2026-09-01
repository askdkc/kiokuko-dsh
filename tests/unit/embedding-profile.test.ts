import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { createEmbeddingProfile, createEmbeddingProfileIdentity, embeddingProfileId } from '../../src/embedding/profile.js';

function config(apiKey: string | undefined, endpoint = 'http://localhost:8080/v1') {
  return requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: endpoint,
    KIOKUKO_EMBEDDING_MODEL: 'model-a',
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.6',
    ...(apiKey === undefined ? {} : { KIOKUKO_EMBEDDING_API_KEY: apiKey }),
  }));
}

test('profile identity and ID are deterministic and exclude credentials', () => {
  const first = createEmbeddingProfile(config('secret-one'));
  const second = createEmbeddingProfile(config('secret-two'));

  assert.deepEqual(first, second);
  assert.equal(first.profileId, embeddingProfileId(first.identity));
  assert.equal(JSON.stringify(first.identity).includes('secret'), false);
  assert.equal(JSON.stringify(first.identity).includes('localhost'), false);
  assert.match(first.profileId, /^[0-9a-f]{64}$/u);
});

test('profile identity changes when semantic behavior changes', () => {
  const first = createEmbeddingProfile(config(undefined));
  const differentModel = createEmbeddingProfile(config(undefined, 'http://localhost:8080/v1/model-b'));
  const differentDimensions = createEmbeddingProfileIdentity({ ...config(undefined), dimensions: 4 });

  assert.notEqual(first.profileId, differentModel.profileId);
  assert.notEqual(first.profileId, embeddingProfileId(differentDimensions));
  assert.equal(first.identity.distanceMetric, 'cosine');
  assert.equal(first.identity.documentTemplateVersion, 1);
  assert.equal(first.identity.queryTemplateVersion, 1);
});
