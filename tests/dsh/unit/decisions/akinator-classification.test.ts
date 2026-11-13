import assert from 'node:assert/strict'
import test from 'node:test'
import { isTrivialConversation } from '../../../../src/akinator/domain.js'
import { buildAkinatorClassificationBatch, classifyTaskForIntake, createStartupConversationGate, suppressStartupDialogForConversation, WORK_REQUEST_GATE_PROBABILITY } from '../../../../src/dsh/decisions/akinator-classification.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { DecisionError, questionType } from '../../../../src/dsh/decisions/contracts.js'
import { resolveGroundedIntakeProfile } from '../../../../src/dsh/intake-profile-resolver.js'

const configuration = () => TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } })
const signal = () => new AbortController().signal

test('a whole-message greeting is conversation, not an implementation request', () => {
  for (const greeting of ['hello!', 'hello there', 'こんにちわ！', 'こんにちは', 'おはようございます', 'ありがとう', '了解です', '雑談', '👋', '👍 ありがとう'])
    assert.equal(isTrivialConversation(greeting), true, greeting)
  for (const work of ['hello! Please fix the failing parser.', 'こんにちは。バグを直してください', 'thanks; now deploy the server', 'Fix the parser', 'ok, which parser should I change?'])
    assert.equal(isTrivialConversation(work), false, work)
})

const typesafeConfiguration = () => TypedDecisionsConfig.parse({ provider: 'typesafe' })
const noulService = (probability: number, calls = { count: 0 }) => new DecisionService(typesafeConfiguration(), () => ({
  capabilities: { maxQuestions: 8, maxChoices: 255, maxBytes: 262144, questionTypes: ['choice', 'noul', 'score'] as const },
  evaluate: async batch => {
    calls.count++
    assert.equal(questionType(batch.questions[0]!), 'noul', JSON.stringify(batch))
    assert.deepEqual(batch.state, { task: 'How have you been?' })
    return { provider: 'typesafe', requestedModel: 'jev-latest', policyVersion: 'fixture',
      answers: [{ id: 'work-request-gate', status: 'measured' as const, type: 'noul' as const, probability }] }
  },
}))

test('the startup dialog gate suppresses only confidently conversational messages', async () => {
  assert.equal(WORK_REQUEST_GATE_PROBABILITY, 0.2)
  const low = noulService(0.05)
  assert.equal(await suppressStartupDialogForConversation(low, 'gate-low', 'How have you been?', signal()), true)
  const boundary = noulService(WORK_REQUEST_GATE_PROBABILITY)
  assert.equal(await suppressStartupDialogForConversation(boundary, 'gate-boundary', 'How have you been?', signal()), false)
  const ambiguous = noulService(0.5)
  assert.equal(await suppressStartupDialogForConversation(ambiguous, 'gate-ambiguous', 'How have you been?', signal()), false)
})

test('a pre-dialog measurement leaves the turn binding available for the startup choice', async () => {
  const service = noulService(0.9)
  const requestId = 'startup-turn'
  assert.equal(await suppressStartupDialogForConversation(service, requestId, 'How have you been?', signal()), false)
  assert.equal(await service.readStartup(requestId), undefined)
  const choice = { decision: false, lisp: true }
  const binding = await service.bindStartup(requestId, choice, signal())
  assert.equal(binding.mode, 'off')
  assert.deepEqual(binding.startup, choice)
})

test('the startup dialog gate shows the dialog whenever the provider cannot measure conversation', async () => {
  assert.equal(await suppressStartupDialogForConversation(undefined, 'gate-absent', 'How have you been?', signal()), false)
  const off = typesafeConfiguration(); off.mode = 'off'
  const calls = { count: 0 }
  const disabled = new DecisionService(off, () => ({ capabilities: { maxQuestions: 8, maxChoices: 255, maxBytes: 262144 }, evaluate: async () => { calls.count++; throw new Error('off must not dispatch') } }))
  assert.equal(await suppressStartupDialogForConversation(disabled, 'gate-off', 'How have you been?', signal()), false)
  assert.equal(calls.count, 0)
  const failing = new DecisionService(typesafeConfiguration(), () => ({
    capabilities: { maxQuestions: 8, maxChoices: 255, maxBytes: 262144, questionTypes: ['noul'] },
    evaluate: async () => { throw new Error('provider outage') },
  }))
  assert.equal(await suppressStartupDialogForConversation(failing, 'gate-error', 'How have you been?', signal()), false)
  const abstaining = new DecisionService(typesafeConfiguration(), () => ({
    capabilities: { maxQuestions: 8, maxChoices: 255, maxBytes: 262144, questionTypes: ['choice', 'noul', 'score'] as const },
    evaluate: async () => ({ provider: 'typesafe', requestedModel: 'jev-latest', policyVersion: 'fixture',
      answers: [{ id: 'work-request-gate', status: 'abstained' as const, reason: 'uncertain' as const }] }),
  }))
  assert.equal(await suppressStartupDialogForConversation(abstaining, 'gate-abstain', 'How have you been?', signal()), false)
})

test('the startup dialog gate deduplicates a message within its turn', async () => {
  const calls: string[] = []
  const service = new DecisionService(typesafeConfiguration(), () => ({
    capabilities: { maxQuestions: 8, maxChoices: 255, maxBytes: 262144, questionTypes: ['choice', 'noul', 'score'] as const },
    evaluate: async batch => {
      const task = (batch.state as { task: string }).task
      calls.push(task)
      const probability = task === 'How have you been?' ? 0.05 : 0.9
      return { provider: 'typesafe', requestedModel: 'jev-latest', policyVersion: 'fixture',
        answers: [{ id: 'work-request-gate', status: 'measured' as const, type: 'noul' as const, probability }] }
    },
  }))
  const gate = createStartupConversationGate(service)
  assert.equal(await gate('gate-cache-1', 'How have you been?', signal()), true)
  assert.equal(await gate('gate-cache-1', 'How have you been?', signal()), true)
  assert.deepEqual(calls, ['How have you been?'], 'the same turn and message must not dispatch the provider twice')
  assert.equal(await gate('gate-cache-2', 'How have you been?', signal()), true)
  assert.equal(await gate('gate-cache-2', 'Fix the parser', signal()), false, 'a different message is evaluated separately')
  assert.deepEqual(calls, ['How have you been?', 'How have you been?', 'Fix the parser'])
})
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

for (const provider of ['typesafe', 'laya-coreml'] as const) {
  const config = () => provider === 'typesafe' ? TypedDecisionsConfig.parse({ provider }) : configuration()
  const requestedModel = provider === 'typesafe' ? 'jev-latest' : 'laya-rl-agent'
  test(`${provider}: prior-context continuations and unresolved alternatives defer before provider dispatch`, async () => {
    let calls = 0
    const service = new DecisionService(config(), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => {
      calls++
      return { provider, requestedModel, policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: 'debug' })) }
    } }))
    for (const task of ['yes', '続けて', 'Can you do that?', 'それを実装して', 'Fix the parser or build a replacement; I have not decided.', 'デバッグするか調査するかまだ迷っています']) {
      const classified = await classifyTaskForIntake(service, task, task, undefined, signal())
      assert.deepEqual(classified, { deferInference: true }, task)
      const grounded = resolveGroundedIntakeProfile({ task, cwd: process.cwd(), deferTaskTypeInference: classified.deferInference })
      assert.equal(grounded.profileHints.taskType, null, task)
    }
    assert.equal(calls, 0)
  })
  test(`${provider}: complete actionable requests keep their provider contract`, async () => {
    let calls = 0
    const task = 'Fix the failing parser in src/parser.ts and add regression tests.'
    const service = new DecisionService(config(), () => ({ capabilities: { maxQuestions: 2, maxChoices: 32, maxBytes: 262144, questionTypes: ['choice', 'noul'] }, evaluate: async batch => {
      calls++
      assert.deepEqual(batch.state, provider === 'typesafe' ? { task } : task)
      return { provider, requestedModel, policyVersion: 'fixture', answers: batch.questions.map(q => q.id === 'coding'
        ? { id: q.id, status: 'measured', type: 'noul', probability: 0.9 }
        : { id: q.id, status: 'selected', choiceId: 'debug' }) }
    } }))
    assert.deepEqual(await classifyTaskForIntake(service, 'complete', task, undefined, signal()), { taskType: 'debug', deferInference: false })
    assert.equal(calls, 1)
  })
  test(`${provider}: explicit task type and disabled classification retain precedence over deferral`, async () => {
    const service = new DecisionService(config(), () => { throw new Error('must not dispatch') })
    assert.deepEqual(await classifyTaskForIntake(service, 'explicit-continuation', 'yes', 'build', signal()), { taskType: 'build', deferInference: false })
    const off = config(); off.mode = 'off'
    const disabled = new DecisionService(off, () => { throw new Error('must not dispatch') })
    assert.deepEqual(await classifyTaskForIntake(disabled, 'disabled-continuation', 'yes', undefined, signal()), { deferInference: false })
    assert.deepEqual(await classifyTaskForIntake(undefined, 'absent', 'yes', undefined, signal()), { deferInference: false })
  })
}
