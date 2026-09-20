import assert from 'node:assert/strict'
import test from 'node:test'
import { executeCheckModel } from '../../../../src/dsh/decisions/check-model.js'
import type { DshAdvisoryCall } from '../../../../src/dsh/advisory-runner.js'
const call: DshAdvisoryCall = { phase: 'planning', slotId: 'workunit_architect', rank: 0, role: 'reviewer', instructions: 'Review all evidence', context: { phase: 'planning', idealObjective: 'Goal', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [], candidate: { scope: ['complete plan'] } }, tools: [], signal: new AbortController().signal }
test('check fallback uses exact binding, complete candidate and no tools; truncated or effectful streams fail', async () => {
  const binding = { provider: 'exact-provider', model: 'exact-model', reasoningEffort: 'high' }
  const result = await executeCheckModel({ async *stream(request) {
    assert.equal(request.provider, binding.provider); assert.equal(request.model, binding.model); assert.equal(request.reasoningEffort, binding.reasoningEffort)
    assert.deepEqual(request.tools, []); assert.match(JSON.stringify(request.messages), /complete plan/)
    yield { type: 'text-delta', text: '{"checked":true}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }, binding, call)
  assert.deepEqual(result, { checked: true })
  for (const end of [{ type: 'finish', reason: { kind: 'length' } }, { type: 'tool-call' }, { type: 'error' }, { type: 'other' }]) {
    await assert.rejects(executeCheckModel({ async *stream() { yield { type: 'text-delta', text: '{}' }; yield end } }, binding, call))
  }
})
