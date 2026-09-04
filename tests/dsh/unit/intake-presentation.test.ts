import assert from 'node:assert/strict'
import test from 'node:test'
import { TASK_TYPES, type AkinatorQuestion } from '../../../src/akinator/types.js'
import { createDshIntakeAnswerer, type DshUserQuestionRequest } from '../../../src/dsh/user-interaction.js'

const question: AkinatorQuestion = { id: 'taskType', prompt: 'どれですか？', options: [...TASK_TYPES], required: true }

test('intake choices explain all eight task types and map display labels back to canonical answers', async () => {
  for (const [index, value] of TASK_TYPES.entries()) {
    const answerer = createDshIntakeAnswerer({ async ask(request) {
      const display = request.questions[0]
      assert.equal(display.header, 'Kiokuko · 作業の選択')
      assert.match(display.detail!, /ファイルを編集/u)
      assert.equal(display.options?.length, 8)
      for (const option of display.options!) assert.match(option.description!, /例：/u)
      return { answers: [{ id: question.id, selected: [display.options![index]!.label] }] }
    } })
    assert.equal(await answerer.ask(question), value)
  }
})

test('numeric and full-width answers use exactly the displayed option order', async () => {
  for (const [index, value] of TASK_TYPES.entries()) {
    for (const custom of [String(index + 1), String.fromCharCode(0xff11 + index)]) {
      const answerer = createDshIntakeAnswerer({ async ask() { return { answers: [{ id: question.id, selected: [], custom }] } } })
      assert.equal(await answerer.ask(question), value)
    }
  }
  for (const custom of ['0', '9', '9999999999999999999999999']) {
    const answerer = createDshIntakeAnswerer({ async ask() { return { answers: [{ id: question.id, selected: [], custom }] } } })
    await assert.rejects(answerer.ask(question), /番号は1〜8/u)
  }
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
