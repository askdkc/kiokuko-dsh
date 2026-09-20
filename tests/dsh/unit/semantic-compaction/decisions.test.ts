import test from 'node:test'
import assert from 'node:assert/strict'
import { DecisionService, type DecisionStore } from '../../../../src/dsh/decisions/service.js'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from '../../../../src/dsh/decisions/providers.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { SemanticCompactionConfig } from '../../../../src/dsh/semantic-compaction/contracts.js'
import type { DecisionBatch } from '../../../../src/dsh/decisions/contracts.js'
const batch: DecisionBatch = { purpose: 'compaction', state: { task: 'Next file.', result: 'Old log completed.', policy: 'v1' }, questions: [{ id: 'r1', instructions: 'Keep required evidence.', choices: [{ id: 'keep', description: 'Required' }, { id: 'shorten', description: 'Stale' }, { id: 'uncertain', description: 'Unknown' }], abstainId: 'uncertain' }] }
const signal = () => new AbortController().signal

for (const provider of ['typesafe', 'nimble'] as const) test(`${provider} compaction shares readiness, accepted finite answers and durable decision binding`, async () => {
  const config = TypedDecisionsConfig.parse({ provider, nimble: { endpoint: 'http://127.0.0.1:9999/v1/systemone', model: 'fixture' } })
  const calls: any[] = [], stored = new Map(); let configured = true
  const store: DecisionStore = { bind: async (_id, config) => config, read: async (id, digest) => stored.get(id + digest), write: async (id, digest, value) => { stored.set(id + digest, value) } }
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)); calls.push(body)
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const choice = id === 'fruit' ? 'apple' : 'shorten'
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === choice ? 1 : 0])) }]
    })) })
  }
  const make = () => new DecisionService(config, () => provider === 'typesafe' ? new TypeSafeDecisionProvider(config.typesafe, async () => 'fixture', request) : new NimbleDecisionProvider(config.nimble, async () => undefined, request), store,
    { configurationCheck: async () => configured, semanticCompaction: SemanticCompactionConfig.parse({}) })
  const first = make(), result = await first.evaluate('session:surface:1', batch, signal(), 'model-config-policy')
  assert.equal(result.status, 'completed'); assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].state, { fruit: 'apple', colour: 'red' })
  assert.deepEqual(await make().evaluate('session:surface:1', batch, signal(), 'model-config-policy'), result)
  assert.equal(calls.length, 3, 'reload probes readiness but reuses persisted accepted classification')
  configured = false
  assert.equal((await first.evaluate('session:surface:1', batch, signal(), 'model-config-policy')).status, 'fallback')
  assert.equal(calls.length, 3, 'removed credentials cannot activate cached mutation')
})

test('Nimble oversized required evidence fails without dropping state or evaluating a partial decision set', async () => {
  const config = TypedDecisionsConfig.parse({ provider: 'nimble', nimble: { endpoint: 'http://127.0.0.1:9999/v1/systemone', model: 'fixture' } })
  const calls: DecisionBatch[] = []
  const service = new DecisionService(config, () => ({ capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144, maxPromptTokens: 2048 }, evaluate: async value => {
    calls.push(value); return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: value.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : 'shorten' })) }
  } }))
  const result = await service.evaluate('too-large', { ...batch, state: { required: '検証根拠'.repeat(1000) } }, signal())
  assert.deepEqual(result, { status: 'fallback', reason: 'DECISION_TOO_LARGE' }); assert.equal(calls.length, 1, 'synthetic readiness only')
})
