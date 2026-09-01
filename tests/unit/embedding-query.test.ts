import assert from 'node:assert/strict';
import test from 'node:test';
import { queryEmbeddingHashV2, renderEmbeddingQueryInput } from '../../src/embedding/query-cache.js';

test('renders the E5 query prefix after canonical normalization', () => {
  assert.equal(renderEmbeddingQueryInput('  二重実行\r\n  '), 'query: 二重実行');
  assert.match(queryEmbeddingHashV2('same'), /^[0-9a-f]{64}$/u);
  assert.notEqual(queryEmbeddingHashV2('same'), queryEmbeddingHashV2('different'));
});

test('rejects an unsupported provider prefix and oversized/control query', () => {
  assert.throws(() => renderEmbeddingQueryInput('query', 'passage: '), { code: 'VALIDATION_ERROR' });
  assert.throws(() => renderEmbeddingQueryInput('bad\u0000query'), { code: 'VALIDATION_ERROR' });
});
