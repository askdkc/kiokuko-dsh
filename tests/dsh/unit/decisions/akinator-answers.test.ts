import assert from 'node:assert/strict'
import test from 'node:test'
import { answerAkinatorQuestion } from '../../../../src/dsh/decisions/akinator-answers.js'
import type { AkinatorExpectedModel } from '../../../../src/dsh/decisions/akinator-expected.js'

const question = { id: 'expected', prompt: '完了条件は？', options: null, required: true } as const
const outcome = '出力がJSON形式になる。'
const clarification = '出力をJSON形式にしてください。'
function model(reply: unknown, inspect?: (request: any) => void): AkinatorExpectedModel {
  return { agent: { id: 'current-agent', model: { current: () => ({ provider: 'fixture', model: 'main' }) } },
    llm: { async *stream(request) { inspect?.(request); yield { type: 'text-delta', text: JSON.stringify(reply) }; yield { type: 'finish', reason: { kind: 'stop' } } } } }
}

test('completion inference uses the current clarification instead of asking for it again', async () => {
  const result = await answerAkinatorQuestion(undefined, 'current', '出力を改善してください。', question, new AbortController().signal,
    [clarification], '/repo', model({ expected: outcome, quote: clarification }, request => {
      assert.deepEqual(JSON.parse(request.messages[0].content[0].text), { request: '出力を改善してください。', evidence: [clarification] })
      assert.deepEqual(request.tools, [])
    }))
  assert.deepEqual(result, { status: 'answered', value: outcome, source: 'main-model' })
})

test('a quote from an absent clarification cannot become a completion condition', async () => {
  const result = await answerAkinatorQuestion(undefined, 'current', '出力を改善してください。', question, new AbortController().signal,
    [], '/repo', model({ expected: outcome, quote: clarification }))
  assert.equal(result.status, 'ask')
})

test('a genuinely unresolved outcome still asks instead of inventing a criterion', async () => {
  const result = await answerAkinatorQuestion(undefined, 'current', '出力を改善してください。', question, new AbortController().signal,
    ['形式はまだ決めていません。'], '/repo', model({ expected: null }))
  assert.equal(result.status, 'ask')
})

test('evidence beyond the inference envelope is not sent or used as supporting text', async () => {
  const result = await answerAkinatorQuestion(undefined, 'current', '出力を改善してください。', question, new AbortController().signal,
    ['x'.repeat(64 * 1024)], '/repo', model({ expected: outcome, quote: 'x' }, () => assert.fail('Oversized context must not be dispatched')))
  assert.equal(result.status, 'ask')
})

test('a cancelled request never asks the inference model', async () => {
  const controller = new AbortController()
  controller.abort(new Error('User stopped'))
  await assert.rejects(answerAkinatorQuestion(undefined, 'current', clarification, question, controller.signal, [], '/repo',
    model({ expected: outcome, quote: clarification }, () => assert.fail('Cancelled request must not be dispatched'))), /User stopped/)
})
