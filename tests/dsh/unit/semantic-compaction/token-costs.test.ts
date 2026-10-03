import assert from 'node:assert/strict'
import test from 'node:test'
import { measureCompactionRequests, compactionSavingsGate, type TargetTokenCounter } from '../../../../src/dsh/semantic-compaction/token-costs.js'
const signal = () => new AbortController().signal

test('C4 exact costs retain native estimates, bytes and tokenizer identity separately', async () => {
  const seen: string[] = []
  const counter: TargetTokenCounter = { count: async (request, route) => { seen.push(route); return { inputTokens: request.length, tokenizerFingerprint: 'fixture-exact-serializer-v1' } } }
  const costs = await measureCompactionRequests('x'.repeat(1000), 'x'.repeat(700), 'route+serializer', { before: 2000, after: 1400 }, counter, signal())
  assert.deepEqual(seen, ['route+serializer', 'route+serializer'])
  assert.equal(compactionSavingsGate(costs, 1500).accepted, true)
  assert.equal(compactionSavingsGate(costs, 1400).accepted, false)
  const unavailable = await measureCompactionRequests('x'.repeat(1000), 'x'.repeat(10), 'route', { before: 2000, after: 100 }, undefined, signal())
  assert.equal(compactionSavingsGate(unavailable, 1500).reason, 'target_tokenizer_unavailable')
  assert.equal(compactionSavingsGate({ ...costs, targetExact: { before: 1000, after: 800, tokenizerFingerprint: 'exact' } }, 1500).reason, 'target_exact_reduction')
  assert.equal(compactionSavingsGate({ ...costs, requestBytes: { before: 1000, after: 850 } }, 1500).reason, 'request_bytes_reduction')
})

test('changed tokenizer and invalid counts fail closed, cancellation shares the deadline', async () => {
  let calls = 0
  const counter: TargetTokenCounter = { count: async () => ({ inputTokens: 500, tokenizerFingerprint: String(calls++) }) }
  const costs = await measureCompactionRequests('before', 'after', 'route', { before: 2000, after: 1000 }, counter, signal())
  assert.deepEqual(costs.targetExact, { unsupported: 'target_tokenizer_identity_or_count_mismatch' })
  const controller = new AbortController()
  const pending = measureCompactionRequests('before', 'after', 'route', { before: 2000, after: 1000 }, { count: async () => new Promise(() => {}) }, controller.signal)
  controller.abort(); await assert.rejects(pending)
  for (const inputTokens of [NaN, -1, 1.5]) {
    const invalid = await measureCompactionRequests('before', 'after', 'route', { before: 2000, after: 1000 }, { count: async () => ({ inputTokens, tokenizerFingerprint: 'same' }) }, signal())
    assert.ok('unsupported' in invalid.targetExact)
  }
})
