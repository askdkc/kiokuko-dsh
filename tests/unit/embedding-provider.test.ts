import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { OpenAICompatibleEmbeddingProvider } from '../../src/embedding/openai-compatible-provider.js';
import { EmbeddingProviderError } from '../../src/embedding/provider.js';

function config(overrides: NodeJS.ProcessEnv = {}) {
  return requireEnabledEmbeddingConfig(parseEmbeddingConfig({
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: 'test-model',
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
    ...overrides,
  }));
}

function providerResponse(model: string, data: unknown[]): Response {
  return new Response(JSON.stringify({ object: 'list', model, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('posts the bounded OpenAI-compatible request and orders vectors by index', async () => {
  let requestUrl = '';
  let requestBody = '';
  let authorization: string | null = null;
  const provider = new OpenAICompatibleEmbeddingProvider({
    config: config({ KIOKUKO_EMBEDDING_API_KEY: 'local-test-key' }),
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = String(init?.body);
      authorization = new Headers(init?.headers).get('authorization');
      return providerResponse('test-model', [
        { object: 'embedding', index: 1, embedding: [0, 1, 0] },
        { object: 'embedding', index: 0, embedding: [1, 0, 0] },
      ]);
    },
  });

  const vectors = await provider.embed(['first', 'second']);

  assert.equal(requestUrl, 'http://127.0.0.1:8080/v1/embeddings');
  assert.deepEqual(JSON.parse(requestBody), {
    input: ['first', 'second'],
    model: 'test-model',
    encoding_format: 'float',
  });
  assert.equal(authorization, 'Bearer local-test-key');
  assert.deepEqual([...vectors[0]!], [1, 0, 0]);
  assert.deepEqual([...vectors[1]!], [0, 1, 0]);
  assert.equal(JSON.stringify(provider.profile).includes('local-test-key'), false);
});

test('retries bounded transport failures without exposing the response body', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleEmbeddingProvider({
    config: config(),
    maxRetries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response('api_key = sk-provider-secret-should-not-leak', { status: 503 });
    },
  });

  await assert.rejects(
    provider.embed(['retry me']),
    (error: unknown) => error instanceof EmbeddingProviderError
      && error.code === 'provider_unavailable'
      && !String(error).includes('sk-provider-secret-should-not-leak'),
  );
  assert.equal(calls, 2);
});

test('rejects secret inputs and malformed indexed or dimensioned responses before persistence', async () => {
  const secretProvider = new OpenAICompatibleEmbeddingProvider({ config: config(), fetchImpl: async () => providerResponse('test-model', []) });
  await assert.rejects(secretProvider.embed(['api_key = sk-abcdefghijklmnop']), (error: unknown) => error instanceof EmbeddingProviderError && error.code === 'secret_blocked');

  const badIndex = new OpenAICompatibleEmbeddingProvider({
    config: config(),
    fetchImpl: async () => providerResponse('test-model', [{ index: 1, embedding: [1, 0, 0] }]),
  });
  await assert.rejects(badIndex.embed(['bad index']), (error: unknown) => error instanceof EmbeddingProviderError && error.code === 'invalid_response');

  const badDimensions = new OpenAICompatibleEmbeddingProvider({
    config: config(),
    fetchImpl: async () => providerResponse('test-model', [{ index: 0, embedding: [1, 0] }]),
  });
  await assert.rejects(badDimensions.embed(['bad dimensions']), (error: unknown) => error instanceof EmbeddingProviderError && error.code === 'dimension_mismatch');
});

test('classifies an aborted provider request as a bounded timeout', async () => {
  const provider = new OpenAICompatibleEmbeddingProvider({
    config: config(),
    timeoutMs: 100,
    maxRetries: 0,
    fetchImpl: async (_input, init) => await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  await assert.rejects(provider.embed(['timeout']), (error: unknown) => error instanceof EmbeddingProviderError && error.code === 'timeout');
});
