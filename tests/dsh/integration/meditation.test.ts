import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../src/dsh/enno-controller.js'
import type { EnnoOdunoState } from '../../../src/enno-oduno/types.js'

function state(nextAction: EnnoOdunoState['nextAction']): EnnoOdunoState {
  return {
    applicable: true, status: nextAction === 'submit_meditation' ? 'oduno_meditation' : 'completed', orchestrationId: 'orch', dshSessionId: 'dsh-session',
    contractRevision: 2, routeEpoch: 0, ideal: null, meditation: null, currentRole: nextAction === 'submit_meditation' ? 'enno-oduno' : null,
    directive: nextAction === 'submit_meditation' ? {
      protocolVersion: 1, runId: 'run', contractRevision: 2, routeEpoch: 0, role: 'enno-oduno',
      instructions: [], handoff: null,
      objective: 'submit meditation', requiredSkills: ['kiokuko-soul', 'kiokuko-single-purpose-functions'], workUnit: null,
      stopConditions: ['do not delete files'], reportSchema: {},
    } : null,
    nextAction, advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

test('accepted review requires read-only meditation submission before completion', async () => {
  let current = state('submit_meditation')
  let steers = 0
  const controller = new DshEnnoController({ readState: async () => current })
  const makeEvent = (turn: number) => ({
    agent: { id: 'meditation', steer: () => { steers++ }, cancel: () => undefined },
    turn, signal: new AbortController().signal,
  })
  assert.equal((await controller.handle(makeEvent(1))).kind, 'steer')
  current = state('complete')
  assert.deepEqual(await controller.handle(makeEvent(2)), { kind: 'close', nextAction: 'complete' })
  assert.equal(steers, 1)
})
