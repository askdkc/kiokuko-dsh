import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlanStartRecovery, renderPlanStartRecovery } from '../../../src/enno-oduno/plan-recovery.js'
import { renderDshPlanRecovery } from '../../../src/dsh/user-interaction.js'

test('plan recovery presents all choices without starting work', () => {
  const recovery = buildPlanStartRecovery('environment_changed')
  const text = renderDshPlanRecovery(recovery)
  assert.equal(text, renderPlanStartRecovery(recovery))
  assert.match(text, /Restart the same plan/u)
  assert.match(text, /Review the plan before restarting/u)
  assert.match(text, /Cancel/u)
  assert.equal(recovery.effect.mutationApplied, false)
  assert.equal(recovery.effect.implementationStarted, false)
  assert.equal(text.includes('runId'), false)
})
