import assert from 'node:assert/strict'
import test from 'node:test'
import { selectExecution, ExecutionSelectionPending } from '../../../src/dsh/model-selection-ui.js'
import type { StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'

const revision = (value: StoredExecutionSelection['value'], at = 0): StoredExecutionSelection => ({ revision: at, value })

test('a pending selection becomes durably ready without any question', async () => {
  let saved: StoredExecutionSelection | undefined
  const result = await selectExecution({
    signal: new AbortController().signal,
    stored: revision({ mode: 'pending', status: 'selecting' }),
    save: async (at, value) => (saved = { revision: at + 1, value }),
  })
  assert.equal(result.value.mode, 'normal')
  assert.equal(result.value.status, 'ready')
  assert.equal(saved?.revision, 1)
  assert.equal(saved?.value.status, 'ready')
})

test('a ready selection returns unchanged without saving', async () => {
  const current = revision({ mode: 'normal', status: 'ready' }, 3)
  const result = await selectExecution({
    signal: new AbortController().signal,
    stored: current,
    save: async () => { throw new Error('ready selection must not be written again') },
  })
  assert.equal(result, current)
})

test('an aborted turn stays pending without writing', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(selectExecution({
    signal: controller.signal,
    stored: revision({ mode: 'pending', status: 'selecting' }),
    save: async () => { throw new Error('aborted run must not write a selection') },
  }), ExecutionSelectionPending)
})

test('a legacy discussion selection resolves to normal without a question', async () => {
  let saved: StoredExecutionSelection | undefined
  const result = await selectExecution({
    signal: new AbortController().signal,
    stored: revision({
      mode: 'pending', status: 'selecting',
      discussion: { questionId: 'execution-mode', text: 'ただのチャット', turn: 1 },
    }),
    save: async (at, value) => (saved = { revision: at + 1, value }),
  })
  assert.equal(result.value.status, 'ready')
  assert.equal(result.value.discussion, undefined)
})

test('a legacy reselect keeps an existing head/worker pair and ordinary model while it becomes ready', async () => {
  let saved: StoredExecutionSelection | undefined
  const pair = {
    preset: 'gpt-6.1-sol-deepseek-v4.1-flash' as const,
    head: { provider: 'head', model: 'gpt-6.1-sol' },
    worker: { provider: 'worker', model: 'deepseek-flash' },
  }
  const result = await selectExecution({
    signal: new AbortController().signal,
    stored: revision({
      mode: 'normal', status: 'reselect',
      ordinaryModel: { provider: 'head', model: 'gpt-6.1-sol' },
      headWorker: pair,
    }, 2),
    save: async (at, value) => (saved = { revision: at + 1, value }),
  })
  assert.deepEqual(saved, { revision: 3, value: {
    mode: 'normal', status: 'ready',
    ordinaryModel: { provider: 'head', model: 'gpt-6.1-sol' },
    headWorker: pair,
  } })
})
