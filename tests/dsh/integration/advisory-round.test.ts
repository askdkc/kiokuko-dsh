import assert from 'node:assert/strict'
import test from 'node:test'
import { DshAdvisoryRunner } from '../../../src/dsh/advisory-runner.js'
import { advisorySlotDefinitions } from '../../../src/enno-oduno/advisory.js'

test('aborted advisory round produces no completed contribution and never invokes advisor tools', async () => {
  const abort = new AbortController()
  abort.abort()
  let executions = 0
  const result = await new DshAdvisoryRunner({
    verifyReadOnly: () => true,
    execute: async () => { executions++; return {} },
  }).run({
    signal: abort.signal,
    directive: {
      protocolVersion: 1, phase: 'planning', policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true,
      context: { phase: 'planning', idealObjective: 'x', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [] },
      slots: advisorySlotDefinitions('planning'),
    },
  })
  assert.equal(executions, 0)
  assert.equal(result.contributions.every((contribution) => contribution.reasonCode === 'host_execution_failed'), true)
  assert.equal(result.degraded, true)
})

test('a round result is a projection for one host submission and has no run identity fields', async () => {
  const result = await new DshAdvisoryRunner({
    verifyReadOnly: () => true,
    execute: async (call) => ({ slotId: call.slotId, outcome: 'unavailable', reasonCode: 'host_read_only_unavailable' as const }),
  }).run({
    directive: {
      protocolVersion: 1, phase: 'final_review', policyVersion: 1, readOnlyRequired: true, hostMustVerifyIsolation: true,
      context: { phase: 'final_review', workPlanSummary: 'x', acceptanceCriteria: [], workUnitOutcomes: [], changedPaths: [], verifierEvidence: [], freshnessMarker: 'fresh', evidenceSetDigest: 'a'.repeat(64), repositoryStateDigest: 'b'.repeat(64), evidenceFreshnessPolicyVersion: 1 },
      slots: advisorySlotDefinitions('final_review'),
    },
  })
  assert.deepEqual(Object.keys(result).sort(), ['contributions', 'degraded', 'inputDigest', 'phase'])
  assert.equal(result.contributions.length, 3)
  assert.equal(result.contributions.every((contribution) => contribution.outcome === 'unavailable'), true)
})
