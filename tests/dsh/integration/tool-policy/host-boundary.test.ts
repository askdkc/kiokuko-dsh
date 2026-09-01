import assert from 'node:assert/strict'
import test from 'node:test'
import { DshToolPolicy } from '../../../../src/dsh/tool-policy.js'

const base = {
  runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0,
  phase: 'goki' as const, currentWorkUnitId: 'U06', workUnitId: 'U06', leaseToken: 'lease-1',
}

function call(name: string, arguments_: unknown, origin?: 'model' | 'host') {
  return {
    callId: `call-${name}`, name, arguments: arguments_, ...(origin === undefined ? {} : { origin }),
    agent: { dshSessionId: 'session-1', turn: 1 }, signal: new AbortController().signal,
  }
}

test('host identity cannot be supplied through model arguments and host-only calls require host origin', () => {
  const policy = new DshToolPolicy(base)
  const injected = policy.decide(call('enno_work_report', { runId: 'attacker-run' }, 'model'))
  assert.deepEqual(injected, {
    kind: 'deny', code: 'IDENTITY_INJECTION', reason: 'Kiokuko dsh tool denied (identity_injection)',
  })

  const hostOnly = policy.decide(call('task_answer', {}, 'model'))
  assert.equal(hostOnly.kind, 'deny')
  if (hostOnly.kind === 'deny') assert.equal(hostOnly.code, 'HOST_ONLY')
  assert.equal(policy.decide(call('enno_work_report', {}, 'model')).kind, 'allow')
})
