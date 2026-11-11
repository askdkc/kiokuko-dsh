import assert from 'node:assert/strict'
import test from 'node:test'
import { revalidateResumedRequest } from '../../../src/dsh/request-resume.js'
import { bindMainModelRequestIntent, createRequestIntentContext, rebindRequestIntentDecision,
  requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'

const before = createRequestIntentContext({ task: 'Continue the original plan; preserve exclusions and verify every item.',
  workspaceDirectory: '/repo', messageRefs: [{ id: 'user', digest: 'a'.repeat(64) }], activeTask: {
    taskId: 'task', runId: 'task', sessionId: 'session', sourceSessionId: 'session', repositoryRoot: '/repo',
    type: 'debug', state: 'Pending', revision: 4, generation: 3, runStatus: 'failed', reason: 'Failed',
    evidence: [], allowedOps: ['resume', 'ignore'], request: 'Original plan', resumedFromTerminal: false,
  } })!
const decision = bindMainModelRequestIntent({ relation: 'same_scope_continuation', action: 'change', changeScope: 'implementation',
  evidenceRefs: requestIntentReferenceIds(before) }, before)!
const after = createRequestIntentContext({ ...before, activeTask: { ...before.activeTask!, state: 'Working', runStatus: 'active',
  revision: 5, generation: 4, allowedOps: ['wait', 'complete', 'ignore'], resumedFromTerminal: true } })!

test('host resume revalidates same-scope evidence against the new task revision, never copying the old binding', () => {
  assert.ok(decision)
  assert.equal(rebindRequestIntentDecision(decision, after), undefined)
  const result = revalidateResumedRequest(decision, before, after)
  assert.ok(result)
  assert.equal(result.evidence.taskRevision, 5)
  assert.equal(result.evidence.taskGeneration, 4)
  assert.ok(rebindRequestIntentDecision(result, after))
  assert.equal(rebindRequestIntentDecision(result, before), undefined)
})

test('unknown, scope change, owner change, Stop, request changes and stale generations cannot use resume revalidation', () => {
  for (const relation of ['unknown', 'scope_change', 'new'] as const)
    assert.equal(revalidateResumedRequest({ ...decision, relation }, before, after), undefined)
  for (const change of [
    { sessionId: 'other' }, { taskId: 'other' }, { runId: 'other' }, { repositoryRoot: '/elsewhere' },
    { request: 'Change the scope' }, { generation: 3 }, { revision: 4 }, { state: 'Pending' as const },
    { pendingStop: { operationId: 'stop', operation: 'wait' as const, requestedRevision: 5, requestedGeneration: 4, reason: 'Stop', evidence: [] } },
  ]) assert.equal(revalidateResumedRequest(decision, before, { ...after, activeTask: { ...after.activeTask!, ...change } }), undefined)
  assert.equal(revalidateResumedRequest(decision, before, { ...after, task: 'Different request' }), undefined)
})
