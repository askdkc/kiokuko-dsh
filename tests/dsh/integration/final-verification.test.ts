import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../src/dsh/enno-controller.js'
import { DshToolPolicy } from '../../../src/dsh/tool-policy.js'
import type { EnnoOdunoState } from '../../../src/enno-oduno/types.js'

function state(nextAction: EnnoOdunoState['nextAction'], revision = 2): EnnoOdunoState {
  return {
    applicable: true, status: 'enno_verifying', orchestrationId: 'orch', clientBinding: null,
    contractRevision: revision, routeEpoch: 0, ideal: null, meditation: null, currentRole: 'enno-oduno',
    directive: {
      protocolVersion: 1, runId: 'run', contractRevision: revision, routeEpoch: 0, role: 'enno-oduno',
      harness: { kind: 'dsh', version: null, continuation: 'turn_stopping_plugin', instructions: [] }, handoff: null,
      objective: 'verify', requiredSkills: ['kiokuko-soul', 'kiokuko-single-purpose-functions'], workUnit: null,
      stopConditions: ['fresh evidence'], reportSchema: {},
    },
    nextAction, advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

function event(agent: { steers: unknown[]; cancels: string[] }) {
  return {
    agent: { id: 'verification', steer: (message: unknown) => agent.steers.push(message), cancel: (reason: string) => agent.cancels.push(reason) },
    turn: 1, signal: new AbortController().signal,
  }
}

test('turn stopping runs the host final-verifier boundary before steering', async () => {
  const agent = { steers: [] as unknown[], cancels: [] as string[] }
  let runs = 0
  const controller = new DshEnnoController({
    readState: async () => state('run_final_verification'),
    runFinalVerification: async () => { runs++ },
  })
  const decision = await controller.handle(event(agent))
  assert.equal(decision.kind, 'steer')
  assert.equal(runs, 1)
  assert.equal(agent.steers.length, 1)
})

test('missing or failed final verification never becomes a normal close', async () => {
  for (const dependency of [{}, { runFinalVerification: async () => { throw new Error('verifier failed') } }]) {
    const agent = { steers: [] as unknown[], cancels: [] as string[] }
    const decision = await new DshEnnoController({ readState: async () => state('run_final_verification'), ...dependency }).handle(event(agent))
    assert.equal(decision.kind, 'abort')
    assert.equal(agent.steers.length, 0)
    assert.equal(agent.cancels.length, 1)
  }
})

test('verification tool policy permits only the revision-matching final review operation', () => {
  const policy = new DshToolPolicy({
    runId: 'run', workspace: 'workspace', orchestrationId: 'orch', revision: 2, routeEpoch: 0,
    phase: 'verifying', nextAction: 'submit_final_review', dshSessionId: 'verification',
  })
  const signal = new AbortController().signal
  const call = (name: string) => ({ callId: name, name, arguments: {}, agent: { dshSessionId: 'verification', turn: 1 }, signal })
  assert.equal(policy.decide(call('enno_finish')).kind, 'allow')
  assert.equal(policy.decide(call('enno_work_report')).kind, 'deny')
})
