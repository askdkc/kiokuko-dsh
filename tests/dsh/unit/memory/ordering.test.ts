import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDshContext } from '../../../../src/dsh/context-injection.js'
import type { PreparedAgentTask } from '../../../../src/dsh/task-intake.js'

function prepared(memoryPolicy: { memoryReasoningRequired: boolean; contextWithheld: boolean }): PreparedAgentTask {
  return {
    intake: { status: 'ready', profile: { taskType: 'build', target: null, expected: 'tests pass', constraints: null } },
    nextAction: 'proceed',
    memoryPolicy,
    context: { untrusted: true, items: [{ title: 'Prior', summary: null, bodyPreview: 'Use the verified repository evidence.', selectionReasons: ['word_match'] }] },
  } as unknown as PreparedAgentTask
}

test('withheld memory never reaches the model without memory-reasoning', async () => {
  const messages = await injectDshContext({
    prepared: prepared({ memoryReasoningRequired: true, contextWithheld: true }),
    task: 'Continue from current evidence.',
  })
  assert.deepEqual(messages.map((message) => message.source), ['soul', 'user-task'])
})
