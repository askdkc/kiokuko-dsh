import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeLayaResult } from '../../../../src/dsh/decisions/laya-coreml.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import type { DecisionBatch } from '../../../../src/dsh/decisions/contracts.js'

test('explicit Skill gate applies only to Skill purpose; compaction floor and stricter general acceptance survive', () => {
  const settings = TypedDecisionsConfig.parse({ 'laya-coreml': { acceptance: { minProbability: .6, minMargin: .1 }, skillAcceptance: { minProbability: .8, minMargin: .2 } } })['laya-coreml']!
  const batch: DecisionBatch = { purpose: 'skills', state: 'Complete current task', questions: [{ id: 'q', instructions: 'Choose', choices: [{ id: 'yes', description: '' }, { id: 'abstain', description: '' }], abstainId: 'abstain' }] }
  const raw = { model: 'laya-rl-agent', usage: { input_tokens: 30, output_tokens: 0 }, answers: { q: { type: 'choice', choice: 'yes', probabilities: { yes: .85, abstain: .15 }, confidence: .1, action: { act_probability: 0 } } } }
  assert.equal(decodeLayaResult(raw, batch, settings).answers[0]!.status, 'selected')
  for (const purpose of ['compaction', 'model-handoff'] as const) assert.equal(decodeLayaResult(raw, { ...batch, purpose }, settings).answers[0]!.status, 'abstained')
  settings.acceptance = { minProbability: .96, minMargin: .2 }; raw.answers.q.probabilities = { yes: .95, abstain: .05 }
  assert.equal(decodeLayaResult(raw, { ...batch, purpose: 'compaction' }, settings).answers[0]!.status, 'abstained')
  delete settings.skillAcceptance
  assert.equal(decodeLayaResult(raw, batch, settings).answers[0]!.status, 'abstained')
})
