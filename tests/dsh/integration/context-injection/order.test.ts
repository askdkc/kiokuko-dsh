import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDshContext } from '../../../../src/dsh/context-injection.js'
import type { PreparedAgentTask } from '../../../../src/dsh/task-intake.js'

test('context injection preserves the trusted prefix and places untrusted memory before the user task', async () => {
  const prepared = {
    intake: { status: 'ready', profile: { taskType: 'build', target: 'src/dsh', expected: 'focused checks pass', constraints: null } },
    nextAction: 'proceed',
    memoryPolicy: { memoryReasoningRequired: true, contextWithheld: false },
    context: { untrusted: true, items: [{ title: 'Prior lesson', summary: 'Keep boundaries explicit.', bodyPreview: 'Use a focused verifier.', selectionReasons: ['word_match'] }] },
  } as unknown as PreparedAgentTask
  const messages = await injectDshContext({
    prepared,
    task: 'Implement the requested change.',
    routeSkillNames: ['kiokuko-single-purpose-functions'],
  })
  assert.deepEqual(messages.map((message) => message.source), ['soul', 'memory-reasoning', 'route-skill', 'memory', 'user-task'])
  assert.equal(messages.every((message) => message.role === 'user'), true)
  assert.match(messages.at(-1)?.content ?? '', /Implement the requested change\.[\s\S]*Finalized intake:[\s\S]*src\/dsh[\s\S]*focused checks pass/u)
})
