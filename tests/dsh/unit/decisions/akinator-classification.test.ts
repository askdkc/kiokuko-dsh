import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAkinatorClassificationBatch, classifyTaskForIntake } from '../../../../src/dsh/decisions/akinator-classification.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { DecisionError } from '../../../../src/dsh/decisions/contracts.js'

const configuration = () => TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } })
const signal = () => new AbortController().signal
for (const task of ['Fix the failing parser', '調査結果を要約して', 'このバグを直して']) test(`eligible current direct request is complete: ${task}`, () => {
  const batch = buildAkinatorClassificationBatch(task)!
  assert.equal(batch.state, task)
  assert.deepEqual((batch.questions[0] as any).choices.map((choice: any) => choice.id), ['debug', 'research', 'writing', 'chat', 'abstain'])
})
for (const task of ['富士山って日本で一番高い山？', '富士山は日本で一番高い山ですか', '富士山の高さを教えて', 'Is Mount Fuji the highest mountain in Japan?', 'Why is the sky blue?', 'Is Mount Fuji not the highest mountain in Japan?', 'Are cats and dogs mammals?']) test(`a single question is offered to Laya without guessing its type: ${task}`, () => {
  const batch = buildAkinatorClassificationBatch(task)!
  assert.equal(batch?.state, task)
  assert.ok((batch.questions[0] as any).choices.some((choice: any) => choice.id === 'chat'))
})
test('questions with embedded instructions, source material or unresolved alternatives remain deferred', () => {
  for (const task of ['富士山は高い？ コードを修正して', 'Is Fuji tall? Fix the parser.', 'Which task?\nFix the parser', '「Fix the parser?」を翻訳して', 'デバッグするか調査するかまだ迷っています？'])
    assert.equal(buildAkinatorClassificationBatch(task), undefined, task)
})
test('a question is not forced to chat when Laya selects research or abstains', async () => {
  for (const choice of ['research', 'abstain']) {
    let calls = 0
    const service = new DecisionService(configuration(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => {
      calls++
      return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'fixture', answers: batch.questions.map(q => choice === 'abstain'
        ? { id: q.id, status: 'abstained', reason: 'uncertain' } : { id: q.id, status: 'selected', choiceId: choice }) }
    } }))
    const classified = await classifyTaskForIntake(service, 'question', 'What sources explain this bug?', undefined, signal())
    assert.equal(calls, 1)
    assert.deepEqual(classified, choice === 'abstain' ? { deferInference: true } : { taskType: 'research', deferInference: false })
  }
})
test('quotes, negation, combined intent, build/chat, harmless conjunction and prior-turn requests retain the question', () => {
  for (const task of ['Fix `bug.ts`', 'Do not fix this issue', 'Fix and deploy the application', 'Build a compiler', 'hello', 'yes', '続けて', 'Fix the parser and its tests', 'デバッグするか調査するかまだ迷っています', 'x'.repeat(513)])
    assert.equal(buildAkinatorClassificationBatch(task), undefined, task)
})
test('explicit answers beat hints; Laya abstention and rejected input cannot be overwritten by regex inference', async () => {
  let calls = 0
  const service = new DecisionService(configuration(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => {
    calls++; return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'abstained', reason: 'uncertain' })) }
  } }))
  assert.deepEqual(await classifyTaskForIntake(service, 'explicit', 'Fix this issue', 'build', signal()), { taskType: 'build', deferInference: false }); assert.equal(calls, 0)
  assert.deepEqual(await classifyTaskForIntake(service, 'current', 'Fix this issue', undefined, signal()), { deferInference: true }); assert.equal(calls, 1)
  assert.deepEqual(await classifyTaskForIntake(service, 'current', 'Fix this issue', undefined, signal()), { deferInference: true }); assert.equal(calls, 1)
  await classifyTaskForIntake(service, 'next-turn', 'Fix this issue', undefined, signal()); assert.equal(calls, 2)
  assert.deepEqual(await classifyTaskForIntake(service, 'quoted', 'Fix `bug.ts`', undefined, signal()), { deferInference: true }); assert.equal(calls, 2)
  const unavailable = new DecisionService(configuration(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async () => { throw new DecisionError('UNAVAILABLE') } }))
  assert.deepEqual(await classifyTaskForIntake(unavailable, 'unavailable', 'Fix this issue', undefined, signal()), { deferInference: false })
  const off = configuration(); off.mode = 'off'
  const disabled = new DecisionService(off, () => { throw new Error('off must not infer') })
  assert.deepEqual(await classifyTaskForIntake(disabled, 'off', 'Fix this issue', undefined, signal()), { deferInference: false })
})
