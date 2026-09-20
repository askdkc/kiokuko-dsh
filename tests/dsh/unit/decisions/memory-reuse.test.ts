import test from 'node:test'
import assert from 'node:assert/strict'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService, type DecisionStore } from '../../../../src/dsh/decisions/service.js'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from '../../../../src/dsh/decisions/providers.js'
import { createMemoryReuseRuntime } from '../../../../src/dsh/memory-reuse.js'
import { MemoryReuseConfig } from '../../../../src/memory/reuse.js'
import { mountTypeSafeCommand } from '../../../../src/dsh/typesafe/command.js'
import { TypeSafeCredentials } from '../../../../src/dsh/typesafe/credentials.js'

const signal = () => new AbortController().signal
const input = (count = 24) => ({ task: 'Resolve SQLITE_BUSY without deleting data.', constraints: 'Preserve data', binding: 'fixture',
  candidates: Array.from({ length: count }, (_, index) => ({ entryId: `entry-${index}`, revision: 1, projectionHash: `projection-${index}`, text: `SQLITE_BUSY evidence ${index}` })) })
function harness(kind: 'typesafe' | 'nimble', options: { configured?: boolean; timeout?: number; now?: () => number;
  reply?: (body: any) => Response | Promise<Response>; store?: DecisionStore; off?: boolean } = {}) {
  const config = TypedDecisionsConfig.parse({ provider: kind, typesafe: { timeoutMs: options.timeout ?? 5000 }, nimble: { endpoint: 'http://127.0.0.1:9000/v1/systemone', model: 'fixture', timeoutMs: options.timeout ?? 5000 } })
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
