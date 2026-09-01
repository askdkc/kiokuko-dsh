import assert from 'node:assert/strict'
import test from 'node:test'
import { STANDARD_SKILL_MANIFESTS } from '../../../../src/setup/standard-skills.js'
import { createDshCapabilityCatalog } from '../../../../src/dsh/capability-catalog.js'
import { DshIntakeGate, type DshPreStepEvent } from '../../../../src/dsh/intake-gate.js'

function unresolvedPreparedTask(): unknown {
  return {
    intake: {
      status: 'needs_answer',
      sessionId: 'session',
      question: { id: 'taskType', prompt: 'What kind of task is this?', options: ['build'] },
    },
    nextAction: 'answer_from_evidence_or_ask_user',
  }
}

test('pre-step rejects unresolved intake without invoking the downstream model', async () => {
  const capabilities = createDshCapabilityCatalog({
    skills: STANDARD_SKILL_MANIFESTS.map(({ name }) => ({ kind: 'skill' as const, name })),
    tools: [],
  })
  const runtime = {
    withDatabase: async <T,>(_operation: unknown): Promise<T> => unresolvedPreparedTask() as T,
  }
  const gate = new DshIntakeGate(runtime)
  const event: DshPreStepEvent = {
    agent: { id: 'agent' },
    turn: 1,
    step: 1,
    task: 'Please help with this task',
    cwd: '/repo',
    capabilities,
    signal: new AbortController().signal,
  }
  let downstreamCalls = 0
  const decision = await gate.preStep(event, async () => {
    downstreamCalls += 1
    return { kind: 'enter', messages: [] }
  })
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(downstreamCalls, 0)
})
