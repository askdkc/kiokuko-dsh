import assert from 'node:assert/strict'
import test from 'node:test'
import { TASK_TYPES, type AkinatorQuestion } from '../../../src/akinator/types.js'
import { createDshIntakeAnswerer, type DshUserQuestionRequest } from '../../../src/dsh/user-interaction.js'

const question: AkinatorQuestion = { id: 'taskType', prompt: 'どれですか？', options: [...TASK_TYPES], required: true }

const displayed = ['実装・変更', '不具合調査、情報調査', '文章作成', '質問、相談、会話']
const values = ['build', 'research', 'writing', 'chat']

test('four concise intake choices map their labels to the corresponding task categories', async () => {
  for (const [index, value] of values.entries()) {
    const answerer = createDshIntakeAnswerer({ async ask(request) {
      const display = request.questions[0]
      assert.equal(display.header, 'Kiokuko · 作業の選択')
      assert.equal(display.detail, undefined)
      assert.deepEqual(display.options?.map(option => option.label), displayed)
      return { answers: [{ id: question.id, selected: [display.options![index]!.label] }] }
    } })
    assert.equal(await answerer.ask(question), value)
  }
})

test('numeric and full-width answers use exactly the four displayed choices, not the old eight-type order', async () => {
  for (const [index, value] of values.entries()) {
    for (const custom of [String(index + 1), String.fromCharCode(0xff11 + index)]) {
      const answerer = createDshIntakeAnswerer({ async ask() { return { answers: [{ id: question.id, selected: [], custom }] } } })
      assert.equal(await answerer.ask(question), value)
    }
  }
  for (const custom of ['0', '5', '8', '9', '9999999999999999999999999']) {
    const answerer = createDshIntakeAnswerer({ async ask() { return { answers: [{ id: question.id, selected: [], custom }] } } })
    await assert.rejects(answerer.ask(question), /番号は1〜4/u)
  }
})

test('restricted task-type questions return only allowed types in their displayed order', async () => {
  const answerer = createDshIntakeAnswerer({ async ask(request) {
    assert.deepEqual(request.questions[0].options?.map(option => option.label), displayed.slice(0, 2))
    return { answers: [{ id: question.id, selected: [], custom: '2' }] }
  } })
  assert.equal(await answerer.ask({ ...question, options: ['debug', 'build'] }), 'debug')
})

test('free-form answers, skip-to-chat, question identity, cancellation, and optionless examples remain intact', async () => {
  for (const custom of ['原因を調べて', 'build', '']) {
    const answerer = createDshIntakeAnswerer({ async ask() { return { answers: [{ id: question.id, selected: [], custom }] } } })
    assert.equal(await answerer.ask(question), custom || 'chat')
  }
  for (const id of ['target', 'expected'] as const) {
    let captured: DshUserQuestionRequest | undefined
    const answerer = createDshIntakeAnswerer({ async ask(request) {
      captured = request
      return { answers: [{ id, selected: [], custom: '123' }] }
    } })
    assert.equal(await answerer.ask({ ...question, id, options: null }), '123')
    assert.match(captured!.questions[0].detail!, /例：/u)
    assert.equal(captured!.questions[0].options, undefined)
  }
  await assert.rejects(createDshIntakeAnswerer({ async ask() { throw new Error('ASK_CANCELLED') } }).ask(question), /ASK_CANCELLED/u)
  await assert.rejects(createDshIntakeAnswerer({ async ask() { return { answers: [{ id: 'wrong', selected: ['1'] }] } } }).ask(question), /does not match/u)
})
