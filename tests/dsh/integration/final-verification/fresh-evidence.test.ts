import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../../src/dsh/enno-controller.js'
import type { EnnoOdunoState } from '../../../../src/enno-oduno/types.js'

function state(): EnnoOdunoState {
  return {
    applicable: true, status: 'enno_verifying', orchestrationId: 'orch', dshSessionId: 'dsh-session',
    contractRevision: 2, routeEpoch: 0, ideal: null, meditation: null, currentRole: 'enno-oduno',
    directive: {
      protocolVersion: 1, runId: 'run', contractRevision: 2, routeEpoch: 0, role: 'enno-oduno',
      instructions: [], handoff: null,
      objective: 'verify', requiredSkills: ['kiokuko-soul'], workUnit: null, stopConditions: ['fresh evidence'], reportSchema: {},
    },
    nextAction: 'run_final_verification', advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

test('the stop boundary waits for verifier evidence and aborts on stale directive', async () => {
  const events: string[] = []
  let current = state()
  const controller = new DshEnnoController({
    readState: async () => current,
    runFinalVerification: async () => { events.push('verify') },
    injectNextStepContext: async () => { events.push('inject') },
  })
  const event = { agent: { id: 'agent', steer: () => events.push('steer'), cancel: (reason: string) => events.push(reason) }, turn: 1, signal: new AbortController().signal }
  assert.equal((await controller.handle(event)).kind, 'steer')
  assert.deepEqual(events, ['verify', 'inject', 'steer'])

  current = { ...state(), directive: { ...state().directive!, contractRevision: 1 } } as unknown as EnnoOdunoState
  const stale = await controller.handle({ ...event, turn: 2 })
  assert.deepEqual(stale, { kind: 'abort', reason: 'stale_directive' })
})

test('verification transition records the fresh directive key before steering', async () => {
  const events: string[] = []
  const initial = state()
  const fresh = { ...initial, nextAction: 'submit_final_review' } as EnnoOdunoState
  let reads = 0
  const controller = new DshEnnoController({
    readState: async () => reads++ === 0 ? initial : fresh,
    runFinalVerification: async () => { events.push('verify'); return fresh },
    injectNextStepContext: async () => { events.push('inject') },
  })
  const agent = {
    steers: [] as unknown[],
    cancel: () => undefined,
  }
  const decision = await controller.handle({
    agent: { id: 'agent', steer: (message: unknown) => agent.steers.push(message), cancel: agent.cancel },
    turn: 1,
    signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'steer')
  assert.equal(decision.nextAction, 'submit_final_review')
  assert.deepEqual(events, ['verify', 'inject'])
  assert.equal(agent.steers.length, 1)
})
