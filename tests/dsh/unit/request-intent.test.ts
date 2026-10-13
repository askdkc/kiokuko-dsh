import assert from 'node:assert/strict'
import test from 'node:test'
import { bindMainModelRequestIntent, buildRequestIntentBatch, classifyRequestIntent, createRequestIntentContext,
  rebindRequestIntentDecision, requestIntentMessageRefs, requestIntentReferenceIds, requestIntentTaskType } from '../../../src/dsh/decisions/request-intent.js'
import { executionClarification } from '../../../src/dsh/intake-clarification.js'

const task = 'A/B/C をまとめて入れて。前の案で続けて。'
const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), activeGoal: {
  runId: 'current', workflowRevision: 2, goalRevision: 1, scopeRevision: 1, ideal: 'Repair the parser', target: 'src/parser.ts', outOfScope: [], constraints: [],
}, proposals: [{ id: 'abc', revision: 2, digest: 'a'.repeat(64), text: 'A/B/C: parse, validate, persist' }] })!

test('finite provider decisions carry selected proposal evidence into the common contract', async () => {
  const batch = buildRequestIntentBatch(context)!
  assert.equal(batch.questions.length, 4)
  assert.equal((batch.state as any).currentUserMessage, task)
  const service: any = { bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, input: any, _signal: any, _policy: any, _other: any, hooks: any) => {
    hooks.onProviderDispatch()
    return { status: 'completed', result: { answers: input.questions.map((q: any) => ({ id: q.id, status: 'selected', choiceId:
      q.id === 'request-relation' ? 'scope_change' : q.id === 'request-action' ? 'change'
        : q.id === 'request-change-scope' ? 'implementation' : 'selected' })) } }
  } }
  const decision = await classifyRequestIntent(service, 'request', context, new AbortController().signal)
  assert.equal(decision?.source, 'decision-provider')
  assert.equal(decision?.providerSent, true)
  assert.deepEqual(decision?.evidence.proposalRefs, [{ id: 'abc', revision: 2, digest: 'a'.repeat(64) }])
  assert.equal(rebindRequestIntentDecision(decision, { ...context, activeGoal: { ...context.activeGoal!, workflowRevision: 3 } }), undefined)
})
test('main-model interpretation is bound to the current human, Goal and proposals, including abstention', async () => {
  const refs = requestIntentReferenceIds(context)
  const decision = bindMainModelRequestIntent({ relation: 'scope_change', action: 'change', changeScope: 'implementation', evidenceRefs: refs }, context)!
  assert.equal(decision.source, 'main-model')
  assert.equal(decision.changeScope, 'implementation')
  assert.equal(bindMainModelRequestIntent({ relation: 'scope_change', action: 'change', evidenceRefs: [...refs, 'another-chat'] }, context), undefined)
  assert.equal(bindMainModelRequestIntent({ relation: 'scope_change', action: 'change', evidenceRefs: refs.slice(1) }, context), undefined)
  assert.doesNotThrow(() => assert.equal(rebindRequestIntentDecision({ ...decision, evidence: {} }, context), undefined))
  const unresolved = await classifyRequestIntent(undefined, 'request', context, new AbortController().signal)
  assert.equal(unresolved?.source, 'unresolved')
  assert.equal(unresolved?.action, 'unknown')
})
test('change scope is explicit and task labels cannot turn implementation into writing', () => {
  const refs = requestIntentReferenceIds(context)
  const implementation = bindMainModelRequestIntent({ relation: 'scope_change', action: 'change', changeScope: 'implementation', evidenceRefs: refs }, context)!
  const document = bindMainModelRequestIntent({ relation: 'scope_change', action: 'change', changeScope: 'document', evidenceRefs: refs }, context)!
  const legacy = bindMainModelRequestIntent({ relation: 'scope_change', action: 'change', evidenceRefs: refs }, context)!
  assert.equal(implementation.changeScope, 'implementation')
  assert.equal(document.changeScope, 'document')
  assert.equal(legacy.changeScope, 'unknown', 'old action=change inputs are unresolved, never inferred from their label')
  assert.equal(requestIntentTaskType(implementation, 'writing'), 'build')
  assert.equal(requestIntentTaskType(document, 'build'), 'writing')
  assert.equal(requestIntentTaskType(legacy, 'writing'), 'writing')
})
test('referential repairs need a current resolved Goal or selected proposal, not an old intent', () => {
  for (const task of ['それを直して。', 'fix it', 'continue']) {
    const current = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), activeGoal: context.activeGoal })!
    const decision = bindMainModelRequestIntent({ relation: 'same_scope_continuation', action: 'change', evidenceRefs: requestIntentReferenceIds(current) }, current)!
    assert.equal(executionClarification(task, decision, current), undefined)
    assert.ok(executionClarification(task))
    assert.ok(executionClarification(task, { ...decision, evidence: { ...decision.evidence, requestDigest: 'b'.repeat(64) } }, current))
    assert.ok(executionClarification(task, decision, { ...current, task: 'a different request' }))
  }
})
