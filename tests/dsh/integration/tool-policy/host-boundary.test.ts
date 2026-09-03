import assert from 'node:assert/strict'
import test from 'node:test'
import { DshToolPolicy } from '../../../../src/dsh/tool-policy.js'

const base = {
  runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0,
  dshSessionId: 'session-1', phase: 'goki' as const, currentWorkUnitId: 'U06', workUnitId: 'U06', leaseToken: 'lease-1',
}

function call(name: string, arguments_: unknown, origin?: 'model' | 'host') {
  return {
    callId: `call-${name}`, name, arguments: arguments_, ...(origin === undefined ? {} : { origin }),
    agent: { dshSessionId: 'session-1', turn: 1 }, signal: new AbortController().signal,
  }
}

test('host identity cannot be supplied through model arguments and host operations are not tools', () => {
  const policy = new DshToolPolicy(base)
  const injected = policy.decide(call('enno_work_report', { runId: 'attacker-run' }, 'model'))
  assert.deepEqual(injected, {
    kind: 'deny', code: 'IDENTITY_INJECTION', reason: 'Kiokuko dsh tool denied (identity_injection)',
  })
  const hostField = policy.decide(call('memory_checkpoint', { deliveryId: 'forged-delivery' }, 'model'))
  assert.equal(hostField.kind, 'deny')
  if (hostField.kind === 'deny') assert.equal(hostField.code, 'IDENTITY_INJECTION')

  const hostOperation = policy.decide(call('task_answer', {}, 'model'))
  assert.equal(hostOperation.kind, 'deny')
  if (hostOperation.kind === 'deny') assert.equal(hostOperation.code, 'UNKNOWN_TOOL')
  assert.equal(policy.decide(call('enno_work_report', {}, 'model')).kind, 'allow')
})

test('invalid host identity values are denied before the operation boundary', () => {
  const policy = new DshToolPolicy({ ...base, runId: 'run\u200b-1' })
  const decision = policy.decide(call('enno_work_report', {}, 'model'))
  assert.deepEqual(decision, { kind: 'deny', code: 'STALE_STATE', reason: 'Kiokuko dsh tool denied (stale_state)' })
})
