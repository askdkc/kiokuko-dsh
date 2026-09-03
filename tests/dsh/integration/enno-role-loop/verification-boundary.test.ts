import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../../src/dsh/enno-controller.js'
import type { EnnoOdunoState } from '../../../../src/enno-oduno/types.js'

function state(): EnnoOdunoState {
  return {
    applicable: true, status: 'enno_verifying', orchestrationId: 'orch', dshSessionId: 'dsh-session',
    contractRevision: 2, routeEpoch: 0, ideal: null, meditation: null, currentRole: 'enno',
    directive: {
      protocolVersion: 1, runId: 'run', contractRevision: 2, routeEpoch: 0, role: 'enno',
      instructions: [],
      handoff: null, objective: 'verify', requiredSkills: ['kiokuko-soul'], workUnit: null,
      stopConditions: ['fresh evidence'], reportSchema: {},
    },
    nextAction: 'run_final_verification', advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

test('final verification is awaited before context injection and steering', async () => {
  const events: string[] = []
  const controller = new DshEnnoController({
    readState: async () => state(),
    runFinalVerification: async () => { events.push('verify'); await Promise.resolve() },
    injectNextStepContext: async () => { events.push('inject') },
  })
  const steers: unknown[] = []
  const decision = await controller.handle({
    agent: { id: 'agent', steer: (message) => steers.push(message), cancel: () => events.push('cancel') },
    turn: 1, signal: new AbortController().signal,
  })
  assert.equal(decision.kind, 'steer')
  assert.deepEqual(events, ['verify', 'inject'])
  assert.equal(steers.length, 1)
})

test('verification failure cancels the turn instead of steering as if complete', async () => {
  const events: string[] = []
  const controller = new DshEnnoController({
    readState: async () => state(),
    runFinalVerification: async () => { throw new Error('failed') },
    injectNextStepContext: async () => { events.push('inject') },
  })
  const decision = await controller.handle({
    agent: { id: 'agent', steer: () => events.push('steer'), cancel: (reason) => events.push(reason) },
    turn: 1, signal: new AbortController().signal,
  })
  assert.deepEqual(decision, { kind: 'abort', reason: 'verification_failed' })
  assert.equal(events[0], 'kiokuko dsh Enno continuation stopped: verification_failed')
  assert.equal(events.includes('inject'), false)
})
