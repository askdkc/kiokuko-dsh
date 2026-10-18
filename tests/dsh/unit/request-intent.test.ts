import assert from 'node:assert/strict'
import test from 'node:test'
import { bindMainModelRequestIntent, buildRequestIntentBatch, classifyRequestIntent, createRequestIntentContext,
  rebindRequestIntentDecision, requestIntentMessageRefs, requestIntentReferenceIds, requestIntentIsUnresolved, requestIntentTaskType,
  validateMainModelRequestIntent } from '../../../src/dsh/decisions/request-intent.js'
import { parseDecisionResult } from '../../../src/dsh/decisions/contracts.js'
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

test('binding diagnostics distinguish absent Goal from invalid evidence without relaxing either check', () => {
  const current = createRequestIntentContext({ task, messageRefs: context.messageRefs, proposals: context.proposals })!
  const refs = requestIntentReferenceIds(current)
  for (const relation of ['scope_change'] as const) {
    const submission = { relation, action: 'verify', evidenceRefs: refs }
    assert.deepEqual(validateMainModelRequestIntent(submission, current), { ok: false, reason: 'no_active_goal' })
    assert.equal(bindMainModelRequestIntent(submission, current), undefined)
    assert.deepEqual(validateMainModelRequestIntent({ ...submission, evidenceRefs: [...refs, 'foreign'] }, current),
      { ok: false, reason: 'unknown_reference' }, 'untrusted evidence is rejected before relation validation')
    assert.deepEqual(validateMainModelRequestIntent({ ...submission, evidenceRefs: refs.slice(1) }, current),
      { ok: false, reason: 'missing_reference' })
  }
  for (const relation of ['new', 'same_scope_continuation'] as const) for (const action of ['research', 'verify'] as const) {
    const submission = { relation, action, evidenceRefs: refs }
    const result = validateMainModelRequestIntent(submission, current)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.decision, bindMainModelRequestIntent(submission, current))
  }
  const stale = { ...current, proposals: current.proposals.map(proposal => ({ ...proposal, revision: 3 })) }
  assert.deepEqual(validateMainModelRequestIntent({ relation: 'new', action: 'verify', evidenceRefs: refs }, stale),
    { ok: false, reason: 'unknown_reference' })
  assert.deepEqual(validateMainModelRequestIntent({ relation: 'new', action: 'verify', evidenceRefs: [] }, current),
    { ok: false, reason: 'invalid_submission' })
  assert.deepEqual(validateMainModelRequestIntent({ relation: 'unknown', action: 'verify', evidenceRefs: refs }, current),
    { ok: false, reason: 'unresolved_intent' })
})

test('task operation candidates share state validation across provider, main model and rebind without mutating the snapshot', async () => {
  const activeTask = { taskId: 'task-run', runId: 'task-run', sessionId: 'session', sourceSessionId: 'session', repositoryRoot: '/repo',
    type: 'research' as const, state: 'Pending' as const, revision: 4, generation: 7, runStatus: 'active' as const,
    reason: 'Waiting for information', evidence: [], allowedOps: ['resume', 'ignore'] as const, request: 'Inspect the repository', resumedFromTerminal: false }
  const snapshot = { ...activeTask, allowedOps: [...activeTask.allowedOps] }
  const task = 'Continue the current inspection.'
  const current = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), activeTask: snapshot })!
  const original = structuredClone(current)
  const submit = (taskOperation: string) => ({ relation: 'same_scope_continuation', action: 'verify', taskOperation, evidenceRefs: requestIntentReferenceIds(current) })
  const valid = validateMainModelRequestIntent(submit('resume'), current)
  assert.equal(valid.ok, true)
  if (!valid.ok) return
  assert.equal(valid.decision.taskOperation, 'resume')
  assert.equal(rebindRequestIntentDecision(valid.decision, current)?.taskOperation, 'resume')
  assert.equal(rebindRequestIntentDecision(valid.decision, { ...current, activeTask: { ...snapshot, revision: 5 } }), undefined)
  for (const operation of ['start', 'complete']) assert.deepEqual(validateMainModelRequestIntent(submit(operation), current), { ok: false, reason: 'invalid_task_operation' })
  const terminal = { ...current, activeTask: { ...snapshot, state: 'Done' as const } }
  assert.deepEqual(validateMainModelRequestIntent({ ...submit('resume'), evidenceRefs: requestIntentReferenceIds(terminal) }, terminal), { ok: false, reason: 'invalid_task_operation' })
  const service = (choice: string): any => ({ bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, input: any) => ({ status: 'completed', result: {
    answers: input.questions.map((q: any) => ({ id: q.id, status: 'selected', choiceId: q.id === 'request-relation' ? 'same_scope_continuation'
      : q.id === 'request-action' ? 'verify' : q.id === 'request-task-operation' ? choice : 'unknown' })) } }) })
  assert.equal((await classifyRequestIntent(service('resume'), 'provider-resume', current, new AbortController().signal))?.taskOperation, 'resume')
  assert.equal((await classifyRequestIntent(service('complete'), 'provider-forged-complete', current, new AbortController().signal))?.unresolvedReason, 'invalid_task_operation')
  assert.equal((await classifyRequestIntent(service('unknown'), 'provider-abstain', current, new AbortController().signal))?.unresolvedReason, 'task_operation_unresolved')
  assert.deepEqual(current, original, 'Interpretation only proposes an operation; it cannot change state')
  const withDiagnostic = createRequestIntentContext({ task, messageRefs: current.messageRefs, activeTask: { ...snapshot,
    unresolved: { requestId: 'request', contextDigest: 'a'.repeat(64), revision: 4, reason: 'DECISION_AUTH', evidence: [] } } })!
  assert.deepEqual(withDiagnostic, current, 'Saving the unresolved reason does not make its own retry context stale')
})

test('optional task-operation abstention preserves independently resolved work without granting a transition', async () => {
  for (const state of ['Working', 'Pending', 'Done'] as const) for (const choice of ['abstained', 'unknown', 'missing']) {
    const request = 'Explain the current parser result, inspect src/parser.ts, and continue the requested verification.'
    const activeTask = { taskId: 'same-task', runId: 'same-task', sessionId: 'session', sourceSessionId: 'session', repositoryRoot: '/repo',
      type: 'review' as const, state, revision: 2, generation: 3, runStatus: 'active' as const,
      reason: 'Current work', evidence: [], allowedOps: [], request: 'Verify src/parser.ts', resumedFromTerminal: false }
    const current = createRequestIntentContext({ task: request, messageRefs: requestIntentMessageRefs([], request), activeTask })!
    const original = structuredClone(current)
    const service: any = { bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, batch: any) => {
      const result = { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
        answers: batch.questions.filter((q: any) => choice !== 'missing' || q.id !== 'request-task-operation').map((q: any) =>
          q.id === 'request-relation' ? { id: q.id, status: 'selected', choiceId: 'same_scope_continuation' }
            : q.id === 'request-action' ? { id: q.id, status: 'selected', choiceId: 'verify' }
              : choice === 'abstained' ? { id: q.id, status: 'abstained', reason: 'uncertain' }
                : { id: q.id, status: 'selected', choiceId: 'unknown' }) }
      // Abstained is the production wire form; the other cases are defensive service-boundary checks.
      return { status: 'completed', result: choice === 'abstained' ? parseDecisionResult(result, batch) : result }
    } }
    const decision = await classifyRequestIntent(service, `partial-${state}-${choice}`, current, new AbortController().signal)
    assert.equal(decision?.relation, 'same_scope_continuation')
    assert.equal(decision?.action, 'verify')
    assert.equal(decision?.taskOperation, undefined)
    assert.equal(decision?.source, 'unresolved', 'the main model can resolve advisory uncertainty using exact current evidence')
    assert.equal(decision?.unresolvedReason, 'task_operation_unresolved')
    assert.equal(rebindRequestIntentDecision(decision, current)?.action, 'verify')
    assert.equal(rebindRequestIntentDecision(decision, { ...current, activeTask: { ...activeTask, generation: 4 } }), undefined)
    assert.deepEqual(current, original, 'classification never starts, resumes, completes, or otherwise mutates a task')
  }
})

test('mixed work guidance preserves explicit edits rather than treating composition itself as uncertainty', () => {
  const batch = buildRequestIntentBatch(context)!
  const action = batch.questions.find(question => question.id === 'request-action')!
  assert.match(action.instructions, /explanation.*inspection.*explicit.*change/iu)
  assert.ok('choices' in action)
  assert.doesNotMatch(action.choices.find(choice => choice.id === 'unknown')!.description, /mixed without a dominant action/iu)
})

test('optional operation fallback does not resolve unknown action, relation, scope or proposal authority', async () => {
  for (const uncertain of ['request-relation', 'request-action', 'request-change-scope', 'request-proposal-0']) {
    const current = createRequestIntentContext({ ...context, activeTask: { taskId: 'same-task', runId: 'same-task',
      sessionId: 'session', sourceSessionId: 'session', repositoryRoot: '/repo', type: 'build', state: 'Working',
      revision: 2, generation: 3, runStatus: 'active', reason: 'Current work', evidence: [], allowedOps: ['wait', 'complete'],
      request: task, resumedFromTerminal: false } })!
    const choices: Record<string, string> = { 'request-relation': 'same_scope_continuation', 'request-action': 'change',
      'request-change-scope': 'implementation', 'request-proposal-0': 'not_selected' }
    const service: any = { bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, batch: any) => ({ status: 'completed',
      result: parseDecisionResult({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
        answers: batch.questions.map((q: any) => q.id === uncertain || q.id === 'request-task-operation'
          ? { id: q.id, status: 'abstained', reason: 'uncertain' }
          : { id: q.id, status: 'selected', choiceId: choices[q.id] }) }, batch) }) }
    const decision = await classifyRequestIntent(service, `required-${uncertain}`, current, new AbortController().signal)
    assert.equal(requestIntentIsUnresolved(decision), true, uncertain)
    assert.equal(decision?.source, 'unresolved')
    assert.equal(decision?.taskOperation, undefined)
    assert.deepEqual(decision?.evidence.proposalRefs, [])
  }
})
