import assert from 'node:assert/strict'
import test from 'node:test'
import { createLispCodingChoice, type LispCodingInput } from '../../../../src/dsh/lisp/coding-choice.js'
import { ExecutionSelectionPending } from '../../../../src/dsh/model-selection-ui.js'

function fixture(answers: Array<{ selected: string[]; custom?: string }>) {
  const asked: string[] = [], effects: string[] = []
  let enabled = false, decided = false
  const service = createLispCodingChoice({
    questions: { ask: async request => {
      asked.push(request.questions[0].id)
      const answer = answers.shift()
      if (!answer) throw new Error('Unexpected repeated question')
      return { answers: [{ id: request.questions[0].id, ...answer }] }
    } },
    enabled: () => enabled, decided: async () => decided,
    decline: async () => { effects.push('decline'); decided = true },
    enable: async () => { effects.push('enable'); enabled = true; decided = true },
  })
  const input: LispCodingInput = { agent: { id: 'agent' }, task: 'Implement this', taskType: 'build', turn: 1, signal: new AbortController().signal }
  return { service, input, asked, effects }
}

test('first coding admission asks once and activates Lisp before returning; exact retries share the result', async () => {
  const f = fixture([{ selected: ['Lispモードを使う（通常実行）'] }])
  const [first, retry] = await Promise.all([f.service.prepare(f.input), f.service.prepare(f.input)])
  assert.equal(first.taskType, 'build')
  assert.equal(first, retry)
  assert.deepEqual(f.asked, ['lisp-coding-mode'])
  assert.deepEqual(f.effects, ['enable'])
  assert.equal(f.service.enabled(f.input.agent), true)
  await f.service.prepare({ ...f.input, turn: 2 })
  assert.deepEqual(f.asked, ['lisp-coding-mode'])
})

test('unclear intent is resolved before Lisp choice; declining persists across coding turns', async () => {
  const f = fixture([{ selected: ['実装・変更'] }, { selected: ['Lispモードを使わない'] }])
  const result = await f.service.prepare({ ...f.input, taskType: null })
  assert.equal(result.taskType, 'build')
  assert.deepEqual(f.asked, ['taskType', 'lisp-coding-mode'])
  await f.service.prepare({ ...f.input, turn: 2, taskType: 'debug' })
  assert.deepEqual(f.effects, ['decline'])
  assert.equal(f.asked.length, 2)
})

test('conversation and reviews do not prompt; free text returns to conversation without activation', async () => {
  const f = fixture([{ selected: [], custom: 'ただのチャット' }, { selected: ['Lispモードを使わない'] }])
  await f.service.prepare({ ...f.input, turn: 1, taskType: 'chat' })
  await f.service.prepare({ ...f.input, turn: 2, taskType: 'review' })
  assert.equal(f.asked.length, 0)
  const result = await f.service.prepare({ ...f.input, turn: 3 })
  assert.deepEqual(result, { taskType: 'chat', clarification: 'ただのチャット' })
  assert.deepEqual(f.effects, [])
  assert.equal(f.service.discussing(f.input.agent), true)
  await f.service.prepare({ ...f.input, turn: 4, taskType: 'chat' })
  assert.equal(f.asked.length, 1)
  await f.service.prepare({ ...f.input, turn: 5 })
  assert.deepEqual(f.effects, ['decline'])
  assert.equal(f.service.discussing(f.input.agent), false)
})

test('cancellation, unavailable UI and activation failure never admit coding or choose a default', async () => {
  const f = fixture([{ selected: ['取消・作業を保持'] }])
  await assert.rejects(f.service.prepare(f.input), ExecutionSelectionPending)
  assert.deepEqual(f.effects, [])
  const unavailable = createLispCodingChoice({ enabled: () => false, decided: async () => false,
    enable: async () => { throw new Error('must not enable') }, decline: async () => { throw new Error('must not decline') },
  })
  await assert.rejects(unavailable.prepare(f.input), ExecutionSelectionPending)
  const failed = createLispCodingChoice({ enabled: () => false, decided: async () => false,
    questions: { ask: async () => ({ answers: [{ id: 'lisp-coding-mode', selected: ['Lispモードを使う（通常実行）'] }] }) },
    enable: async () => { throw new Error('SBCL startup failed') }, decline: async () => {},
  })
  await assert.rejects(failed.prepare(f.input), /SBCL startup failed/)
})
