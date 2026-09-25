import test from 'node:test'
import assert from 'node:assert/strict'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService, type DecisionStore } from '../../../../src/dsh/decisions/service.js'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from '../../../../src/dsh/decisions/providers.js'
import { createMemoryReuseRuntime } from '../../../../src/dsh/memory-reuse.js'
import { MemoryReuseConfig } from '../../../../src/memory/reuse.js'
import { DecisionError, type DecisionProvider } from '../../../../src/dsh/decisions/contracts.js'
import { evaluateMemoryBatches } from '../../../../src/dsh/decisions/memory-batches.js'
import { mountTypeSafeCommand } from '../../../../src/dsh/typesafe/command.js'
import { TypeSafeCredentials } from '../../../../src/dsh/typesafe/credentials.js'

const signal = () => new AbortController().signal
const input = (count = 24) => ({ task: 'Resolve SQLITE_BUSY without deleting data.', constraints: 'Preserve data', binding: 'fixture',
  candidates: Array.from({ length: count }, (_, index) => ({ entryId: `entry-${index}`, revision: 1, projectionHash: `projection-${index}`, text: `SQLITE_BUSY evidence ${index}` })) })
test('Noul thresholds are finite and keep a strict uncertain interval', () => {
  for (const [rejectProbability, acceptProbability] of [[-.01, .9], [0, .5], [.5, .9], [.9, .9], [.1, 1.01], [NaN, .9], [.1, Infinity]])
    assert.throws(() => TypedDecisionsConfig.parse({ memorySelection: { mode: 'noul', policyVersion: 'memory-reuse-noul-v1',
      rejectProbability, acceptProbability } }))
  assert.equal(TypedDecisionsConfig.parse({}).memorySelection, undefined)
})
function harness(kind: 'typesafe' | 'nimble', options: { configured?: boolean; timeout?: number; now?: () => number;
  reply?: (body: any) => Response | Promise<Response>; store?: DecisionStore; off?: boolean;
  memorySelection?: { mode: 'noul'; policyVersion: 'memory-reuse-noul-v1'; acceptProbability: number; rejectProbability: number } } = {}) {
  const config = TypedDecisionsConfig.parse({ provider: kind, ...(options.memorySelection ? { memorySelection: options.memorySelection } : {}),
    typesafe: { timeoutMs: options.timeout ?? 5000 }, nimble: { endpoint: 'http://127.0.0.1:9000/v1/systemone', model: 'fixture', timeoutMs: options.timeout ?? 5000 } })
  const calls: any[] = []; let active = 0, maximum = 0
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)); calls.push(body); active++; maximum = Math.max(maximum, active)
    try { return options.reply ? await options.reply(body) : success(body) } finally { active-- }
  }
  const provider = kind === 'typesafe' ? new TypeSafeDecisionProvider(config.typesafe, async () => 'fixture-credential', request)
    : new NimbleDecisionProvider(config.nimble, async () => undefined, request)
  const service = new DecisionService(config, () => provider, options.store, { configurationCheck: async () => options.configured !== false,
    ...(options.now ? { now: options.now } : {}), memoryReuse: MemoryReuseConfig.parse({ mode: options.off ? 'off' : 'auto' }) })
  return { service, calls, maximum: () => maximum }
}
function success(body: any, choose: (id: string) => string = id => id === 'fruit' ? 'apple' : 'applicable'): Response {
  return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
    const choice = choose(id)
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }]
  })) })
}

test('probe is synthetic, single-flight, expires, and does not bind or persist decisions', async () => {
  let now = 0, bindings = 0, writes = 0
  const store: DecisionStore = { bind: async (_id, c) => { bindings++; return c }, read: async () => undefined, write: async () => { writes++ } }
  const h = harness('typesafe', { now: () => now, store })
  assert.equal((h.service.status() as any).readiness.state, 'unverified')
  const states = await Promise.all([h.service.probe(signal()), h.service.probe(signal())])
  assert.ok(states.every(s => s.state === 'ready')); assert.equal(h.calls.length, 1)
  assert.deepEqual(h.calls[0].state, { fruit: 'apple', colour: 'red' }); assert.equal(bindings, 0); assert.equal(writes, 0)
  now = 299999; await h.service.probe(signal()); assert.equal(h.calls.length, 1)
  now = 300001; assert.equal((h.service.status() as any).readiness.state, 'unverified')
  await h.service.probe(signal()); assert.equal(h.calls.length, 2)
  h.service.invalidateReadiness(); await h.service.probe(signal()); assert.equal(h.calls.length, 3)
})

test('missing credentials, off, and missing Nimble endpoint never send memory', async () => {
  const missing = harness('typesafe', { configured: false }), off = harness('typesafe', { off: true })
  assert.equal((await missing.service.probe(signal())).state, 'unconfigured'); assert.equal(missing.calls.length, 0)
  const runtime = (await createMemoryReuseRuntime(missing.service, 'missing', signal()))!
  assert.equal((await runtime.select(input())).status, 'fallback'); assert.equal(missing.calls.length, 0)
  assert.equal(await createMemoryReuseRuntime(off.service, 'off', signal()), undefined); assert.equal(off.calls.length, 0)
  const unavailable = new DecisionService(TypedDecisionsConfig.parse({ provider: 'nimble' }), () => { throw new Error('Must not construct adapter') })
  assert.equal((await unavailable.probe(signal())).state, 'unconfigured')
})

test('failed authentication, malformed reply, wrong answer and low confidence fail the readiness gate', async () => {
  for (const reply of [(body: any) => new Response('', { status: 401 }), () => Response.json({ broken: true }), (body: any) => success(body, () => 'pear'),
    (body: any) => success(body, () => 'unknown')]) {
    const h = harness('typesafe', { reply })
    const runtime = (await createMemoryReuseRuntime(h.service, 'bad-probe', signal()))!
    assert.equal((await runtime.select(input())).status, 'fallback')
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].state, { fruit: 'apple', colour: 'red' })
  }
})

for (const kind of ['typesafe', 'nimble'] as const) test(`${kind}: complete bounded batches, two callers maximum, exact persisted replay and revision invalidation`, async () => {
  let now = 0
  const outcomes = new Map(), configs = new Map()
  const store: DecisionStore = { bind: async (id, c) => { if (!configs.has(id)) configs.set(id, c); return configs.get(id) },
    read: async (id, digest) => outcomes.get(id + digest), write: async (id, digest, value) => { outcomes.set(id + digest, value) } }
  const reply = async (body: any) => { await new Promise(resolve => setTimeout(resolve, 1)); return success(body, id => id === 'fruit' ? 'apple' : id.endsWith('_0') ? 'not_applicable' : id.endsWith('_1') ? 'uncertain' : 'applicable') }
  const h = harness(kind, { store, now: () => now, reply }), runtime = (await createMemoryReuseRuntime(h.service, 'selection', signal()))!
  const value = input(), before = structuredClone(value), first = await runtime.select(value)
  assert.deepEqual(value, before); assert.equal(first.status, 'completed')
  if (first.status === 'completed') assert.deepEqual(first.verdicts.slice(0, 3), ['not_applicable', 'uncertain', 'applicable'])
  assert.equal(h.calls.length, 1 + (kind === 'typesafe' ? 3 : 24)); assert.ok(h.maximum() <= 2)
  for (const call of h.calls.slice(1)) {
    assert.deepEqual(Object.keys(call.questions), Object.keys(call.state.memories))
    assert.ok(Object.keys(call.questions).length <= (kind === 'typesafe' ? 8 : 1))
    assert.equal(JSON.stringify(call).includes('entry-'), false)
  }
  now = 600000
  const restart = harness(kind, { store, now: () => now }), again = (await createMemoryReuseRuntime(restart.service, 'selection', signal()))!
  assert.deepEqual(await again.select(value), first); assert.equal(restart.calls.length, 0, 'completed decisions survive readiness expiry and restart without another API call')
  value.candidates[0]!.revision++
  await again.select(value); assert.ok(restart.calls.length > 1)
})

test('a late service failure discards earlier parts and remembers the whole fallback', async () => {
  const h = harness('typesafe', { reply: body => Object.hasOwn(body.questions, 'memory_16') ? new Response('', { status: 503 }) : success(body) })
  const runtime = (await createMemoryReuseRuntime(h.service, 'late-failure', signal()))!
  assert.equal((await runtime.select(input())).status, 'fallback')
  const calls = h.calls.length
  assert.equal((await runtime.select(input())).status, 'fallback'); assert.equal(h.calls.length, calls)
})

test('Noul memory groups retain uncertain candidates and never split three propositions', async () => {
  const selection = { mode: 'noul' as const, policyVersion: 'memory-reuse-noul-v1' as const,
    acceptProbability: .9, rejectProbability: .1 }
  const h = harness('typesafe', { memorySelection: selection, reply: body => Response.json({ model: body.model,
    answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]: [string, any]) => {
      if (id === 'fruit') return [id, { type: 'choice', choice: 'apple', confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === 'apple' ? 1 : 0])) }]
      const probability = id.startsWith('memory_1:') && id.endsWith(':constraints') ? .1 : id.startsWith('memory_2:') ? .5 : .9
      return [id, { type: 'noul', noul: probability }]
    })) }) })
  const runtime = (await createMemoryReuseRuntime(h.service, 'noul-groups', signal()))!
  const selected = await runtime.select(input(100))
  assert.equal(selected.status, 'completed')
  if (selected.status === 'completed') assert.deepEqual(selected.verdicts.slice(0, 3), ['applicable', 'not_applicable', 'uncertain'])
  const observation = (h.service.status() as any).decisionObservations.at(-1)
  assert.deepEqual(observation.memoryCandidates, { policy: 'memory-reuse-noul-v1', attempted: 100,
    applicable: 98, excluded: 1, uncertain: 1, unassessed: 0 })
  assert.equal(JSON.stringify(observation).includes('SQLITE_BUSY evidence'), false)
  const parts = h.calls.slice(1)
  assert.equal(parts.length, 13)
  for (const part of parts) {
    assert.ok(Object.keys(part.questions).length <= 24)
    assert.equal(Object.keys(part.questions).length % 3, 0)
    assert.equal(Object.keys(part.state.memories).length * 3, Object.keys(part.questions).length)
  }
  assert.deepEqual(await runtime.select(input(100)), selected)
  assert.equal(h.calls.length, 14)
})

test('memory observations count candidates withheld before inference without saving their text', async () => {
  const h = harness('typesafe', { memorySelection: { mode: 'noul', policyVersion: 'memory-reuse-noul-v1', acceptProbability: .9, rejectProbability: .1 },
    reply: body => body.questions.fruit ? success(body) : Response.json({ model: body.model,
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 1 }])) }) })
  const runtime = (await createMemoryReuseRuntime(h.service, 'withheld-observation', signal()))!
  const value = input(2); value.candidates[0]!.text = 'password=super-secret-password'
  const outcome = await runtime.select(value)
  assert.deepEqual(outcome, { status: 'completed', verdicts: ['uncertain', 'applicable'] })
  const observation = (h.service.status() as any).decisionObservations.at(-1)
  assert.deepEqual(observation.memoryCandidates, { policy: 'memory-reuse-noul-v1', attempted: 1,
    applicable: 1, excluded: 0, uncertain: 0, unassessed: 1 })
  assert.equal(JSON.stringify(observation).includes('super-secret-password'), false)
})

test('explicit Noul on Nimble falls back before inference without poisoning Choice readiness', async () => {
  const h = harness('nimble', { memorySelection: { mode: 'noul', policyVersion: 'memory-reuse-noul-v1', acceptProbability: .9, rejectProbability: .1 } })
  await h.service.probe(signal())
  const runtime = (await createMemoryReuseRuntime(h.service, 'unsupported-noul', signal()))!
  assert.deepEqual(await runtime.select(input(2)), { status: 'fallback', reason: 'DECISION_UNSUPPORTED' })
  assert.equal(h.calls.length, 1, 'only the Choice readiness probe may use the provider')
  assert.equal((h.service.status() as any).readiness.state, 'ready')
})

test('stored memory policy survives restart and legacy bindings remain Choice', async () => {
  const configs = new Map<string, ReturnType<typeof TypedDecisionsConfig.parse>>()
  const store: DecisionStore = { binding: async id => configs.get(id), bind: async (id, config) => {
    if (!configs.has(id)) configs.set(id, config)
    return configs.get(id)!
  }, read: async () => undefined, write: async () => {} }
  configs.set('legacy', TypedDecisionsConfig.parse({ provider: 'typesafe' }))
  const selection = { mode: 'noul' as const, policyVersion: 'memory-reuse-noul-v1' as const,
    acceptProbability: .9, rejectProbability: .1 }
  const first = harness('typesafe', { store, memorySelection: selection })
  const legacy = (await createMemoryReuseRuntime(first.service, 'legacy', signal()))!
  assert.equal((await legacy.select(input(1))).status, 'completed')
  assert.ok(first.calls.at(-1)?.questions.memory_0)
  const fresh = (await createMemoryReuseRuntime(first.service, 'fresh', signal()))!
  assert.equal(configs.get('fresh')?.memorySelection?.mode, 'noul')
  await first.service.alias('run-alias', 'fresh')
  assert.deepEqual(configs.get('run-alias')?.memorySelection, selection)
  const restarted = harness('typesafe', { store })
  const resumed = (await createMemoryReuseRuntime(restarted.service, 'fresh', signal()))!
  assert.equal(resumed.identity, fresh.identity)
  assert.equal(configs.get('legacy')?.memorySelection, undefined)
})

test('later preflight failure prevents every memory inference', async () => {
  let preflights = 0, memoryCalls = 0
  const provider: DecisionProvider = { capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144, questionTypes: ['choice', 'noul'] },
    preflight: async () => { if (++preflights === 2) throw new DecisionError('UNAVAILABLE') },
    evaluate: async batch => {
      if (batch.purpose === 'memory-reuse' && batch.questions[0]?.id !== 'fruit') memoryCalls++
      return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
        answers: batch.questions.map(q => q.id === 'fruit' ? { id: q.id, status: 'selected' as const, choiceId: 'apple' }
          : { id: q.id, status: 'measured' as const, type: 'noul' as const, probability: 1 }) }
    } }
  const config = TypedDecisionsConfig.parse({ memorySelection: { mode: 'noul', policyVersion: 'memory-reuse-noul-v1', acceptProbability: .9, rejectProbability: .1 } })
  const service = new DecisionService(config, () => provider)
  const runtime = (await createMemoryReuseRuntime(service, 'preflight', signal()))!
  assert.deepEqual(await runtime.select(input(9)), { status: 'fallback', reason: 'DECISION_UNAVAILABLE' })
  assert.equal(preflights, 2)
  assert.equal(memoryCalls, 0)
})

test('Noul mapping rejects missing, extra, and mismatched references before inference', async () => {
  let calls = 0
  const provider: DecisionProvider = { capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144, questionTypes: ['noul'] },
    evaluate: async () => { calls++; throw new Error('must not infer') } }
  const questions = ['applicability', 'constraints', 'prerequisites'].map(name => ({ id: `memory_0:${name}`, type: 'noul' as const, instructions: name }))
  const state = { task: 'task', constraints: '', memories: { memory_0: 'projected' },
    questionMemory: Object.fromEntries(questions.map(q => [q.id, 'memory_0'])) }
  for (const bad of [
    { ...state, questionMemory: { ...state.questionMemory, 'memory_0:constraints': 'memory_1' } },
    { ...state, questionMemory: { ...state.questionMemory, extra: 'memory_0' } },
    { ...state, questionMemory: { 'memory_0:applicability': 'memory_0', 'memory_0:constraints': 'memory_0' } },
  ]) await assert.rejects(evaluateMemoryBatches(provider, { purpose: 'memory-reuse', questions, state: bad }, 'typesafe', signal()), { code: 'DECISION_INVALID_INPUT' })
  assert.equal(calls, 0)
})

test('an overlarge single Noul candidate is retained as unassessed', async () => {
  let calls = 0
  const provider: DecisionProvider = { capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144, questionTypes: ['noul'] },
    preflight: async () => { throw new DecisionError('TOO_LARGE') },
    evaluate: async () => { calls++; throw new Error('must not infer') } }
  const questions = ['applicability', 'constraints', 'prerequisites'].map(name => ({ id: `memory_0:${name}`, type: 'noul' as const, instructions: name }))
  const state = { task: 'task', constraints: '', memories: { memory_0: 'projected' },
    questionMemory: Object.fromEntries(questions.map(q => [q.id, 'memory_0'])) }
  const result = await evaluateMemoryBatches(provider, { purpose: 'memory-reuse', questions, state }, 'typesafe', signal())
  assert.deepEqual(result.answers.map(a => a.status), ['abstained', 'abstained', 'abstained'])
  assert.deepEqual(result.answers.map(a => a.status === 'abstained' && a.reason), ['unassessed', 'unassessed', 'unassessed'])
  assert.equal(result.requestedModel, 'unassessed')
  assert.equal(calls, 0)
})

test('preflight isolates an overlarge candidate and checks every final part before inference', async () => {
  const questions = Array.from({ length: 9 }, (_, index) => ['applicability', 'constraints', 'prerequisites'].map(name =>
    ({ id: `memory_${index}:${name}`, type: 'noul' as const, instructions: name }))).flat()
  const memories = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`memory_${index}`, `projected-${index}`]))
  const questionMemory = Object.fromEntries(questions.map(q => [q.id, q.id.split(':')[0]]))
  let inference = 0, preflight = 0, finalPreflights = 0
  const provider: DecisionProvider = { capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144, questionTypes: ['noul'] },
    preflight: async part => { preflight++; if (Object.hasOwn((part.state as any).memories, 'memory_3')) throw new DecisionError('TOO_LARGE'); finalPreflights++ },
    evaluate: async part => { inference++; assert.ok(finalPreflights > 0)
      return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: part.questions.map(q =>
        ({ id: q.id, status: 'measured', type: 'noul', probability: 1 })) } } }
  const result = await evaluateMemoryBatches(provider, { purpose: 'memory-reuse', questions,
    state: { task: 'task', constraints: '', memories, questionMemory } }, 'typesafe', signal())
  assert.ok(preflight > 2)
  assert.ok(inference > 0)
  assert.deepEqual(result.answers.slice(9, 12).map(answer => answer.status === 'abstained' && answer.reason),
    ['unassessed', 'unassessed', 'unassessed'])
  assert.equal(result.answers.filter(answer => answer.status === 'measured').length, 24)
})

test('a model or revision change between Noul parts rejects every partial result', async () => {
  const questions = Array.from({ length: 2 }, (_, index) => ['applicability', 'constraints', 'prerequisites'].map(name =>
    ({ id: `memory_${index}:${name}`, type: 'noul' as const, instructions: name }))).flat()
  const state = { task: 'task', constraints: '', memories: { memory_0: 'first', memory_1: 'second' },
    questionMemory: Object.fromEntries(questions.map(q => [q.id, q.id.split(':')[0]])) }
  for (const changing of ['returnedModel', 'revision'] as const) {
    const provider: DecisionProvider = { capabilities: { maxQuestions: 3, maxChoices: 26, maxBytes: 262144, questionTypes: ['noul'] },
      evaluate: async part => ({ provider: 'fixture', requestedModel: 'fixed', policyVersion: 'fixture',
        returnedModel: changing === 'returnedModel' && part.questions[0]!.id.startsWith('memory_1:') ? 'changed' : 'fixed',
        revision: changing === 'revision' && part.questions[0]!.id.startsWith('memory_1:') ? 'changed' : 'fixed',
        answers: part.questions.map(q => ({ id: q.id, status: 'measured', type: 'noul', probability: 1 })) }) }
    await assert.rejects(evaluateMemoryBatches(provider, { purpose: 'memory-reuse', questions, state }, 'typesafe', signal()),
      { code: 'DECISION_MALFORMED_RESPONSE' })
  }
})

test('the two-request limit is shared across simultaneous logical requests', async () => {
  const h = harness('nimble', { reply: async body => { await new Promise(resolve => setTimeout(resolve, 2)); return success(body) } })
  const first = (await createMemoryReuseRuntime(h.service, 'parallel-1', signal()))!
  const second = (await createMemoryReuseRuntime(h.service, 'parallel-2', signal()))!
  assert.ok((await Promise.all([first.select(input(4)), second.select(input(4))])).every(result => result.status === 'completed'))
  assert.equal(h.calls.length, 9); assert.equal(h.maximum(), 2)
})

test('empty, unsafe, and overlarge material never triggers a probe; single Nimble overflow remains uncertain', async () => {
  const h = harness('nimble', { reply: body => Object.hasOwn(body.questions, 'memory_0') ? new Response('', { status: 413 }) : success(body) })
  const runtime = (await createMemoryReuseRuntime(h.service, 'large', signal()))!
  await runtime.select(input(0)); assert.equal(h.calls.length, 0)
  const tooLarge = input(1); tooLarge.candidates[0]!.text = 'x'.repeat(300000)
  await runtime.select(tooLarge); assert.equal(h.calls.length, 0)
  const secret = input(1); secret.task = 'password=super-secret-password'
  await runtime.select(secret); assert.equal(h.calls.length, 0)
  const secretMemory = input(1); secretMemory.candidates[0]!.text = 'password=super-secret-password'
  await runtime.select(secretMemory); assert.equal(h.calls.length, 0)
  const result = await runtime.select(input(2)); assert.equal(result.status, 'completed')
  if (result.status === 'completed') assert.deepEqual(result.verdicts, ['uncertain', 'applicable'])
})

test('status checks local credentials without probing; failed probes cool down for thirty seconds', async () => {
  const missing = harness('typesafe', { configured: false })
  assert.equal((await missing.service.inspectStatus(signal()) as any).readiness.state, 'unconfigured')
  assert.equal(missing.calls.length, 0)
  let now = 0
  const h = harness('typesafe', { now: () => now, reply: () => new Response('', { status: 401 }) })
  await h.service.probe(signal()); now = 29999; await h.service.probe(signal()); assert.equal(h.calls.length, 1)
  now = 30001; await h.service.probe(signal()); assert.equal(h.calls.length, 2)
})

test('cancelling one subscriber leaves the shared probe available to the other subscriber', async () => {
  let finish!: (response: Response) => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  const h = harness('typesafe', { reply: () => { started(); return new Promise(resolve => { finish = resolve }) } })
  const controller = new AbortController(), first = h.service.probe(controller.signal), second = h.service.probe(signal())
  const rejected = assert.rejects(first)
  await began; controller.abort(); await rejected
  finish(success(h.calls[0])); assert.equal((await second).state, 'ready'); assert.equal(h.calls.length, 1)
})

test('credential replacement outside the key command requires a fresh probe; deletion blocks disclosure', async () => {
  let identity: string | false = 'credential-generation-one', probes = 0
  const service = new DecisionService(TypedDecisionsConfig.parse({}), () => ({ capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144 },
    evaluate: async batch => { probes++; return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: 'apple' })) } },
  }), undefined, { configurationCheck: async () => identity })
  await service.probe(signal()); await service.probe(signal()); assert.equal(probes, 1)
  identity = 'credential-generation-two'; await service.probe(signal()); assert.equal(probes, 2)
  assert.equal(JSON.stringify(service.status()).includes(identity), false)
  identity = false; assert.equal((await service.probe(signal())).state, 'unconfigured'); assert.equal(probes, 2)
})

test('deadline and cancellation are bounded even for a provider that ignores abort', async () => {
  const h = harness('typesafe', { timeout: 10, reply: async () => new Promise(() => {}) })
  const runtime = (await createMemoryReuseRuntime(h.service, 'timeout', signal()))!
  assert.equal((await runtime.select(input())).status, 'fallback'); assert.equal(h.calls.length, 1)
  assert.equal((await runtime.select(input())).status, 'fallback'); assert.equal(h.calls.length, 1)
  const controller = new AbortController(), second = (await createMemoryReuseRuntime(h.service, 'cancel', controller.signal))!
  controller.abort(); await assert.rejects(second.select(input()))
})

test('key set and clear invalidate readiness without exposing the key', async () => {
  const h = harness('typesafe'); await h.service.probe(signal())
  let definition: any
  const credentials = new TypeSafeCredentials(() => ({ resolve: async () => undefined, describe: async () => ({ configured: true, writable: true }), set: async () => {}, unset: async () => {} }))
  mountTypeSafeCommand({ register: d => { definition = d; return () => {} } }, credentials, () => h.service.invalidateReadiness())
  const response = await definition.handler({ signal: signal(), rawInput: 'fixture-credential' })
  assert.equal(response.text.includes('fixture-credential'), false); assert.equal((h.service.status() as any).readiness.state, 'unverified')
  await h.service.probe(signal()); await definition.handler({ signal: signal(), rawInput: 'clear' })
  assert.equal((h.service.status() as any).readiness.state, 'unverified')
})
