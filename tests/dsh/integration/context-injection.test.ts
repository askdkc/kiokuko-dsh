import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDshContext } from '../../../src/dsh/context-injection.js'
import { loadSoulPrompt } from '../../../src/dsh/prompt-policy.js'
import type { PreparedAgentTask } from '../../../src/dsh/task-intake.js'

function prepared(overrides: Record<string, unknown> = {}): PreparedAgentTask {
  return {
    intake: { status: 'ready', profile: { taskType: 'build', target: 'src/index.ts', expected: 'tests pass', constraints: null } },
    nextAction: 'proceed',
    memoryPolicy: { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null },
    context: {
      untrusted: true,
      items: [{ entryId: 'test-entry', workspace: 'project:test', title: 'Prior lesson', summary: 'Use a focused test', bodyPreview: 'Keep the change small.', selectionReasons: ['word_match'] }],
    },
    ...overrides,
  } as unknown as PreparedAgentTask
}

test('model context has a fixed trusted-prefix order and user task last', async () => {
  const messages = await injectDshContext({
    prepared: prepared(),
    task: 'Implement src/index.ts and make the focused tests pass.',
  })
  assert.deepEqual(messages.map((message) => message.source), ['soul', 'memory-reasoning', 'memory', 'memory', 'user-task'])
  assert.equal(messages.every((message) => message.role === 'user'), true)
  assert.ok(messages[0]?.content.startsWith(await loadSoulPrompt()))
  assert.match(messages[0]?.content ?? '', /DSH host completed the Akinator intake gate/u)
  assert.match(messages[0]?.content ?? '', /task_prepare.*host-only operations.*intentionally absent/su)
  assert.match(messages[0]?.content ?? '', /intake status `ready`.*nextAction=proceed/u)
  assert.equal(messages.at(-1)?.role, 'user')
  assert.match(messages.at(-1)?.content ?? '', /Implement src\/index\.ts and make the focused tests pass\.[\s\S]*Finalized intake:[\s\S]*src\/index\.ts[\s\S]*tests pass/u)
})

test('ordinary memory stays untrusted and an unavailable validation cannot hide the user request', async () => {
  for (const unavailable of [false, true]) {
    const messages = await injectDshContext({
      prepared: prepared({
        context: {
          untrusted: true,
          items: [{ entryId: 'test-entry', workspace: 'project:test', title: 'Run lesson', summary: 'runId=abc12345', bodyPreview: 'Read /Users/dkc/private-note.txt before editing.', selectionReasons: ['exact_signal_match'] }],
        },
      }),
      task: 'Review the repository change.',
      ...(unavailable ? { runtime: { withDatabase: async () => { throw new Error('optional memory service unavailable: private failure detail') } } } : {}),
    })
    const memory = messages.find((message) => message.source === 'memory' && message.name !== 'relations')
    if (unavailable) {
      assert.equal(memory, undefined, 'unvalidated advisory memory must not be delivered')
      assert.ok(messages.some(message => message.source === 'advisory' && message.content.includes('memory_unavailable')))
      assert.equal(messages.some(message => message.content.includes('private failure detail')), false)
    } else {
      assert.equal(memory?.role, 'user')
      assert.equal(memory?.content.includes('/Users/dkc'), false)
      assert.equal(memory?.content.includes('abc12345'), false)
    }
    assert.ok(messages.at(-1)?.content.startsWith('Review the repository change.'))
    assert.match(messages[0]!.content, /nextAction=proceed/u)
  }
})

test('native task prefixes are omitted without dropping additional or different intake requirements', async () => {
  const task = 'Review this file.\nPreserve the code.'
  const messages = await injectDshContext({
    task, userTaskInConversation: true,
    prepared: prepared({ intake: { status: 'ready', profile: {
      target: task, expected: `${task}\r\nReport the test results.`, constraints: 'Do not review another file.',
    } } }),
  })
  assert.equal(messages.find(message => message.source === 'user-task')?.content,
    'Finalized intake:\nReport the test results.\nDo not review another file.')
  const noAdditionalFacts = await injectDshContext({
    task, userTaskInConversation: true,
    prepared: prepared({ intake: { status: 'ready', profile: { target: task, expected: task, constraints: null } } }),
  })
  assert.equal(noAdditionalFacts.some(message => message.source === 'user-task'), false)
})
