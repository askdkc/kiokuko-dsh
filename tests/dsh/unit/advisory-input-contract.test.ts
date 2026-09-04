import assert from 'node:assert/strict'
import test from 'node:test'
import { adviceSubmissionSchema } from '../../../src/enno-oduno/schemas.js'
import { advisorySlotDefinitions } from '../../../src/enno-oduno/advisory.js'
import type { AdvisoryPhase } from '../../../src/enno-oduno/types.js'

const contexts = [
  { phase: 'ideal', objective: 'line one\nline two', constraints: ['one\ntwo'], expectedOutcome: 'one\ntwo', successSignals: ['one\ntwo'], skillTrust: [] },
  { phase: 'planning', idealObjective: 'one\ntwo', acceptanceCriteria: ['one\ntwo'], planningConstraints: ['one\ntwo'], skillAvailability: [] },
]
const input = (context: unknown) => ({
  runId: 'run', workspace: 'workspace', orchestrationId: 'session', expectedRevision: 1, mutationRevision: 0, idempotencyKey: 'advice',
  phase: (context as { phase: string }).phase, allowlistedContext: context,
  contributions: advisorySlotDefinitions((context as { phase: AdvisoryPhase }).phase).map(slot => ({
    slotId: slot.slotId, outcome: 'unavailable', reasonCode: 'host_read_only_unavailable',
  })),
})

test('host advisory text preserves newlines, the full expected-outcome bound, and absent expectations', () => {
  for (const context of contexts) {
    const parsed = adviceSubmissionSchema.parse(input(context))
    assert.deepEqual(parsed.allowlistedContext, context)
  }
  for (const expectedOutcome of ['', 'x'.repeat(8_192)]) {
    const context = { ...contexts[0], expectedOutcome }
    assert.deepEqual(adviceSubmissionSchema.parse(input(context)).allowlistedContext, context)
  }
  assert.equal(adviceSubmissionSchema.safeParse(input({ ...contexts[0], expectedOutcome: 'x'.repeat(8_193) })).success, false)
})

test('multiline advice still rejects surrounding whitespace, CR, NUL, controls, and oversized criteria', () => {
  for (const value of [' leading', 'trailing ', 'one\r\ntwo', 'one\0two', 'one\u0001two', 'x'.repeat(8_193)]) {
    for (const context of [
      { ...contexts[0], expectedOutcome: value },
      { ...contexts[0], constraints: [value] },
      { ...contexts[0], successSignals: [value] },
      { ...contexts[1], acceptanceCriteria: [value] },
      { ...contexts[1], planningConstraints: [value] },
    ]) assert.equal(adviceSubmissionSchema.safeParse(input(context)).success, false, JSON.stringify(context))
  }
})
