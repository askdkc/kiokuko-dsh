import assert from 'node:assert/strict'
import test from 'node:test'
import { advisorySlotDefinitions } from '../../../src/enno-oduno/advisory.js'
import { DshAdvisoryRunner, type DshAdvisoryCall } from '../../../src/dsh/advisory-runner.js'
import type { AdvisoryContext, AdvisoryFanoutDirective, AdvisoryPhase } from '../../../src/enno-oduno/types.js'

function context(phase: AdvisoryPhase): AdvisoryContext {
  if (phase === 'ideal') return { phase, objective: 'objective', constraints: [], expectedOutcome: 'pass', successSignals: [], skillTrust: [] }
  if (phase === 'planning') return { phase, idealObjective: 'objective', acceptanceCriteria: ['pass'], planningConstraints: [], skillAvailability: [] }
  return {
    phase, workPlanSummary: 'plan', acceptanceCriteria: [], workUnitOutcomes: [], changedPaths: [], verifierEvidence: [],
    freshnessMarker: 'fresh', evidenceSetDigest: 'a'.repeat(64), repositoryStateDigest: 'b'.repeat(64), evidenceFreshnessPolicyVersion: 1,
  }
}

function directive(phase: AdvisoryPhase, slots = advisorySlotDefinitions(phase)): AdvisoryFanoutDirective {
  return { protocolVersion: 1, phase, policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true, context: context(phase), slots }
}

function completed(slotId: string, summary = 'ok') {
  return { slotId, outcome: 'completed' as const, summary, recommendations: [], risks: [], evidence: [] }
}

test('advisory calls expose only allowlisted context and empty tools across exactly three fixed slots', async () => {
  const calls: DshAdvisoryCall[] = []
  let active = 0
  let maxActive = 0
  const result = await new DshAdvisoryRunner({
    verifyReadOnly: (call) => { calls.push(call); return true },
    execute: async (call) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      return completed(call.slotId)
    },
  }).run({ directive: directive('ideal') })
  assert.equal(calls.length, 3)
  assert.ok(maxActive > 1)
  assert.deepEqual(calls.map((call) => call.slotId), ['constraint_guardian', 'skill_trust_analyst', 'success_signal_critic'])
  for (const call of calls) {
    assert.deepEqual(call.tools, [])
    assert.deepEqual(Object.keys(call).sort(), ['context', 'instructions', 'phase', 'rank', 'role', 'signal', 'slotId', 'tools'])
  }
  assert.equal(result.contributions.every((contribution) => contribution.outcome === 'completed'), true)
  assert.equal(result.degraded, false)
})

test('isolation, malformed, secret, and oversized outputs become bounded slot failures', async () => {
  const slots = advisorySlotDefinitions('ideal')
  const result = await new DshAdvisoryRunner({
    verifyReadOnly: (call) => call.slotId !== 'skill_trust_analyst',
    execute: async (call) => call.slotId === 'constraint_guardian'
      ? completed(call.slotId, 'password=hunter2secretvalue')
      : {},
  }).run({ directive: directive('ideal', slots) })
  assert.deepEqual(result.contributions, [
    { slotId: 'constraint_guardian', outcome: 'failed', reasonCode: 'unsafe_output' },
    { slotId: 'skill_trust_analyst', outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' },
    { slotId: 'success_signal_critic', outcome: 'failed', reasonCode: 'invalid_response' },
  ])
  assert.equal(JSON.stringify(result).includes('hunter2secretvalue'), false)
  const oversized = await new DshAdvisoryRunner({
    verifyReadOnly: () => true,
    execute: async (call) => completed(call.slotId, 'x'.repeat(20_000)),
  }).run({ directive: directive('ideal') })
  assert.equal(oversized.contributions.every((contribution) => contribution.reasonCode === 'invalid_response'), true)
})

test('fixed-slot mismatch and timeout fail closed', async () => {
  const duplicate = advisorySlotDefinitions('ideal').map((slot, index) => index === 1 ? { ...slot, slotId: 'constraint_guardian' as const } : slot)
  await assert.rejects(new DshAdvisoryRunner({ verifyReadOnly: () => true, execute: async () => completed('constraint_guardian') }).run({ directive: directive('ideal', duplicate) }), /fixed core slot set/u)
  const result = await new DshAdvisoryRunner({
    timeoutMs: 5,
    verifyReadOnly: () => true,
    execute: async () => new Promise(() => undefined),
  }).run({ directive: directive('ideal') })
  assert.equal(result.contributions.every((contribution) => contribution.reasonCode === 'host_timeout'), true)
})
