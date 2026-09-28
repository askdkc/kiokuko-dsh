import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { scoreConfidenceBands } from '../../../scripts/score-confidence-bands.js'
import { buildModelRoutingBatch } from '../../../src/dsh/model-auto/batch.js'
import { DEFAULT_MODEL_AUTO_ROUTES } from '../../../src/dsh/model-auto/contracts.js'
import { routingInputCompleteness, summarizeModelRouting, type RoutingEvaluationRow } from '../../../scripts/model-routing-evaluation.js'

test('model routing fixture uses the exact production batch contract and offline CLI makes no network call', () => {
  const batch = buildModelRoutingBatch({ task: 'Task', taskType: 'build', attachmentTypes: [], routes: DEFAULT_MODEL_AUTO_ROUTES })
  assert.deepEqual(batch.questions[0] && 'choices' in batch.questions[0] ? batch.questions[0].choices.map(choice => choice.id) : [],
    ['luna-low', 'luna-medium', 'luna-high', 'sol-high', 'retain'])
  const guard = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("offline network call")}'
  const result = spawnSync(process.execPath, ['--import', guard, '--import', 'tsx', 'scripts/run-model-routing-evaluation.mjs',
    '--repetitions', '2', '--seed', '7'], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mode, 'offline-contract')
  assert.deepEqual(report.contract, { attempted: 32, completed: 32, failed: 0 })
  assert.equal(report.quality, null)
  assert.equal(new Set(report.cases.map((row: { id: string; language: string }) => `${row.id}:${row.language}`)).size, 16)
  const repeated = spawnSync(process.execPath, ['--import', guard, '--import', 'tsx', 'scripts/run-model-routing-evaluation.mjs',
    '--repetitions', '2', '--seed', '7'], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(repeated.status, 0, repeated.stderr)
  assert.deepEqual(JSON.parse(repeated.stdout).cases.map((row: { id: string; language: string }) => `${row.id}:${row.language}`),
    report.cases.map((row: { id: string; language: string }) => `${row.id}:${row.language}`))
})

test('route quality keeps failed requests and abstentions separate from under-routing', () => {
  const rows: RoutingEvaluationRow[] = [
    { id: 'auth', language: 'ja', consequence: 'high', expected: 'sol-high', status: 'completed', actual: 'luna-low', decision: 'selected', confidence: .95, elapsedMs: 10 },
    { id: 'migration', language: 'en', consequence: 'high', expected: 'sol-high', status: 'completed', actual: 'retain', decision: 'abstained', elapsedMs: 30 },
    { id: 'format', language: 'en', consequence: 'routine', expected: 'luna-low', status: 'completed', actual: 'luna-low', decision: 'selected', confidence: .7, elapsedMs: 20 },
    { id: 'network', language: 'ja', consequence: 'high', expected: 'sol-high', status: 'failed', reason: 'DECISION_UNAVAILABLE', elapsedMs: 40 },
  ]
  const jev = summarizeModelRouting(rows, 'jev')
  assert.equal(jev.attempted, 4); assert.equal(jev.completed, 3); assert.equal(jev.failed, 1)
  assert.equal(jev.underRouted, 1); assert.equal(jev.highConsequenceUnderRouted, 1)
  assert.equal(jev.highConfidenceUnderRouted, 1); assert.equal(jev.abstained, 1)
  assert.equal(jev.highConsequenceAbstentionRate, .5)
  assert.equal(jev.confusion['sol-high']?.['retain'], 1)
  assert.equal(jev.failures.DECISION_UNAVAILABLE, 1)
  assert.equal(summarizeModelRouting(rows, 'laya').highConfidenceUnderRouted, null)
})

test('input completeness follows the actual model-routing transport, without claiming Laya preflight', () => {
  assert.equal(routingInputCompleteness('jev', 'strict', true), 'host_complete')
  assert.equal(routingInputCompleteness('laya', 'v1', true), 'unverified_v1')
  assert.equal(routingInputCompleteness('laya', 'strict', true), 'strict_predict_contract')
  assert.equal(routingInputCompleteness('laya', 'strict', false), 'unknown')
})

test('score confidence boundaries partition 0, .49, .5, .79, .8, and 1 exactly once', () => {
  const bands = scoreConfidenceBands([0, .49, .5, .79, .8, 1].map(confidence => ({ confidence, correct: confidence >= .8 })))
  assert.deepEqual(bands, {
    '[0,.5)': { count: 2, accuracy: 0 }, '[.5,.8)': { count: 2, accuracy: 0 }, '[.8,1]': { count: 2, accuracy: 1 },
  })
})

test('evaluation arguments fail before any provider request', () => {
  for (const args of [['--provider', 'jev'], ['--live', '--provider', 'jev'], ['--seed', '-1']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-model-routing-evaluation.mjs', ...args],
      { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(result.status, 2)
  }
})
