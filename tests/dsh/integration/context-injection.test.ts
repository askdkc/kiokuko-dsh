import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDshContext } from '../../../src/dsh/context-injection.js'
import { loadSoulPrompt } from '../../../src/dsh/prompt-policy.js'
import type { PreparedAgentTask } from '../../../src/akinator/agent-task.js'

function prepared(overrides: Record<string, unknown> = {}): PreparedAgentTask {
  return {
    intake: { status: 'ready', profile: { taskType: 'build', target: 'src/index.ts', expected: 'tests pass', constraints: null } },
    nextAction: 'proceed',
    memoryPolicy: { memoryReasoningRequired: true, contextWithheld: false, withheldReason: null },
    context: {
      untrusted: true,
      items: [{ title: 'Prior lesson', summary: 'Use a focused test', bodyPreview: 'Keep the change small.', selectionReasons: ['word_match'] }],
    },
    ...overrides,
  } as unknown as PreparedAgentTask
}

test('model context has a fixed trusted-prefix order and user task last', async () => {
  const messages = await injectDshContext({
    prepared: prepared(),
    task: 'Implement src/index.ts and make the focused tests pass.',
    routeSkillNames: ['kiokuko-single-purpose-functions'],
    expertRefs: [{ skillName: 'kiokuko-single-purpose-functions', relativePath: 'references/problem-shaping-and-language.md' }],
  })
  assert.deepEqual(messages.map((message) => message.source), ['soul', 'memory-reasoning', 'route-skill', 'expert', 'memory', 'user-task'])
  assert.equal(messages[0]?.content, await loadSoulPrompt())
  assert.equal(messages.at(-1)?.role, 'user')
  assert.match(messages.at(-1)?.content ?? '', /Implement src\/index\.ts and make the focused tests pass\.[\s\S]*Finalized intake:[\s\S]*src\/index\.ts[\s\S]*tests pass/u)
})

test('ordinary memory remains untrusted and removes path/internal-id material', async () => {
  const messages = await injectDshContext({
    prepared: prepared({
      context: {
        untrusted: true,
        items: [{ title: 'Run lesson', summary: 'runId=abc12345', bodyPreview: 'Read /Users/dkc/private-note.txt before editing.', selectionReasons: ['exact_signal_match'] }],
      },
    }),
    task: 'Review the repository change.',
  })
  const memory = messages.find((message) => message.source === 'memory')
  assert.equal(memory?.role, 'system')
  assert.equal(memory?.content.includes('/Users/dkc'), false)
  assert.equal(memory?.content.includes('abc12345'), false)
})
