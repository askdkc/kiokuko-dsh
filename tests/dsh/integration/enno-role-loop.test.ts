import assert from 'node:assert/strict'
import test from 'node:test'
import { DshEnnoController } from '../../../src/dsh/enno-controller.js'
import { DshToolPolicy } from '../../../src/dsh/tool-policy.js'
import type { EnnoOdunoState } from '../../../src/enno-oduno/types.js'

function directive(revision: number) {
  return {
    protocolVersion: 1, runId: 'run', contractRevision: revision, routeEpoch: 0, role: 'zenki',
    instructions: [], handoff: null,
    objective: 'submit the plan', requiredSkills: ['kiokuko-soul', 'kiokuko-single-purpose-functions'], workUnit: null,
    stopConditions: ['submit one plan'], reportSchema: {},
  } as const
}

function snapshot(nextAction: EnnoOdunoState['nextAction'], revision = 2): EnnoOdunoState {
  return {
    applicable: true, status: 'zenki_planning', orchestrationId: 'orch', dshSessionId: 'dsh-session',
    contractRevision: revision, routeEpoch: 0, ideal: null, meditation: null, currentRole: 'zenki', directive: directive(revision),
    nextAction, advisoryPhaseState: { state: 'not_started' },
  } as unknown as EnnoOdunoState
}

test('revision change produces a new bounded continuation key, while direct completion stays silent', async () => {
  const agent = { id: 'loop', steers: [] as unknown[], cancels: [] as string[] }
  let current = snapshot('submit_plan')
  const controller = new DshEnnoController({
    readState: async () => current,
  })
  const base = { agent: { id: agent.id, steer: (message: unknown) => agent.steers.push(message), cancel: (reason: string) => agent.cancels.push(reason) }, signal: new AbortController().signal }
  assert.equal((await controller.handle({ ...base, turn: 1 })).kind, 'steer')
  current = snapshot('submit_final_review', 3)
  assert.equal((await controller.handle({ ...base, turn: 2 })).kind, 'steer')
  current = snapshot('complete', 3)
  const done = await controller.handle({ ...base, turn: 3 })
  assert.deepEqual(done, { kind: 'close', nextAction: 'complete' })
  assert.equal(agent.steers.length, 2)
  assert.equal(agent.cancels.length, 0)
})

test('an already-aborted turn cannot be revived by the Enno controller', async () => {
  const controller = new DshEnnoController({ readState: async () => snapshot('submit_plan') })
  const abort = new AbortController()
  abort.abort()
  let steers = 0
  const decision = await controller.handle({
    agent: { id: 'aborted', steer: () => { steers++ }, cancel: () => { throw new Error('must not cancel an already aborted turn') } },
    turn: 1,
    signal: abort.signal,
  })
  assert.deepEqual(decision, { kind: 'abort', reason: 'aborted' })
  assert.equal(steers, 0)
})

test('the tool policy follows the current directive instead of only the broad phase', () => {
  const policy = new DshToolPolicy({
    runId: 'run', workspace: 'workspace', orchestrationId: 'orch', revision: 2, routeEpoch: 0,
    phase: 'planning', nextAction: 'submit_plan', dshSessionId: 'loop',
  })
  const signal = new AbortController().signal
  const call = (name: string) => ({
    callId: name, name, arguments: {}, agent: { dshSessionId: 'loop', turn: 1 }, signal,
  })
  assert.equal(policy.decide(call('enno_plan_submit')).kind, 'allow')
  const denied = policy.decide(call('enno_ideal_submit'))
  assert.deepEqual(denied, { kind: 'deny', code: 'WRONG_DIRECTIVE', reason: 'Kiokuko dsh tool denied (wrong_directive)' })
})
