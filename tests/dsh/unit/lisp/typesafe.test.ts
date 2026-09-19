import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpTypeSafeClient } from '../../../../src/dsh/typesafe/client.js'
import { TypeSafeCredentials, type TypeSafeCredentialProvider } from '../../../../src/dsh/typesafe/credentials.js'
import { TYPESAFE_BYTES, TYPESAFE_ENDPOINT, parseTypeSafeRequest } from '../../../../src/dsh/typesafe/contracts.js'
import { mountTypeSafeCommand } from '../../../../src/dsh/typesafe/command.js'
import type { DshNativeCommandDefinition } from '../../../../src/dsh/commands.js'

const input = { state: [{ code: 'return value', available: true, missing: null }], questions: {
  relevant: { type: 'noul', instructions: { question: 'Is this relevant?' }, criteria: { true: 'Related', false: 'Unrelated' } },
  category: { type: 'choice', instructions: ['Classify the evidence'], criteria: { bug: 'Defect', unknown: null } },
  severity: { type: 'score', instructions: 'How severe?', criteria: ['Low', 'High'] },
} }
const output = () => ({ model: 'jev-1.13.0', answers: {
  relevant: { type: 'noul', noul: 0.8 }, category: { type: 'choice', choice: 'unknown', probabilities: { bug: 0.25, unknown: 0.75 }, confidence: 0.5 },
  severity: { type: 'score', score: 0.8, probabilities: { '0': 0.2, '1': 0.8 }, legend: { '0': 'Low', '1': 'High' }, confidence: 0.6 },
}, usage: { input_tokens: 100, output_tokens: 20 } })
const credentials = () => new TypeSafeCredentials(() => undefined, () => 'fixture-secret')
const evaluate = (response: () => Response | Promise<Response>, value: unknown = input, signal = new AbortController().signal) =>
  new HttpTypeSafeClient(credentials(), async () => response()).evaluate(value, signal)

test('mixed questions serialize JSON and preserve requested and returned model identities; key replacement is immediate', async () => {
  let key = 'first-secret'
  const seen: RequestInit[] = []
  const client = new HttpTypeSafeClient(new TypeSafeCredentials(() => undefined, () => key), async (url, init) => {
    assert.equal(url, TYPESAFE_ENDPOINT); seen.push(init!)
    return Response.json(output())
  })
  const before = JSON.stringify(input)
  assert.deepEqual(await client.evaluate(input, new AbortController().signal), output())
  key = 'second-secret'
  await client.evaluate({ ...input, model: 'explicit-model' }, new AbortController().signal)
  assert.equal(JSON.parse(String(seen[0]!.body)).model, 'jev-latest')
  assert.equal(JSON.parse(String(seen[1]!.body)).model, 'explicit-model')
  assert.equal((seen[0]!.headers as any).Authorization, 'Bearer first-secret')
  assert.equal((seen[1]!.headers as any).Authorization, 'Bearer second-secret')
  assert.equal(seen[0]!.redirect, 'error'); assert.equal(JSON.stringify(input), before)
  assert.deepEqual(await client.status(), { configured: true, source: 'env', writable: false })
})

test('invalid or oversized requests have no credential or HTTP effects', async () => {
  let effects = 0
  const client = new HttpTypeSafeClient(new TypeSafeCredentials(() => { effects++; return undefined }), async () => { effects++; return Response.json(output()) })
  for (const value of [undefined, {}, { ...input, state: 3 }, { ...input, headers: {} }, { ...input, url: 'https://example.com' },
    { ...input, timeoutMs: -1 }, { ...input, model: '' }, { ...input, questions: {} },
    { ...input, questions: { x: { type: 'score', instructions: 'x', criteria: ['single'] } } },
    { ...input, questions: { x: { type: 'choice', instructions: 'x', criteria: {} } } },
    { ...input, state: { invalid: Infinity } }, { ...input, state: { invalid: undefined } },
    { ...input, state: '界'.repeat(TYPESAFE_BYTES) }]) {
    await assert.rejects(client.evaluate(value, new AbortController().signal), (error: any) => /^TYPESAFE_(INVALID_REQUEST|REQUEST_TOO_LARGE)$/.test(error.code))
  }
  assert.equal(effects, 0)
  assert.equal(parseTypeSafeRequest({ ...input, state: 'text' }).request.state, 'text')
  const cycle: any = {}; cycle.self = cycle
  assert.throws(() => parseTypeSafeRequest({ ...input, state: cycle }), { code: 'TYPESAFE_INVALID_REQUEST' })
})

test('validate answer identity, type, choices, distributions, confidence, score range and usage', async () => {
  const mutations: ((o: any) => void)[] = [
    o => { delete o.answers.relevant }, o => { o.answers.extra = o.answers.relevant }, o => { o.answers.relevant.type = 'score' },
    o => { o.answers.relevant.noul = 2 }, o => { o.answers.category.choice = 'absent' }, o => { o.answers.category.choice = 'bug' },
    o => { delete o.answers.category.probabilities.bug }, o => { o.answers.category.probabilities.bug = -0.25 },
    o => { o.answers.category.probabilities.bug = 0.5 }, o => { o.answers.category.confidence = 1.1 },
    o => { o.answers.severity.score = 2 }, o => { o.answers.severity.legend['1'] = 'wrong rubric' },
    o => { o.answers.severity.probabilities['2'] = 0 }, o => { o.usage.input_tokens = -1 },
    o => { o.model = '' }, o => { o.debug = 'unexpected response field' },
  ]
  for (const mutate of mutations) {
    const value = output(); mutate(value)
    await assert.rejects(evaluate(() => Response.json(value)), { code: 'TYPESAFE_MALFORMED_RESPONSE' })
  }
  await assert.rejects(evaluate(() => new Response('not-json secret')), { code: 'TYPESAFE_MALFORMED_RESPONSE' })
})

test('responses are bounded by actual streamed bytes and content length, never truncated', async () => {
  await assert.rejects(evaluate(() => new Response('x', { headers: { 'content-length': String(TYPESAFE_BYTES + 1) } })), { code: 'TYPESAFE_RESPONSE_TOO_LARGE' })
  let cancelled = false
  await assert.rejects(evaluate(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(TYPESAFE_BYTES)); controller.enqueue(new Uint8Array(1)) }, cancel() { cancelled = true },
  }))), { code: 'TYPESAFE_RESPONSE_TOO_LARGE' })
  assert.equal(cancelled, true)
})

test('HTTP failures and missing credentials are sanitized and never retried', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [422, 'INVALID_REQUEST'], [529, 'UNAVAILABLE'], [500, 'UNAVAILABLE']] as const) {
    let calls = 0
    await assert.rejects(evaluate(() => { calls++; return new Response('fixture-secret provider diagnostics', { status }) }), { code: `TYPESAFE_${code}` })
    assert.equal(calls, 1)
  }
  await assert.rejects(evaluate(() => { throw new Error('fixture-secret') }), (error: any) => error.code === 'TYPESAFE_UNAVAILABLE' && !JSON.stringify(error).includes('fixture-secret'))
  let calls = 0
  await assert.rejects(new HttpTypeSafeClient(new TypeSafeCredentials(() => undefined, () => undefined), async () => { calls++; return Response.json(output()) }).evaluate(input, new AbortController().signal), { code: 'TYPESAFE_MISSING_CREDENTIAL' })
  assert.equal(calls, 0)
})

test('request timeout and cancellation stop fetch/body reads and discard noncooperative late responses', async () => {
  let signal: AbortSignal | undefined, finish!: (value: Response) => void
  const client = new HttpTypeSafeClient(credentials(), (_url, options) => { signal = options!.signal!; return new Promise(resolve => { finish = resolve }) })
  await assert.rejects(client.evaluate({ ...input, timeoutMs: 10 }, new AbortController().signal), { code: 'TYPESAFE_TIMEOUT' })
  assert.equal(signal!.aborted, true)
  finish(Response.json(output()))
  const abort = new AbortController()
  const pending = client.evaluate(input, abort.signal)
  await new Promise(resolve => setImmediate(resolve)); abort.abort()
  await assert.rejects(pending, { code: 'TYPESAFE_CANCELLED' }); assert.equal(signal!.aborted, true)
  finish(Response.json(output()))
  let cancelled = false
  await assert.rejects(evaluate(() => new Response(new ReadableStream({ cancel() { cancelled = true } })), { ...input, timeoutMs: 10 }), { code: 'TYPESAFE_TIMEOUT' })
  assert.equal(cancelled, true)
  let calls = 0
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(new HttpTypeSafeClient(credentials(), async () => { calls++; return Response.json(output()) }).evaluate(input, stopped.signal), { code: 'TYPESAFE_CANCELLED' })
  assert.equal(calls, 0)
})

test('credential command reports saved/status/clear without secrets; respects unavailable and read-only sources', async () => {
  let saved: string | undefined, readOnly = false, fail = false, writes = 0
  const provider: TypeSafeCredentialProvider = {
    async resolve() { return saved ? { value: saved, source: 'file' } : undefined },
    async describe() { return { configured: Boolean(saved), source: readOnly ? 'env' : 'file', writable: !readOnly } },
    async set(ref, value) { assert.equal(ref, 'TYPESAFE_API_KEY'); if (fail) throw new Error(value); saved = value; writes++ },
    async unset() { if (fail) throw new Error(saved); saved = undefined; writes++ },
  }
  let current: TypeSafeCredentialProvider | undefined = provider, definition!: DshNativeCommandDefinition
  const secret = 'synthetic-secret-never-record'
  const remove = mountTypeSafeCommand({ register(d) { definition = d; return () => {} } }, new TypeSafeCredentials(() => current, () => undefined))
  assert.equal(definition.recordInput, false)
  const invoke = (rawInput: string) => definition.handler({ rawInput, signal: new AbortController().signal })
  const results = [await invoke(''), await invoke(secret), await invoke('status'), await invoke('replacement-secret')]
  assert.equal(saved, 'replacement-secret'); assert.match(results[1]!.text!, /saved.*not been verified/)
  results.push(await invoke('clear')); assert.equal(saved, undefined)
  readOnly = true; results.push(await invoke(secret)); assert.match(results.at(-1)!.text!, /TYPESAFE_READ_ONLY/)
  results.push(await invoke('clear')); assert.match(results.at(-1)!.text!, /TYPESAFE_READ_ONLY/)
  readOnly = false; fail = true; results.push(await invoke(secret)); assert.match(results.at(-1)!.text!, /TYPESAFE_STORAGE_FAILED/)
  results.push(await invoke('two words'), await invoke('bad\nkey'))
  assert.match(results.at(-1)!.text!, /TYPESAFE_INVALID_KEY/)
  current = undefined; results.push(await invoke(secret), await invoke('clear'))
  assert.match(results.at(-1)!.text!, /TYPESAFE_STORAGE_UNAVAILABLE/)
  assert.equal(writes, 3); assert.ok(!JSON.stringify(results).includes(secret)); remove()
})
