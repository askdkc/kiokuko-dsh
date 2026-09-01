import assert from 'node:assert/strict'
import test from 'node:test'
import { DshAdvisoryRunner } from '../../../../src/dsh/advisory-runner.js'
import { advisorySlotDefinitions } from '../../../../src/enno-oduno/advisory.js'

test('advisory execution is fixed-slot, read-only, and strips unsafe output', async () => {
  const calls: Array<{ slotId: string; tools: readonly [] }> = []
  const result = await new DshAdvisoryRunner({
    verifyReadOnly: () => true,
    execute: async (call) => {
      calls.push({ slotId: call.slotId, tools: call.tools })
      return { slotId: call.slotId, outcome: 'completed', summary: 'ok', recommendations: [] }
    },
  }).run({
    directive: {
      protocolVersion: 1, phase: 'planning', policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true,
      context: { phase: 'planning', idealObjective: 'x', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [] },
      slots: advisorySlotDefinitions('planning'),
    },
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((call) => call.slotId), advisorySlotDefinitions('planning').map((slot) => slot.slotId))
  assert.equal(calls.every((call) => call.tools.length === 0), true)
  assert.equal(result.degraded, false)

  const unsafe = await new DshAdvisoryRunner({
    verifyReadOnly: () => true,
    execute: async (call) => ({ slotId: call.slotId, outcome: 'completed', summary: 'apiKey=secret-value', recommendations: [] }),
  }).run({
    directive: {
      protocolVersion: 1, phase: 'planning', policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true,
      context: { phase: 'planning', idealObjective: 'x', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [] },
      slots: advisorySlotDefinitions('planning'),
    },
  })
  assert.equal(unsafe.contributions.every((contribution) => contribution.reasonCode === 'unsafe_output'), true)
})

test('unknown slot layouts fail closed before advisor execution', async () => {
  let executed = false
  const runner = new DshAdvisoryRunner({ verifyReadOnly: () => true, execute: async () => { executed = true; return {} } })
  await assert.rejects(runner.run({
    directive: {
      protocolVersion: 1, phase: 'planning', policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true,
      context: { phase: 'planning', idealObjective: 'x', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [] },
      slots: [],
    },
  }), /fixed core slot set/u)
  assert.equal(executed, false)
})
