import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../../src/dsh/enno-controller.js'
import type { EnnoOdunoState } from '../../../../src/enno-oduno/types.js'

function snapshot(nextAction: EnnoOdunoState['nextAction'], revision: number, role: 'enno-oduno' | 'zenki'): EnnoOdunoState {
  return {
    applicable: true, status: role === 'zenki' ? 'zenki_planning' : 'enno_verifying', orchestrationId: 'orch', dshSessionId: 'dsh-session',
    contractRevision: revision, routeEpoch: 0, ideal: null, meditation: null, currentRole: role,
    directive: { protocolVersion: 1, runId: 'run', contractRevision: revision, routeEpoch: 0, role,
      instructions: [], handoff: null,
      objective: 'replan', requiredSkills: ['kiokuko-soul'], workUnit: null, stopConditions: ['no direct Goki resume'], reportSchema: {} },
    nextAction, advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

test('rejected review steers to the new Zenki revision before any work-unit execution', async () => {
  let current = snapshot('submit_final_review', 2, 'enno-oduno')
  const order: string[] = []
  const controller = new DshEnnoController({ readState: async () => current, injectNextStepContext: async () => { order.push('inject') } })
  const event = (turn: number) => ({ agent: { id: 'agent', steer: () => order.push('steer'), cancel: () => order.push('cancel') }, turn, signal: new AbortController().signal })
  assert.equal((await controller.handle(event(1))).kind, 'steer')
  current = snapshot('submit_plan', 3, 'zenki')
  assert.equal((await controller.handle(event(2))).kind, 'steer')
  assert.deepEqual(order, ['inject', 'steer', 'inject', 'steer'])
  assert.equal(current.currentRole, 'zenki')
  assert.equal(current.contractRevision, 3)
})
