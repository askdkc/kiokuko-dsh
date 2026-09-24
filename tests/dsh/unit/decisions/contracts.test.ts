import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionError, parseDecisionBatch, parseDecisionResult } from '../../../../src/dsh/decisions/contracts.js'

const choice = { id: 'choice', instructions: 'Choose', choices: [{ id: 'yes', description: 'Yes' }, { id: 'abstain', description: 'Unknown' }], abstainId: 'abstain' }
const score = { id: 'score', type: 'score', instructions: 'Rate', criteria: ['No', 'Maybe', 'Yes'] }
const result = (answers: unknown[]) => ({ answers, provider: 'typesafe', requestedModel: 'jev-latest', policyVersion: 'typed-decisions-v1' })

test('legacy Choice normalizes without changing its serialized shape', () => {
  const batch = parseDecisionBatch({ purpose: 'lisp', state: 'evidence', questions: [choice] })
  assert.equal(batch.contractVersion, undefined)
  assert.deepEqual(batch.questions[0], choice)
  assert.deepEqual(parseDecisionBatch({ ...batch, questions: [{ ...choice, type: 'choice' }] }), batch)
  assert.equal(parseDecisionResult(result([{ id: 'choice', status: 'selected', choiceId: 'yes' }]), batch).answers[0]?.status, 'selected')
})

test('Noul and Score retain measured values and reject type, rubric and probability corruption', () => {
  const batch = parseDecisionBatch({ purpose: 'skills', state: 'evidence', questions: [
    { id: 'noul', type: 'noul', instructions: 'True?' }, score] })
  assert.equal(batch.contractVersion, 'typed-decisions-v1')
  const answers = [{ id: 'noul', status: 'measured', type: 'noul', probability: .7 },
    { id: 'score', status: 'measured', type: 'score', score: 1.5, probabilities: [0, .5, .5], confidence: .8 }]
  assert.equal(parseDecisionResult(result(answers), batch).answers.length, 2)
  for (const corrupt of [
    [{ ...answers[0], probability: -1 }, answers[1]],
    [answers[0], { ...answers[1], probabilities: [0, .4, .5] }],
    [answers[0], { ...answers[1], score: 3 }],
    [answers[0], { ...answers[1], type: 'noul' }],
  ]) assert.throws(() => parseDecisionResult(result(corrupt), batch), { code: 'DECISION_MALFORMED_RESPONSE' })
  assert.throws(() => parseDecisionBatch({ ...batch, questions: [{ ...score, criteria: ['duplicate', 'duplicate'] }] }), DecisionError)
})
