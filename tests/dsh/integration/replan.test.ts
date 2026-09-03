import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../src/dsh/enno-controller.js'
import type { EnnoOdunoState } from '../../../src/enno-oduno/types.js'

function snapshot(nextAction: EnnoOdunoState['nextAction'], revision: number, role: 'enno-oduno' | 'zenki'): EnnoOdunoState {
  return {
    applicable: true, status: role === 'zenki' ? 'zenki_planning' : 'enno_verifying', orchestrationId: 'orch', dshSessionId: 'dsh-session',
    contractRevision: revision, routeEpoch: 0, ideal: null, meditation: null, currentRole: role,
    directive: {
      protocolVersion: 1, runId: 'run', contractRevision: revision, routeEpoch: 0, role,
      instructions: [], handoff: null,
      objective: role === 'zenki' ? 'revise plan' : 'review', requiredSkills: ['kiokuko-soul', 'kiokuko-single-purpose-functions'], workUnit: null,
      stopConditions: ['do not resume Goki directly'], reportSchema: {},
    },
    nextAction, advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

test('review rejection resumes at Zenki with a new revision, never directly at Goki', async () => {
  let current = snapshot('submit_final_review', 2, 'enno-oduno')
  const agent = { id: 'replan', steer: () => undefined, cancel: () => undefined }
  let steers = 0
  const controller = new DshEnnoController({ readState: async () => current })
  assert.equal((await controller.handle({ agent: { ...agent, steer: () => { steers++ } }, turn: 1, signal: new AbortController().signal })).kind, 'steer')
  current = snapshot('submit_plan', 3, 'zenki')
  assert.equal((await controller.handle({ agent: { ...agent, steer: () => { steers++ } }, turn: 2, signal: new AbortController().signal })).kind, 'steer')
  current = snapshot('execute_work_unit', 4, 'enno-oduno')
  assert.equal((await controller.handle({ agent: { ...agent, steer: () => { steers++ } }, turn: 3, signal: new AbortController().signal })).kind, 'steer')
  assert.equal(steers, 3)
})
