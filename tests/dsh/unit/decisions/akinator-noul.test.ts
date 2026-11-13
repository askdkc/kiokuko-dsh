import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyTaskForIntake } from '../../../../src/dsh/decisions/akinator-classification.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'

const task = 'この判定を元にコードの修正を実施'
const signal = () => new AbortController().signal
function fixture(probability: number | undefined, choice = 'chat') {
  const batches: unknown[] = []
  const service = new DecisionService(TypedDecisionsConfig.parse({ provider: 'typesafe' }), () => ({
    capabilities: { maxQuestions: 8, maxChoices: 255, maxBytes: 262144, questionTypes: ['choice', 'noul'] as const },
    evaluate: async batch => {
      batches.push(batch)
      assert.deepEqual(batch.state, { task })
      const coding = batch.questions.find(q => q.id === 'coding')
      assert.ok(coding && 'type' in coding && coding.type === 'noul')
      assert.equal(coding.instructions, 'この会話の内容はコーディングか？')
      return { provider: 'typesafe', requestedModel: 'jev-latest', policyVersion: 'fixture', answers: batch.questions.map(q => q.id === 'coding'
        ? probability === undefined
          ? { id: q.id, status: 'abstained' as const, reason: 'uncertain' as const }
          : { id: q.id, status: 'measured' as const, type: 'noul' as const, probability }
        : { id: q.id, status: 'selected' as const, choiceId: choice }) }
    },
  }))
  return { service, batches }
}

for (const probability of [0, 0.499999, 0.5, 0.500001, 1]) {
  test(`Jev coding uses inclusive 0.5 boundary: ${probability}`, async () => {
    const { service, batches } = fixture(probability, probability < 0.5 ? 'build' : 'chat')
    assert.deepEqual(await classifyTaskForIntake(service, 'boundary', task, undefined, signal()),
      { taskType: probability >= 0.5 ? 'build' : 'chat', deferInference: false })
    assert.equal(batches.length, 1)
    await classifyTaskForIntake(service, 'boundary', task, undefined, signal())
    assert.equal(batches.length, 1, 'same request reuses its decision')
  })
}
test('Jev preserves debug and non-coding subcategories on their respective sides', async () => {
  for (const [probability, choice] of [[0.5, 'debug'], [0.1, 'research'], [0.1, 'writing']] as const) {
    const { service } = fixture(probability, choice)
    assert.deepEqual(await classifyTaskForIntake(service, choice, task, undefined, signal()), { taskType: choice, deferInference: false })
  }
})
test('a missing coding measurement cannot become coding from the category choice', async () => {
  const { service } = fixture(undefined, 'build')
  assert.deepEqual(await classifyTaskForIntake(service, 'uncertain', task, undefined, signal()), { deferInference: true })
})
test('explicit task types still bypass Jev classification', async () => {
  const { service, batches } = fixture(0.9)
  assert.deepEqual(await classifyTaskForIntake(service, 'explicit', task, 'writing', signal()), { taskType: 'writing', deferInference: false })
  assert.equal(batches.length, 0)
})
