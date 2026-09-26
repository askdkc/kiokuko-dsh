import assert from 'node:assert/strict'
import test from 'node:test'
import { inapplicableEnnoState } from '../../../src/enno-oduno/service.js'
import { createTurnState } from '../../../src/dsh/host-adapter/turn-state.js'
import type { DshIntakeGateResult, DshPreStepEvent } from '../../../src/dsh/intake-gate.js'
import type { DshToolPolicyState } from '../../../src/dsh/tool-policy.js'

test('turn owner retains a same-revision lease and rejects stale generation and native identity', () => {
  const modes: string[] = []
  const policies: DshToolPolicyState[] = []
  const owner = createTurnState({
    begin: request => { modes.push(`begin:${request}`); return true },
    end: request => { modes.push(`end:${request}`); return true },
  }, {
    setState: state => { policies.push(state) },
    clearSession: session => { modes.push(`clear:${session}`) },
  }, () => undefined)
  const nativeAgent = {}, nativeSession = {}
  const event = (turn: number, session: object = nativeSession): DshPreStepEvent => ({
    agent: { id: 'agent' }, sessionId: 'session', turn, nativeAgent, nativeSession: session,
    task: 'task', cwd: '/tmp', signal: new AbortController().signal,
  }) as DshPreStepEvent
  const result = (runId: string, deliveryId: string): DshIntakeGateResult => ({
    admitted: true,
    catalog: { digest: 'catalog' },
    prepared: {
      run: { runId, status: 'active' },
      project: { workspace: 'workspace', repositoryRoot: '/tmp' },
      intake: { sessionId: 'intake' },
      ennoOduno: { ...inapplicableEnnoState(), contractRevision: 1 },
      context: { deliveryId },
      memoryPolicy: { contextWithheld: false },
    },
  }) as DshIntakeGateResult

  owner.record(event(1), result('run-1', 'first'), 1)
  const first = owner.currentSession('session')!
  owner.applyPolicy('run-1', { ...owner.policyState('run-1')!, leaseToken: 'active-lease', routeEpoch: 3 })
  owner.record(event(1), result('run-1', 'second'), 2)
  assert.equal(owner.currentSession('session'), first)
  assert.equal(owner.policyState('run-1')?.leaseToken, 'active-lease')
  assert.equal(owner.policyState('run-1')?.routeEpoch, 3)
  assert.equal(owner.policyState('run-1')?.deliveryId, 'second')
  owner.record(event(1), result('run-1', 'stale'), 1)
  assert.equal(owner.policyState('run-1')?.deliveryId, 'second')
  assert.throws(() => owner.record(event(1, {}), result('run-1', 'wrong-native'), 3), /identity changed/)

  owner.record(event(2), result('run-2', 'next'), 3)
  owner.releaseRun('run-1')
  assert.equal(owner.currentSession('session')?.runId, 'run-2')
  assert.equal(owner.policyState('run-1'), undefined)
  assert.equal(owner.policyState('run-2')?.runId, 'run-2')
  assert.deepEqual(modes, ['begin:dsh:agent:session:1', 'end:dsh:agent:session:1', 'begin:dsh:agent:session:2'])
  assert.ok(policies.length >= 4)
})
