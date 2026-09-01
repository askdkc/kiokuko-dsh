import assert from 'node:assert/strict'
import test from 'node:test'
import { DshToolPolicy, mountDshToolPolicy } from '../../../src/dsh/tool-policy.js'

const controller = new AbortController()
const base = {
  runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0,
  dshSessionId: 'session-1', phase: 'planning' as const,
}

function call(name: string, overrides: Record<string, unknown> = {}) {
  return {
    callId: 'call-1', name, arguments: {},
    agent: { dshSessionId: 'session-1', turn: 1 },
    signal: controller.signal,
    ...overrides,
  }
}

test('policy allows only the current phase and host binds identity after admission', () => {
  const policy = new DshToolPolicy(base)
  const allowed = policy.decide(call('enno_plan_submit'))
  assert.equal(allowed.kind, 'allow')
  if (allowed.kind === 'allow') {
    assert.equal(allowed.binding.runId, 'run-1')
    assert.match(allowed.binding.idempotencyKey, /^dsh-tool:[0-9a-f]{64}$/u)
  }
  assert.equal(policy.decide(call('enno_ideal_submit')).kind, 'deny')
  assert.equal(policy.decide(call('task_prepare')).kind, 'deny')
})

test('Goki report requires the current work unit and lease, and stale agents are denied', () => {
  const policy = new DshToolPolicy({
    ...base,
    phase: 'goki',
    currentWorkUnitId: 'U10',
    workUnitId: 'U10',
    leaseToken: 'lease-1',
  })
  assert.equal(policy.decide(call('enno_work_report')).kind, 'allow')
  assert.equal(policy.decide(call('enno_work_report', {agent: {dshSessionId: 'other-session', turn: 1}})).kind, 'deny')
  policy.setState({ ...base, phase: 'goki', currentWorkUnitId: 'U11', workUnitId: 'U10', leaseToken: 'lease-1' })
  assert.equal(policy.decide(call('enno_work_report')).kind, 'deny')
})

test('denials are monotonic, cancellation is denied, and disposal remains denied', () => {
  const policy = new DshToolPolicy(base)
  const guards: Array<(execution: Parameters<typeof policy.guardReason>[0]) => string | undefined> = []
  const disposer = mountDshToolPolicy({ tools: { guard: (guard) => { guards.push(guard); return () => guards.splice(guards.indexOf(guard), 1) } } }, policy)
  assert.equal(guards.length, 1)
  const denied = policy.decide(call('enno_ideal_submit'))
  assert.equal(denied.kind, 'deny')
  assert.match(policy.guardReason(call('enno_ideal_submit'))!, /wrong_phase/iu)
  controller.abort()
  assert.match(policy.guardReason(call('enno_plan_submit'))!, /cancelled/iu)
  disposer()
  policy.dispose()
  assert.match(policy.guardReason(call('enno_plan_submit'))!, /unloaded/iu)
  assert.doesNotMatch(policy.guardReason(call('enno_plan_submit'))!, /run-1|workspace-1|orch-1|lease-1/iu)
})
