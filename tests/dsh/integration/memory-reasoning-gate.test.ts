import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDshContext } from '../../../src/dsh/context-injection.js'
import type { PreparedAgentTask } from '../../../src/akinator/agent-task.js'

function prepared(memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean }): PreparedAgentTask {
  return {
    intake: { status: 'exhausted', profile: { taskType: 'build', target: null, expected: null, constraints: null } },
    nextAction: 'proceed',
    memoryPolicy,
    context: { untrusted: true, items: [{ title: 'Actionable', summary: null, bodyPreview: 'Change the implementation.', selectionReasons: ['exact_signal_match'] }] },
  } as unknown as PreparedAgentTask
}

test('missing or unknown memory-reasoning withholds both required skill and ordinary memory', async () => {
  for (const policy of [
    { memoryReasoningRequired: true, contextWithheld: true },
    { memoryReasoningRequired: false, contextWithheld: true },
  ]) {
    const messages = await injectDshContext({ prepared: prepared(policy), task: 'Use current repository evidence.' })
    assert.equal(messages.some((message) => message.source === 'memory-reasoning'), false)
    assert.equal(messages.some((message) => message.source === 'memory'), false)
    assert.equal(messages.at(-1)?.source, 'user-task')
  }
})

test('available memory-reasoning permits memory only after the system Skill', async () => {
  const messages = await injectDshContext({ prepared: prepared({ memoryReasoningRequired: true, contextWithheld: false }), task: 'Use verified repository evidence.' })
  assert.equal(messages.findIndex((message) => message.source === 'memory-reasoning'), 1)
  assert.equal(messages.findIndex((message) => message.source === 'memory'), 2)
})
