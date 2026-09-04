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

test('policy retains independent state for concurrent dsh sessions', () => {
  const policy = new DshToolPolicy({ ...base, dshSessionId: 'session-a' })
  policy.setState({ ...base, dshSessionId: 'session-b' })
  assert.equal(policy.decide(call('enno_plan_submit', { agent: { dshSessionId: 'session-a', turn: 1 } })).kind, 'allow')
  assert.equal(policy.decide(call('enno_plan_submit', { agent: { dshSessionId: 'session-b', turn: 1 } })).kind, 'allow')
  assert.equal(policy.decide(call('enno_plan_submit', { agent: { dshSessionId: 'session-c', turn: 1 } })).kind, 'deny')
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

test('malformed runtime phase and directive state fail closed without throwing', () => {
  const policy = new DshToolPolicy({ ...base, phase: 'future' as any, nextAction: 'not-a-real-action' as any })
  const decision = policy.decide(call('enno_plan_submit', { signal: new AbortController().signal }))
  assert.deepEqual(decision, { kind: 'deny', code: 'STALE_STATE', reason: 'Kiokuko dsh tool denied (stale_state)' })
  assert.equal(policy.guardReason(call('enno_plan_submit', { signal: new AbortController().signal })), 'Kiokuko dsh tool denied (stale_state)')
})

test('a native tool cannot use a run-only policy snapshot without a bound session', () => {
  const { dshSessionId: _dshSessionId, ...runOnly } = base
  const policy = new DshToolPolicy(runOnly)
  const decision = policy.decide(call('enno_plan_submit', { signal: new AbortController().signal }))
  assert.deepEqual(decision, { kind: 'deny', code: 'STALE_STATE', reason: 'Kiokuko dsh tool denied (stale_state)' })
})

test('a committed phase seals every later unstarted tool in the same native turn', () => {
  const policy = new DshToolPolicy({ ...base, nativeTurn: 7 })
  policy.sealSession('session-1', 7, 'a'.repeat(64))
  const signal = new AbortController().signal
  assert.match(policy.guardReason({
    callId: 'read-after-phase', name: 'Read', arguments: {},
    agent: { dshSessionId: 'session-1', turn: 7 }, signal,
  })!, /turn_sealed/u)
  assert.match(policy.guardReason({
    callId: 'plan-after-phase', name: 'enno_plan_submit', arguments: {},
    agent: { dshSessionId: 'session-1', turn: 7 }, signal,
  })!, /turn_sealed/u)

  policy.setState({ ...base, nativeTurn: 8 })
  assert.equal(policy.guardReason({
    callId: 'read-next-turn', name: 'Read', arguments: {},
    agent: { dshSessionId: 'session-1', turn: 8 }, signal,
  }), undefined)
})

test('the mounted native guard resolves a DSH session to its current turn seal', () => {
  const policy = new DshToolPolicy({ ...base, nativeTurn: 7 })
  const guards: Array<(execution: any) => string | undefined> = []
  const dispose = mountDshToolPolicy({
    tools: { guard: (guard) => { guards.push(guard); return () => undefined } },
  }, policy)
  try {
    policy.sealSession('session-1', 7, 'b'.repeat(64))
    const reason = guards[0]!({
      callId: 'native-read-after-phase', name: 'Read', arguments: {},
      agent: { id: 'native-agent', session: { id: 'session-1' } },
      signal: new AbortController().signal,
    })
    assert.match(reason!, /turn_sealed/u)
  } finally {
    dispose()
  }
})
