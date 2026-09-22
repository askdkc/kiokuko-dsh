import assert from 'node:assert/strict'
import test from 'node:test'
import { TypedDecisionsConfig, decisionConfigurationIssue } from '../../../../src/dsh/decisions/config.js'
import { discoverLayaConfiguration } from '../../../../src/dsh/decisions/laya-coreml.js'
import { LayaV1DecisionProvider } from '../../../../src/dsh/decisions/laya-v1.js'
import type { DecisionBatch } from '../../../../src/dsh/decisions/contracts.js'
import { layaV1Reply } from '../../helpers/laya.js'

const signal = () => new AbortController().signal
const batch: DecisionBatch = { purpose: 'lisp', state: { z: '日本語の末尾', a: 1 }, questions: [{ id: '10', instructions: 'Choose', choices: [{ id: '20', description: 'One' }, { id: '2', description: 'Two' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }
const configuration = () => TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } })

test('plain v1 health discovers a usable socket without claiming a model fingerprint or requiring strict operations', async () => {
  const original = TypedDecisionsConfig.parse({ provider: 'laya-coreml' })
  const config = await discoverLayaConfiguration(original, '/repo', signal(), async () => layaV1Reply({ op: 'health' }))
  assert.equal(config['laya-coreml']!.protocol, 'v1')
  assert.equal(config['laya-coreml']!.runtimeFingerprint, undefined)
  assert.equal(config['laya-coreml']!.model, 'laya-rl-agent')
  assert.equal(decisionConfigurationIssue(config), undefined)
  assert.equal(original['laya-coreml'], undefined)
  const advertised = await discoverLayaConfiguration(original, '/repo', signal(), async () => ({ ...layaV1Reply({ op: 'health' }), operations: ['health', 'predict'] }))
  assert.equal(advertised['laya-coreml']!.protocol, 'v1')
  assert.equal(decisionConfigurationIssue(TypedDecisionsConfig.parse({ ...config, 'laya-coreml': { ...config['laya-coreml'], runtimeFingerprint: `sha256:${'a'.repeat(64)}` } })), 'invalid_laya_v1_configuration')
  for (const pins of [{ model: 'aac6fef/laya-multilingual-coreml-ane' }, { runtimeFingerprint: `sha256:${'a'.repeat(64)}` }]) {
    await assert.rejects(discoverLayaConfiguration(TypedDecisionsConfig.parse({ ...original, 'laya-coreml': pins }), '/repo', signal(), async () => layaV1Reply({ op: 'health' })), { code: 'DECISION_UNSUPPORTED' })
  }
})

test('v1 sends only the original predict envelope, preserves numeric key order and validates choices', async () => {
  const bodies: string[] = [], settings = configuration()['laya-coreml']!
  const provider = new LayaV1DecisionProvider(settings, async (_path, body) => { bodies.push(body); return layaV1Reply(JSON.parse(body), () => '20') })
  assert.equal('preflight' in provider, false)
  assert.equal('maxPromptTokens' in provider.capabilities, false)
  const result = await provider.evaluate(batch, signal())
  assert.deepEqual(result.answers, [{ id: '10', status: 'selected', choiceId: '20' }])
  assert.equal(result.revision, undefined)
  assert.deepEqual(bodies.map(b => JSON.parse(b).op), ['health', 'predict'])
  assert.deepEqual(Object.keys(JSON.parse(bodies[1]!)), ['version', 'op', 'state', 'questions'])
  assert.equal(JSON.parse(bodies[1]!).state, '{"a":1,"z":"日本語の末尾"}')
  assert.ok(bodies[1]!.indexOf('"20":') < bodies[1]!.indexOf('"2":'))
})

test('v1 refuses malformed results, errors, oversized input and cancellation without retry', async () => {
  for (const mutate of [
    (r: any) => { r.result.answers.extra = r.result.answers['10'] },
    (r: any) => { delete r.result.answers['10'] },
    (r: any) => { r.result.answers['10'].choice = 'not-a-choice' },
    (r: any) => { r.result.answers['10'].probabilities['20'] = .4 },
    (r: any) => { r.result.model = 'unexpected' },
    (r: any) => { r.result.usage.input_tokens = -1 },
  ]) {
    const provider = new LayaV1DecisionProvider(configuration()['laya-coreml']!, async (_path, body) => {
      const r = layaV1Reply(JSON.parse(body), () => '20'); if (r.result) mutate(r); return r
    })
    await assert.rejects(provider.evaluate(batch, signal()), { code: 'DECISION_MALFORMED_RESPONSE' })
  }
  let calls = 0
  const provider = new LayaV1DecisionProvider(configuration()['laya-coreml']!, async () => { calls++; throw new Error('Must reject before connecting') })
  await assert.rejects(provider.evaluate({ ...batch, state: 'a'.repeat(262144) }, signal()), { code: 'DECISION_TOO_LARGE' })
  await assert.rejects(provider.evaluate(batch, AbortSignal.abort()), { code: 'DECISION_CANCELLED' })
  assert.equal(calls, 0)
})
