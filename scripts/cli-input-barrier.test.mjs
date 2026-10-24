import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInputBarrier, inputWasHandled, createQuestionObserver, questionWasAnswered, createQuestionSelection } from './cli-input-barrier.mjs'

test('delayed PTY processing cannot spend the debounce interval before handling', () => {
  let time = 0, handled = false, writes = 0
  const gate = createInputBarrier({ now: () => time })
  assert.equal(gate.ready(), true)
  gate.submitted(() => handled); writes++
  time = 104 // Original CI command ran 104 ms after the write.
  assert.equal(gate.ready(), false)
  handled = true
  time = 128
  assert.equal(gate.ready(), false)
  time = 173 // Old write-relative pacing submitted 67 ms after command completion.
  assert.equal(gate.ready(), false)
  assert.throws(() => gate.submitted(() => true), /not settled/)
  time = 228
  assert.equal(gate.ready(), true)
  gate.submitted(() => false); writes++
  time += 10000
  assert.equal(gate.ready(), false, 'unacknowledged input is never retried')
  assert.equal(writes, 2)
})

test('each submission and question selection requires its own fresh observation', () => {
  let time = 0, frame = 1, questionVisible = true
  const gate = createInputBarrier({ now: () => time })
  gate.submitted(() => frame > 1 && !questionVisible)
  time = 1000; frame++
  assert.equal(gate.ready(), false, 'unrelated repaint is not an acknowledgement')
  questionVisible = false
  assert.equal(gate.ready(), false)
  time += 100
  assert.equal(gate.ready(), true)
  gate.submitted(() => false)
  assert.equal(gate.ready(), false, 'prior acknowledgement cannot unlock new submission')
})


test('composer acknowledgement rejects stale frames and requires a visible fresh question takeover', () => {
  let time = 0
  const state = { submittedFrame: 5, frame: 5, composer: 'hello', freshQuestionVisible: false }
  const gate = createInputBarrier({ now: () => time })
  gate.submitted(() => inputWasHandled(state))
  state.composer = ''
  assert.equal(gate.ready(), false, 'empty value without a new frame is stale')
  state.frame++; state.composer = undefined
  assert.equal(gate.ready(), false, 'missing composer alone proves nothing')
  state.freshQuestionVisible = true
  assert.equal(gate.ready(), false, 'question takeover starts, not skips, settling')
  time = 100
  assert.equal(gate.ready(), true)
  assert.equal(inputWasHandled({ ...state, composer: 'hello' }), false)
  assert.equal(inputWasHandled({ ...state, composer: '', freshQuestionVisible: false }), true)
})

test('write-relative baseline drops delayed second Enter; acknowledgement pacing admits exactly once', () => {
  let lastHandled = -Infinity, accepted = 0
  const handle = time => { if (time - lastHandled < 80) return; lastHandled = time; accepted++ }
  handle(104)
  handle(171) // More than 100 ms since the first write, only 67 since handling.
  assert.equal(accepted, 1, 'baseline reproduces the debounce loss')
  let time = 0, observed = false
  const gate = createInputBarrier({ now: () => time })
  gate.submitted(() => observed)
  time = 128; observed = true
  assert.equal(gate.ready(), false)
  time = 171
  assert.equal(gate.ready(), false)
  time = 228
  assert.equal(gate.ready(), true)
  handle(time)
  assert.equal(accepted, 2)
})

test('a matching answer settles once even when its question remains in transcript history', async () => {
  const events = [], observe = createQuestionObserver(event => events.push(event))
  const question = { id: 'execution', question: 'この作業をどう実行しますか', options: [{ label: '通常実行' }] }
  const answer = { answers: [{ id: question.id, selected: ['通常実行'] }] }
  let resolve, time = 0, writes = 0
  const result = observe({ questions: [question] }, () => new Promise(done => { resolve = done }))
  const requestSequence = events[0].requestSequence, eventOffset = events.length
  const screen = `📋 Questionnaire answered\n${question.question} → 通常実行\n📋 Question 1/1\n今回は保存しない`
  const gate = createInputBarrier({ now: () => time })
  gate.submitted(() => questionWasAnswered({ events, eventOffset, requestSequence, questionId: question.id, selected: ['通常実行'] })); writes++
  time = 1000
  assert.equal(gate.ready(), false, 'elapsed time and historical text cannot acknowledge a request')
  resolve(answer)
  assert.equal(await result, answer, 'middleware preserves the original answer object')
  assert.ok(screen.includes(question.question), 'the old whole-screen disappearance predicate remains false')
  assert.equal(gate.ready(), false, 'the response starts the settling interval')
  time += 99; assert.equal(gate.ready(), false)
  time++; assert.equal(gate.ready(), true)
  assert.equal(writes, 1, 'a pending selection is never retried')
})

test('stale same-ID answers and unrelated request responses cannot unlock a new selection', async () => {
  const events = [], observe = createQuestionObserver(event => events.push(event))
  const request = { questions: [{ id: 'repeated-id' }] }
  const answer = { answers: [{ id: 'repeated-id', selected: ['今回は保存しない'] }] }
  await observe(request, async () => answer)
  let resolve
  const pending = observe(request, () => new Promise(done => { resolve = done }))
  const requestSequence = events.at(-1).requestSequence, eventOffset = events.length
  const state = { events, eventOffset, requestSequence, questionId: 'repeated-id', selected: ['今回は保存しない'] }
  assert.equal(questionWasAnswered(state), false, 'a prior same-ID request is a different instance')
  await observe(request, async () => answer)
  assert.equal(questionWasAnswered(state), false, 'an unrelated current response is also a different instance')
  resolve(answer); await pending
  assert.equal(questionWasAnswered(state), true)
  assert.equal(questionWasAnswered({ ...state, eventOffset: events.length }), false, 'a pre-submit answer is stale')
  assert.equal(questionWasAnswered({ ...state, questionId: 'other-id' }), false)
  assert.equal(questionWasAnswered({ ...state, selected: ['整理して確認する'] }), false, 'the expected decline must actually be selected')
})

test('an immediate next question does not hide the previous request response or acknowledge the next one', async () => {
  const events = [], observe = createQuestionObserver(event => events.push(event))
  const request = { questions: [{ id: 'same-id' }] }, answer = { answers: [{ id: 'same-id', selected: ['通常実行'] }] }
  let firstResolve, secondResolve
  const first = observe(request, () => new Promise(done => { firstResolve = done }))
  const firstSequence = events.at(-1).requestSequence, firstOffset = events.length
  firstResolve(answer)
  const second = observe(request, () => new Promise(done => { secondResolve = done }))
  const secondSequence = events.at(-1).requestSequence, secondOffset = events.length
  await first
  const state = { events, questionId: 'same-id', selected: ['通常実行'] }
  assert.equal(questionWasAnswered({ ...state, eventOffset: firstOffset, requestSequence: firstSequence }), true)
  assert.equal(questionWasAnswered({ ...state, eventOffset: secondOffset, requestSequence: secondSequence }), false)
  secondResolve(answer); await second
  assert.equal(questionWasAnswered({ ...state, eventOffset: secondOffset, requestSequence: secondSequence }), true)
})

test('cancellation and rejection keep their identity and never confirm a decline', async () => {
  for (const code of ['ASK_CANCELLED', 'ASK_ABORTED', 'UNEXPECTED']) {
    const events = [], observe = createQuestionObserver(event => events.push(event))
    const error = Object.assign(new Error(code), { code })
    let calls = 0
    const pending = observe({ questions: [{ id: 'memory' }] }, () => { calls++; return Promise.reject(error) })
    const requestSequence = events[0].requestSequence, eventOffset = events.length
    await assert.rejects(pending, actual => actual === error)
    assert.equal(calls, 1)
    assert.equal(events.at(-1).outcome, 'rejected')
    assert.equal(events.at(-1).code, code)
    assert.equal(questionWasAnswered({ events, eventOffset, requestSequence, questionId: 'memory', selected: ['今回は保存しない'] }), false)
  }
})

const options = ['整理して確認する', '今回は保存しない', '第三の選択']
const question = { question: 'Choose the intended option', options: options.map(label => ({ label })) }
const panel = index => `────▾  📋 Question 1/1   ────\nChoose the intended option\n${options.map((label, i) => `${i === index ? '❯●' : ' ○'} ${label}`).join('\n')}`

test('selection waits for the exact post-navigation focus, not time or unrelated output', () => {
  const select = createQuestionSelection(question, options[1])
  assert.equal(select({ screen: panel(0), frame: 10 }), 'down')
  assert.equal(select({ screen: panel(0), frame: 1000 }), undefined, 'delayed PTY processing must not submit or retry Down')
  assert.equal(select({ screen: panel(1), frame: 10 }), undefined, 'a stale rendered frame cannot acknowledge navigation')
  assert.equal(select({ screen: panel(2), frame: 1001 }), undefined, 'wrong focus cannot acknowledge navigation')
  assert.equal(select({ screen: panel(1), frame: 1002 }), 'submit')
  assert.equal(select({ screen: panel(1), frame: 1003 }), undefined, 'submit exactly once')
})

test('default, reverse and multiple-step option selection share the same barrier', () => {
  assert.equal(createQuestionSelection(question, options[0])({ screen: panel(0), frame: 1 }), 'submit')
  const reverse = createQuestionSelection(question, options[0])
  assert.equal(reverse({ screen: panel(2), frame: 1 }), 'up')
  assert.equal(reverse({ screen: panel(2), frame: 2 }), undefined)
  assert.equal(reverse({ screen: panel(1), frame: 3 }), 'up')
  assert.equal(reverse({ screen: panel(0), frame: 3 }), undefined)
  assert.equal(reverse({ screen: panel(0), frame: 4 }), 'submit')
})

test('history, absent or ambiguous selection and closed requests cannot cause submission', () => {
  const select = createQuestionSelection(question, options[1])
  for (const screen of ['', options[1], `📋 Questionnaire answered\n❯● ${options[1]}`,
    `📋 Question 1/1\n❯● ${options[1]} suffix`, `${panel(1)}\n❯● ${options[0]}`]) {
    assert.equal(select({ screen, frame: 1 }), undefined)
  }
  assert.equal(select({ screen: panel(1), frame: 1, active: false }), undefined)
  assert.equal(select({ screen: panel(1), frame: 2 }), 'submit')
  assert.throws(() => createQuestionSelection(question, 'missing'), /single-select/)
  assert.throws(() => createQuestionSelection({ ...question, multiSelect: true }, options[0]), /single-select/)
  assert.throws(() => createQuestionSelection({ options: [{ label: 'x' }, { label: 'x' }] }, 'x'), /single-select/)
})


test('another active panel with identical options cannot reuse historical question text', () => {
  const select = createQuestionSelection(question, options[1])
  const other = panel(1).replace(question.question, 'A different question')
  assert.equal(select({ screen: other, frame: 1 }), undefined)
  assert.equal(select({ screen: `${question.question}\n${other}`, frame: 2 }), undefined)
  assert.equal(select({ screen: `${panel(1)}\n${other}`, frame: 3 }), undefined)
  assert.equal(select({ screen: panel(1), frame: 4 }), 'submit')
})
