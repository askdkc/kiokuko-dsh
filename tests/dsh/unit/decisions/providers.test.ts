import assert from 'node:assert/strict'
import test from 'node:test'
import { TypeSafeDecisionProvider, NimbleDecisionProvider, choiceBody } from '../../../../src/dsh/decisions/providers.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { type DecisionBatch, type DecisionProvider, DecisionError } from '../../../../src/dsh/decisions/contracts.js'
import { classifyTask, selectInstalledSkills } from '../../../../src/dsh/decisions/workflows.js'
import { resolveCapabilities } from '../../../../src/akinator/capabilities.js'
import { reviewPlanDecisions } from '../../../../src/dsh/decisions/plan-review.js'

const signal = () => new AbortController().signal
const config = (provider: 'typesafe' | 'nimble') => TypedDecisionsConfig.parse({ provider, nimble: { endpoint: 'http://127.0.0.1:9000/v1/systemone', model: 'bespoke-model' } })
const batch: DecisionBatch = { purpose: 'lisp', state: 'synthetic evidence', questions: [{ id: '10', instructions: 'Choose', choices: [{ id: '20', description: 'One' }, { id: '2', description: 'Two' }, { id: 'abstain', description: 'Unknown' }], abstainId: 'abstain' }] }
function transport(select: (id: string, options: string[]) => string, capture?: (url: unknown, options: RequestInit) => void): typeof fetch {
  return async (url, options) => {
    capture?.(url, options!)
    const request = JSON.parse(String(options!.body))
    return Response.json({ model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]: [string, any]) => {
      const keys = Object.keys(q.criteria), choice = select(id, keys)
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])), confidence: 1 }]
    })) })
  }
}
function provider(kind: 'typesafe' | 'nimble', request: typeof fetch): DecisionProvider {
  return kind === 'typesafe' ? new TypeSafeDecisionProvider(config(kind).typesafe, async () => 'fixture-key', request) : new NimbleDecisionProvider(config(kind).nimble, async () => undefined, request)
}
for (const kind of ['typesafe', 'nimble'] as const) {
  test(`${kind}: ordered choices, optional metadata, exact replay, Akinator and Skill consumption`, async () => {
    let calls = 0
    const backend = provider(kind, transport((id, options) => id === 'task-type' ? 'debug' : options.includes('yes') ? 'yes' : '20', (_url, init) => {
      calls++; assert.equal(init.redirect, 'error')
      if (kind === 'nimble') assert.equal((init.headers as any).Authorization, undefined)
    }))
    const service = new DecisionService(config(kind), () => backend)
    const outcome = await service.evaluate('request', batch, signal())
    assert.equal(outcome.status, 'completed')
    if (outcome.status !== 'completed') return
    assert.equal(outcome.result.usage, undefined); assert.equal(outcome.result.revision, undefined)
    assert.deepEqual(outcome.result.answers[0], { id: '10', status: 'selected', choiceId: '20' })
    assert.deepEqual(await service.evaluate('request', batch, signal()), outcome); assert.equal(calls, 1)
    assert.equal(await classifyTask(service, 'classification', '修正してください', undefined, signal()), 'debug')
    assert.equal(await classifyTask(service, 'classification-explicit', 'fix', 'writing', signal()), 'writing'); assert.equal(calls, 2)
    const catalog = [{ kind: 'skill' as const, name: 'kiokuko-soul' }, { kind: 'skill' as const, name: 'fixture-debugger', description: 'debug exceptions' }]
    const resolution = resolveCapabilities({ task: 'debug', profile: { taskType: 'debug', target: null, expected: null, constraints: null }, recommendedTags: [], capabilities: catalog, memoryUse: 'none' })
    assert.ok((await selectInstalledSkills(service, 'skills', 'debug', catalog, resolution, signal())).includes('fixture-debugger'))
    const body = choiceBody(batch, 'model')
    assert.ok(body.indexOf('"20":') < body.indexOf('"2":'))
    await service.evaluate('request', { ...batch, questions: [{ ...batch.questions[0], choices: [...('choices' in batch.questions[0]! ? batch.questions[0]!.choices : [])].reverse() }] }, signal())
    assert.equal(calls, 4)
  })
  test(`${kind}: failures, abstentions, uncertainty and cancellation never execute fallback effects`, async () => {
    for (const status of [401, 413, 422, 503, 529, 504]) {
      const service = new DecisionService(config(kind), () => provider(kind, async () => new Response('private body', { status })))
      assert.equal((await service.evaluate(`failure-${status}`, batch, signal())).status, 'fallback')
    }
    for (const probabilities of [{ '20': .5, '2': .5, abstain: 0 }, { '20': .6, '2': .3, abstain: .1 }, { '20': 0, '2': 0, abstain: 1 }]) {
      const choice = probabilities.abstain === 1 ? 'abstain' : '20'
      const service = new DecisionService(config(kind), () => provider(kind, async () => Response.json({ model: 'unknown', answers: { '10': { type: 'choice', choice, probabilities, confidence: .5 } } })))
      const result = await service.evaluate('uncertain', batch, signal()); assert.equal(result.status, 'completed')
      if (result.status === 'completed') assert.equal(result.result.answers[0]?.status, 'abstained')
    }
    const service = new DecisionService(config(kind), () => provider(kind, async () => new Promise(() => {})))
    const controller = new AbortController(), pending = service.evaluate('cancel', batch, controller.signal)
    controller.abort(); await assert.rejects(pending, { code: 'DECISION_CANCELLED' })
  })
  test(`${kind}: draft checks cover actual candidate and successful typed review avoids check fallback`, async () => {
    let fallback = 0
    const service = new DecisionService(config(kind), () => provider(kind, transport(() => 'satisfied')))
    const context = { phase: 'planning' as const, idealObjective: 'fix', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [], candidate: { acceptanceCriteria: [{ id: 'criterion' }], workPlan: { units: [{ id: 'unit' }] } } }
    const check = { identity: { provider: 'exact-check', requestedModel: 'bound-model' }, verifyReadOnly: () => true, execute: async (call: any) => { fallback++; assert.equal(call.context.candidate, context.candidate); assert.deepEqual(call.tools, []); return { slotId: call.slotId, outcome: 'completed', summary: 'Complete review', recommendations: [] } } }
    const result = await reviewPlanDecisions({ service, requestId: 'plan', context, signal: signal(), check })
    assert.equal(result.contributions.length, 3); assert.equal(fallback, 0)
    const unavailable = new DecisionService(config(kind), () => provider(kind, async () => new Response('', { status: 503 })))
    const reviewed = await reviewPlanDecisions({ service: unavailable, requestId: 'fallback-plan', context, signal: signal(), check })
    assert.equal(fallback, 3); assert.equal(reviewed.backend.provider, 'exact-check')
  })
}
test('Nimble ignores entropy confidence and uses probability/margin; TypeSafe uses confidence', async () => {
  const response = async () => Response.json({ model: 'm', answers: { '10': { type: 'choice', choice: '20', probabilities: { '20': .95, '2': .04, abstain: .01 }, confidence: .1 } } })
  assert.equal((await provider('nimble', response).evaluate(batch, signal())).answers[0]?.status, 'selected')
  assert.equal((await provider('typesafe', response).evaluate(batch, signal())).answers[0]?.status, 'abstained')
})
test('unknown provider capabilities split independent batches without losing evidence or alternatives', async () => {
  let calls = 0
  const fake: DecisionProvider = { capabilities: { maxQuestions: 1, maxChoices: 3, maxBytes: 99999 }, evaluate: async request => {
    calls++; assert.equal(request.state, batch.state)
    return { answers: request.questions.map(q => ({ id: q.id, status: 'abstained', reason: 'insufficient' })), provider: 'different-backend', requestedModel: 'different-model', policyVersion: 'opaque-policy' }
  } }
  const service = new DecisionService(config('typesafe'), () => fake)
  const result = await service.evaluate('fake', { ...batch, questions: [...batch.questions, { ...batch.questions[0], id: 'other' }] }, signal())
  assert.equal(result.status, 'completed'); assert.equal(calls, 2)
})
test('invalid endpoints, TypeSafe credential reuse and malformed replies fail closed', async () => {
  for (const endpoint of ['http://remote.test/v1', 'https://user:pass@host/v1', 'file:///tmp/a', 'https://host/v1?secret=a', 'https://host/v1#token']) assert.equal(TypedDecisionsConfig.safeParse({ nimble: { endpoint } }).success, false)
  assert.equal(TypedDecisionsConfig.safeParse({ nimble: { credentialRef: 'TYPESAFE_API_KEY' } }).success, false)
  const service = new DecisionService(config('nimble'), () => provider('nimble', async () => Response.json({ model: 'm', answers: {} })))
  assert.deepEqual(await service.evaluate('bad', batch, signal()), { status: 'fallback', reason: 'DECISION_MALFORMED_RESPONSE' })
})

test('portable workflows accept different metadata and one-question provider limits without branching', async () => {
  const fake: DecisionProvider = { capabilities: { maxQuestions: 1, maxChoices: 20, maxBytes: 100000 }, evaluate: async request => ({ provider: 'custom', requestedModel: 'custom-v7', revision: 'opaque-build', policyVersion: 'custom-policy',
    answers: request.questions.map(q => ({ id: q.id, status: 'selected' as const, choiceId: request.purpose === 'akinator' ? 'analysis' : request.purpose === 'skills' ? 'yes' : 'satisfied' })) }) }
  const service = new DecisionService(config('typesafe'), () => fake)
  assert.equal(await classifyTask(service, 'task', 'Analyze this request', undefined, signal()), 'analysis')
  const catalog = [{ kind: 'skill' as const, name: 'kiokuko-soul' }, { kind: 'skill' as const, name: 'custom-analysis' }]
  const resolution = resolveCapabilities({ task: 'Analyze', profile: { taskType: 'analysis', target: null, expected: null, constraints: null }, recommendedTags: [], capabilities: catalog, memoryUse: 'none' })
  assert.ok((await selectInstalledSkills(service, 'skills', 'Analyze', catalog, resolution, signal())).includes('custom-analysis'))
  const result = await reviewPlanDecisions({ service, requestId: 'review', signal: signal(), context: { phase: 'planning', idealObjective: 'Analyze', acceptanceCriteria: [], planningConstraints: [], skillAvailability: [], candidate: { acceptanceCriteria: [{ id: 'done' }], workPlan: { units: [{ id: 'analyze' }] } } }, check: { identity: {}, verifyReadOnly: () => { throw new Error('Must not fall back') }, execute: async () => ({}) } })
  assert.equal(result.backend.revision, 'opaque-build'); assert.equal(result.contributions.length, 3)
})
test('limits do not truncate evidence/options, timeouts do not retry, and parent cancellation stays terminal', async () => {
  let calls = 0
  const c = config('nimble'); c.nimble.timeoutMs = 10
  const backend = provider('nimble', async () => { calls++; return new Promise(() => {}) })
  const service = new DecisionService(c, () => backend)
  const oversized = { ...batch, questions: [{ ...batch.questions[0], choices: [...Array.from({ length: 26 }, (_, i) => ({ id: `c-${i}`, description: 'choice' })), { id: 'abstain', description: 'unknown' }] }] }
  assert.equal((await service.evaluate('too-large', oversized, signal())).status, 'fallback'); assert.equal(calls, 0)
  assert.deepEqual(await service.evaluate('timeout', batch, signal()), { status: 'fallback', reason: 'DECISION_TIMEOUT' }); assert.equal(calls, 1)
  await service.evaluate('timeout', batch, signal()); assert.equal(calls, 1)
  const corrupt: DecisionProvider = { capabilities: backend.capabilities, evaluate: async () => { throw new Error('identity mismatch') } }
  await assert.rejects(new DecisionService(c, () => corrupt).evaluate('identity', batch, signal()), /identity mismatch/)
})

test('adapters preserve absence of returned model, revision and usage metadata', async () => {
  for (const kind of ['typesafe', 'nimble'] as const) {
    const result = await provider(kind, async () => Response.json({ answers: { '10': { type: 'choice', choice: '20', probabilities: { '20': 1, '2': 0, abstain: 0 }, confidence: 1 } } })).evaluate(batch, signal())
    assert.equal(result.returnedModel, undefined); assert.equal(result.revision, undefined); assert.equal(result.usage, undefined); assert.ok(result.requestedModel)
  }
})

test('TypeSafe evaluates mixed typed questions and rejects Score corruption before caching', async () => {
  const typed: DecisionBatch = { purpose: 'skills', state: 'evidence', questions: [
    { id: 'score', type: 'score', instructions: 'Rate', criteria: ['No', 'Maybe', 'Yes'] },
    { id: 'noul', type: 'noul', instructions: 'True?' },
  ] }
  let calls = 0
  const backend = new TypeSafeDecisionProvider(config('typesafe').typesafe, async () => 'fixture-key', async (_url, init) => {
    calls++
    const sent = JSON.parse(String(init?.body))
    assert.deepEqual(sent.questions.score.criteria, ['No', 'Maybe', 'Yes'])
    return Response.json({ model: 'jev-versioned', answers: {
      score: { type: 'score', score: 1.5, probabilities: { 0: 0, 1: .5, 2: .5 }, legend: { 0: 'No', 1: 'Maybe', 2: 'Yes' }, confidence: .8 },
      noul: { type: 'noul', noul: .7 },
    }, usage: { input_tokens: 12, output_tokens: 3 } })
  })
  const service = new DecisionService(config('typesafe'), () => backend)
  const outcome = await service.evaluate('mixed', typed, signal())
  assert.equal(outcome.status, 'completed')
  if (outcome.status === 'completed') assert.deepEqual(outcome.result.answers[0],
    { id: 'score', status: 'measured', type: 'score', score: 1.5, probabilities: [0, .5, .5], confidence: .8 })
  await service.evaluate('mixed', typed, signal()); assert.equal(calls, 1)
  const unsupported = new DecisionService(config('nimble'), () => provider('nimble', async () => { throw Error('must not send') }))
  assert.deepEqual(await unsupported.evaluate('mixed', typed, signal()), { status: 'fallback', reason: 'DECISION_UNSUPPORTED' })
})

test('opt-in Score ranks installed optional Skills while preserving mandatory and baseline fallback', async () => {
  const scoreConfig = TypedDecisionsConfig.parse({ skillSelection: { mode: 'score', minScore: 2, minConfidence: .8 } })
  const catalog = [
    { kind: 'skill' as const, name: 'kiokuko-soul' },
    { kind: 'skill' as const, name: 'strong-debug', description: 'debug failure' },
    { kind: 'skill' as const, name: 'weak-debug', description: 'debug failure' },
    { kind: 'skill' as const, name: 'uncertain-debug', description: 'debug failure' },
  ]
  const resolution = { recommendations: [
    { kind: 'skill' as const, name: 'kiokuko-soul', source: 'akinator_policy' as const },
    { kind: 'skill' as const, name: 'uncertain-debug', source: 'catalog_similarity' as const },
  ] } as ReturnType<typeof resolveCapabilities>
  const fake: DecisionProvider = { capabilities: { maxQuestions: 2, maxChoices: 26, maxBytes: 262144, questionTypes: ['score'], maxScoreLevels: 10 },
    evaluate: async request => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'typed-decisions-v1',
      answers: request.questions.map(q => ({ id: q.id, status: 'measured' as const, type: 'score' as const,
        score: q.id === 'skill-0' ? 3 : q.id === 'skill-2' ? 1 : 2.5,
        probabilities: q.id === 'skill-0' ? [0, 0, 0, 1] : q.id === 'skill-2' ? [0, 1, 0, 0] : [0, 0, .5, .5],
        confidence: q.id === 'skill-1' ? .3 : .9 })) }) }
  const service = new DecisionService(scoreConfig, () => fake)
  const names = await selectInstalledSkills(service, 'score-skills', 'debug failure', catalog, resolution, signal())
  assert.deepEqual(names, ['kiokuko-soul', 'strong-debug', 'uncertain-debug'])
  const fallback = new DecisionService(scoreConfig, () => ({ ...fake, capabilities: { ...fake.capabilities, questionTypes: ['choice'] } }))
  assert.deepEqual(await selectInstalledSkills(fallback, 'fallback-skills', 'debug failure', catalog, resolution, signal()),
    ['kiokuko-soul', 'uncertain-debug'])
})

test('decision observations are bounded, omit evidence and do not double-count cached usage', async () => {
  const input = { ...batch, state: 'PRIVATE_FIXTURE_EVIDENCE' }
  const seen: unknown[] = []
  const backend: DecisionProvider = { capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144 }, evaluate: async request => ({
    provider: 'fixture', requestedModel: 'fixture', policyVersion: 'finite-choice-v1', usage: { input_tokens: 3, output_tokens: 1 },
    answers: request.questions.map(q => ({ id: q.id, status: 'abstained' as const, reason: 'insufficient' as const })),
  }) }
  const service = new DecisionService(config('typesafe'), () => backend, undefined, { onEvaluation: observation => { seen.push(observation); throw Error('observer failed') } })
  assert.equal((await service.evaluate('observed', input, signal())).status, 'completed')
  assert.equal((await service.evaluate('observed', input, signal())).status, 'completed')
  const observations = (service.status() as { decisionObservations: { cacheHit: boolean; inputTokens: number | null }[] }).decisionObservations
  assert.deepEqual(observations.map(o => o.cacheHit), [false, true])
  assert.deepEqual(observations.map(o => o.inputTokens), [3, null])
  assert.equal(JSON.stringify(seen).includes('PRIVATE_FIXTURE_EVIDENCE'), false)
})
