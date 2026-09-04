import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDshPromptCacheLayout, dshProviderCacheTelemetry } from '../../../src/dsh/prompt-cache.js'

test('stable prompt fragments are canonical while variable model state is excluded', () => {
  const common = {
    provider: 'deepseek', model: 'v4', reasoning: 'high', toolSchema: [{ name: 'read' }],
    memoryRevision: '42', phase: 'planning',
  } as const
  const left = buildDshPromptCacheLayout({ ...common, fragments: [
    { kind: 'memory', id: 'b', value: { text: 'memory' } },
    { kind: 'system', id: 'a', value: 'system' },
  ] })
  const right = buildDshPromptCacheLayout({ ...common, fragments: [
    { kind: 'system', id: 'a', value: 'system' },
    { kind: 'memory', id: 'b', value: { text: 'memory' } },
  ] })
  assert.equal(left.fragmentJson, right.fragmentJson)
  assert.equal(left.cacheKey, right.cacheKey)
  assert.notEqual(left.cacheKey, buildDshPromptCacheLayout({ ...common, memoryRevision: '43', fragments: [] }).cacheKey)
  assert.deepEqual(dshProviderCacheTelemetry({ inputTokens: 100, cacheReadTokens: 75, cacheWriteTokens: 4 }), {
    providerCacheHitRate: 0.75, cacheReadTokens: 75, cacheWriteTokens: 4,
  })
})
