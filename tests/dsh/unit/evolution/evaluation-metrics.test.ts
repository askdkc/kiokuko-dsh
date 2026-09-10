import assert from 'node:assert/strict'
import test from 'node:test'
// Evaluation code is executable JavaScript shared with the report runner.
// @ts-expect-error JavaScript evaluation helper has no declaration file.
import { retrievalMetrics } from '../../../../scripts/evolution-evaluation-metrics.mjs'

test('rank six is a Top-5 miss even when search returns more than K candidates', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({ entryId: String(i + 1) }))
  const metrics = retrievalMetrics(candidates, new Set(['6', '8']), 5)
  assert.equal(metrics.hitAtK, 0)
  assert.equal(metrics.recallAtK, 0)
  assert.equal(metrics.exactRank, 6)
  assert.equal(metrics.reciprocalRank, 1 / 6)
  assert.equal(metrics.reciprocalRankAtK, 0)
  assert.equal(metrics.topK.length, 5)
})

test('hit rate, recall, rank and duplicate candidates have different meanings', () => {
  const result = retrievalMetrics([{ entryId: 'a' }, { entryId: 'a' }, { entryId: 'b' }], new Set(['b', 'c']))
  assert.equal(result.hitAtK, 1)
  assert.equal(result.recallAtK, 0.5)
  assert.equal(result.exactRank, 2)
  assert.equal(result.reciprocalRank, 0.5)
  assert.equal(retrievalMetrics([], new Set()).recallAtK, null)
})
