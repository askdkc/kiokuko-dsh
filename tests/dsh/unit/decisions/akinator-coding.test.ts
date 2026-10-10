import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAkinatorClassificationBatch, classifyTaskForIntake } from '../../../../src/dsh/decisions/akinator-classification.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { createLispCodingChoice } from '../../../../src/dsh/lisp/coding-choice.js'
import { DecisionError } from '../../../../src/dsh/decisions/contracts.js'
import { resolveGroundedIntakeProfile } from '../../../../src/dsh/intake-profile-resolver.js'

for (const task of ['検索機能を実装して', 'ログイン画面を追加して', 'Build a compiler', 'Implement search', 'Create a login component', 'Could you build a compiler?', '検索機能を実装してくれますか？']) test(`explicit single implementation reaches classification: ${task}`, () => {
  const batch = buildAkinatorClassificationBatch(task)
  assert.equal(batch?.state, task)
  const question = batch?.questions[0]
  assert.ok(question && 'choices' in question)
  assert.ok(question.choices.some(choice => choice.id === 'build'))
})
for (const task of ['実装して', 'Build', '検索を実装して画面を追加して', '検索を実装して調査して', 'Implement search and deploy it', '実装して'.repeat(100)]) test(`complete request reaches the selected model; it may still abstain: ${task.slice(0, 40)}`, () => {
  assert.equal(buildAkinatorClassificationBatch(task)?.state, task)
})
for (const task of ['それを実装して', 'Implement it', '検索か画面かまだ決めていない', '続けて', '実装して'.repeat(400)]) test(`missing prior context, unresolved alternatives or overflow remain deferred: ${task.slice(0, 40)}`, () => {
  assert.equal(buildAkinatorClassificationBatch(task), undefined)
})
for (const provider of ['typesafe', 'laya-coreml'] as const) for (const type of ['build', 'debug'] as const) test(`${provider} selected ${type} asks once before admission`, async () => {
  const config = TypedDecisionsConfig.parse({ mode: 'auto', provider, 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } })
  const service = new DecisionService(config, () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => ({ provider, requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: type })) }) }))
  const signal = new AbortController().signal
  const task = type === 'build' ? '検索機能を実装して' : 'ログイン時の例外を修正して'
  const classified = await classifyTaskForIntake(service, 'request', task, undefined, signal)
  assert.equal(classified.taskType, type)
  let asked = 0, enabled = false
  let answer!: (value: any) => void
  const coding = createLispCodingChoice({ enabled: () => enabled, decided: async () => enabled,
    questions: { ask: request => { asked++; assert.equal(request.questions[0].question, 'コーディングにLispモードを使いますか？'); return new Promise(resolve => { answer = resolve }) } },
    enable: async () => { enabled = true }, decline: async () => {},
  })
  const input = { agent: { id: 'agent' }, task, taskType: classified.taskType, turn: 1, signal }
  const first = coding.prepare(input), retry = coding.prepare(input)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(asked, 1)
  assert.equal(enabled, false)
  answer({ answers: [{ id: 'lisp-coding-mode', selected: ['Lispモードを使う（通常実行）'] }] })
  await Promise.all([first, retry])
  assert.equal(enabled, true)
  await coding.prepare({ ...input, turn: 2 })
  assert.equal(asked, 1)
})
test('admission wording never overrides a model decision about prose', async () => {
  const service = new DecisionService(TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } }), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => ({ provider: 'laya-coreml', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: 'writing' })) }) }))
  assert.deepEqual(await classifyTaskForIntake(service, 'prose', '検索機能の説明文を作成して', undefined, new AbortController().signal), { taskType: 'writing', deferInference: false })
})

for (const provider of ['typesafe', 'laya-coreml'] as const) for (const failure of ['abstain', 'UNAVAILABLE', 'TOO_LARGE'] as const) test(`${provider} ${failure} cannot become keyword-inferred coding`, async () => {
  const service = new DecisionService(TypedDecisionsConfig.parse({ mode: 'auto', provider, 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } }), () => ({
    capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 },
    evaluate: async batch => {
      if (failure !== 'abstain') throw new DecisionError(failure)
      return { provider, requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'abstained' as const, reason: 'uncertain' })) }
    },
  }))
  const task = 'Implement search'
  const classified = await classifyTaskForIntake(service, 'failure', task, undefined, new AbortController().signal)
  assert.deepEqual(classified, { deferInference: true })
  const grounded = resolveGroundedIntakeProfile({ task, cwd: process.cwd(), deferTaskTypeInference: classified.deferInference })
  assert.equal(grounded.profileHints.taskType, null)
})
