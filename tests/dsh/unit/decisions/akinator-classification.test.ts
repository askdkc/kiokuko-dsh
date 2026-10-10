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
  assert.deepEqual((batch.questions[0] as any).choices.map((choice: any) => choice.id), ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis', 'chat', 'abstain'])
})
for (const task of ['富士山って日本で一番高い山？', '富士山は日本で一番高い山ですか', '富士山の高さを教えて', 'Is Mount Fuji the highest mountain in Japan?', 'Why is the sky blue?', 'Is Mount Fuji not the highest mountain in Japan?', 'Are cats and dogs mammals?']) test(`a single question is offered to Laya without guessing its type: ${task}`, () => {
  const batch = buildAkinatorClassificationBatch(task)!
  assert.equal(batch?.state, task)
  assert.ok((batch.questions[0] as any).choices.some((choice: any) => choice.id === 'chat'))
})
test('embedded instructions and quoted material reach the model intact; explicitly unchosen alternatives remain deferred', () => {
  for (const task of ['富士山は高い？ コードを修正して', 'Is Fuji tall? Fix the parser.', 'Which task?\nFix the parser', '「Fix the parser?」を翻訳して'])
    assert.equal(buildAkinatorClassificationBatch(task)?.state, task)
  assert.equal(buildAkinatorClassificationBatch('デバッグするか調査するかまだ迷っています？'), undefined)
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
test('only missing prior context, explicitly unchosen alternatives and envelope overflow skip inference', () => {
  for (const task of ['yes', '続けて', 'デバッグするか調査するかまだ迷っています', 'x'.repeat(4097)])
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
  assert.deepEqual(await classifyTaskForIntake(service, 'quoted', 'Fix `bug.ts`', undefined, signal()), { deferInference: true }); assert.equal(calls, 3)
  const unavailable = new DecisionService(configuration(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async () => { throw new DecisionError('UNAVAILABLE') } }))
  assert.deepEqual(await classifyTaskForIntake(unavailable, 'unavailable', 'Fix this issue', undefined, signal()), { deferInference: true })
  const off = configuration(); off.mode = 'off'
  const disabled = new DecisionService(off, () => { throw new Error('off must not infer') })
  assert.deepEqual(await classifyTaskForIntake(disabled, 'off', 'Fix this issue', undefined, signal()), { deferInference: false })
})


test('classification preserves an exact 4096-byte UTF-8 request and rejects whole overflows', () => {
  const body = 'Fix the parser. ' + 'あ'.repeat(1350)
  const exact = body + ' '.repeat(4096 - Buffer.byteLength(body, 'utf8'))
  assert.equal(Buffer.byteLength(exact, 'utf8'), 4096)
  assert.equal(buildAkinatorClassificationBatch(exact)?.state, exact)
  assert.equal(buildAkinatorClassificationBatch(exact + 'あ'), undefined)
  assert.equal(buildAkinatorClassificationBatch(exact + 'x'), undefined)
})

test('clear queued coding requests reach Laya intact instead of being rejected by syntax', async () => {
  for (const task of ['Fix `src/parser.ts` and its tests.', 'Add input validation. Also fix the parser bug.', 'Fix the parser.\nAlso cover the regression; do not deploy.', 'Fix the parser error described below.\n' + 'The failing input is a missing delimiter. '.repeat(20)]) {
    let calls = 0
    const service = new DecisionService(configuration(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => {
      calls++
      assert.equal(batch.state, task)
      return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: 'debug' })) }
    } }))
    assert.deepEqual(await classifyTaskForIntake(service, 'queued', task, undefined, signal()), { taskType: 'debug', deferInference: false }, task)
    assert.equal(calls, 1)
  }
})

test('quoted bug examples and negated changes are classified by requested intent, not keywords', async () => {
  const task = 'Do not modify the code. Explain why the example says "fix the parser".'
  let calls = 0
  const service = new DecisionService(configuration(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => {
    calls++; assert.equal(batch.state, task)
    return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: 'chat' })) }
  } }))
  assert.deepEqual(await classifyTaskForIntake(service, 'negative', task, undefined, signal()), { taskType: 'chat', deferInference: false })
  assert.equal(calls, 1)
})
