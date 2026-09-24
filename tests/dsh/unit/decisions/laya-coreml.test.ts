import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { LayaCoreMLDecisionProvider, layaRequestBody } from '../../../../src/dsh/decisions/laya-coreml.js'
import { TypedDecisionsConfig, resolveDecisionConfiguration } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { DecisionError, type DecisionBatch, type DecisionProvider } from '../../../../src/dsh/decisions/contracts.js'
import { canonicalContentHash } from '../../../../src/serialization/validate.js'
import { layaConfig, layaReply, layaRuntime } from '../../helpers/laya.js'
const signal = () => new AbortController().signal
const batch: DecisionBatch = { purpose: 'lisp', state: { z: '末尾も保存', a: 1 }, questions: [{ id: '10', instructions: 'Choose', choices: [{ id: '20', description: 'One' }, { id: '2', description: 'Two' }, { id: 'unknown', description: 'Unknown' }], abstainId: 'unknown' }] }

test('Laya config remains optional, old normalized JSON/digest stable, socket resolves once before binding', async () => {
  const old = { mode: 'auto', provider: 'typesafe', typesafe: { model: 'jev-latest', timeoutMs: 5000, acceptance: { minConfidence: .8 } }, nimble: { timeoutMs: 5000, acceptance: { minProbability: .9, minMargin: .2 } } }
  assert.deepEqual(TypedDecisionsConfig.parse(old), old)
  assert.equal(canonicalContentHash(TypedDecisionsConfig.parse(old)), canonicalContentHash(old))
  const config = layaConfig('sock/worker.sock'), resolved = resolveDecisionConfiguration(config, '/repo')
  assert.equal(resolved['laya-coreml']!.socketPath, '/repo/sock/worker.sock'); assert.equal(config['laya-coreml']!.socketPath, 'sock/worker.sock')
  assert.equal(resolveDecisionConfiguration(layaConfig('~/Library/Caches/laya-coreml/worker.sock'), '/repo')['laya-coreml']!.socketPath, resolve(homedir(), 'Library/Caches/laya-coreml/worker.sock'))
  const service = new DecisionService(config, c => new LayaCoreMLDecisionProvider(c['laya-coreml']), undefined, { repositoryRoot: '/repo' })
  assert.equal((await service.bind('r'))['laya-coreml']!.socketPath, '/repo/sock/worker.sock')
  assert.equal((service.status() as any).configurationReady, true)
  const missing = new DecisionService(TypedDecisionsConfig.parse({ provider: 'laya-coreml' }), c => new LayaCoreMLDecisionProvider(c['laya-coreml']))
  assert.equal((missing.status() as any).configurationReady, false)
  assert.equal((await missing.probe(signal())).state, 'unconfigured')
  assert.deepEqual(await missing.evaluate('missing', batch, signal()), { status: 'fallback', reason: 'DECISION_UNAVAILABLE' })
})

test('Laya serializes complete canonical state and ordered numeric IDs, verifies worker before evidence, uses strict prediction', async () => {
  const config = layaConfig(), bodies: string[] = []
  const provider = new LayaCoreMLDecisionProvider(config['laya-coreml'], async (_path, json) => { bodies.push(json); return layaReply(JSON.parse(json), () => '20') })
  assert.equal(bodies.length, 0)
  const input = structuredClone(batch), outcome = await provider.evaluate(input, signal())
  assert.deepEqual(input, batch); assert.equal(outcome.answers[0]?.status, 'selected'); assert.equal(outcome.revision, layaRuntime.runtimeFingerprint)
  assert.deepEqual(bodies.map(b => JSON.parse(b).op), ['health', 'predict_strict'])
  assert.equal(JSON.parse(bodies[1]!).state, '{"a":1,"z":"末尾も保存"}')
  assert.ok(bodies[1]!.indexOf('"20":') < bodies[1]!.indexOf('"2":'))
  await provider.preflight(batch, signal()); assert.equal(JSON.parse(bodies[2]!).op, 'preflight')
  const unconfigured = new LayaCoreMLDecisionProvider(config['laya-coreml'], async () => ({ version: 1, ok: true, status: 'ready' }))
  await assert.rejects(unconfigured.evaluate(batch, signal()), { code: 'DECISION_UNSUPPORTED' })
})

test('Laya acceptance uses probabilities, margin and conservative rounding; entropy/action are irrelevant', async () => {
  for (const [probabilities, choice, expected] of [
    [{ '20': .98, '2': .01, unknown: .01 }, '20', 'selected'],
    [{ '20': .9, '2': .05, unknown: .05 }, '20', 'uncertain'],
    [{ '20': .5, '2': .5, unknown: 0 }, '20', 'tie'],
    [{ '20': 0, '2': 0, unknown: 1 }, 'unknown', 'insufficient'],
  ] as const) {
    const provider = new LayaCoreMLDecisionProvider(layaConfig()['laya-coreml'], async (_path, json) => {
      const request = JSON.parse(json), reply = layaReply(request)
      if (reply.result) Object.assign(reply.result.answers['10'], { probabilities, choice })
      return reply
    })
    const answer = (await provider.evaluate(batch, signal())).answers[0]!
    assert.equal(answer.status === 'selected' ? 'selected' : answer.status === 'abstained' ? answer.reason : 'measured', expected)
  }
  const uniform = { ...batch, questions: [{ ...batch.questions[0]!, choices: Array.from({ length: 32 }, (_, i) => ({ id: `c${i}`, description: '' })), abstainId: 'c31' }] }
  const provider = new LayaCoreMLDecisionProvider(layaConfig()['laya-coreml'], async (_path, json) => {
    const reply = layaReply(JSON.parse(json)); if (reply.result) reply.result.answers['10'].probabilities = Object.fromEntries(uniform.questions[0]!.choices.map(c => [c.id, .0312])); return reply
  })
  assert.deepEqual((await provider.evaluate(uniform, signal())).answers[0], { id: '10', status: 'abstained', reason: 'tie' })
})

test('Laya rejects corrupt identity, question/choice sets, probabilities and usage', async () => {
  const mutations: Array<(reply: any) => void> = [
    r => { r.runtime.runtimeFingerprint = `sha256:${'b'.repeat(64)}` },
    r => { r.result.answers.extra = r.result.answers['10'] }, r => { delete r.result.answers['10'] },
    r => { r.result.answers['10'].choice = 'unknown-id' }, r => { r.result.answers['10'].choice = '2' },
    r => { r.result.answers['10'].probabilities['20'] = .5 }, r => { r.result.answers['10'].probabilities['20'] = NaN },
    r => { r.result.usage.input_tokens = 97 }, r => { r.result.usage.output_tokens = 1 },
  ]
  for (const mutate of mutations) {
    const provider = new LayaCoreMLDecisionProvider(layaConfig()['laya-coreml'], async (_path, json) => { const reply = structuredClone(layaReply(JSON.parse(json), () => '20')); if (reply.result) mutate(reply); return reply })
    await assert.rejects(provider.evaluate(batch, signal()), (e: any) => ['DECISION_UNSUPPORTED', 'DECISION_MALFORMED_RESPONSE'].includes(e.code))
  }
  const off = layaConfig(); off.mode = 'off'
  const service = new DecisionService(off, () => new LayaCoreMLDecisionProvider(off['laya-coreml'], async () => { throw new Error('must not communicate') }))
  await service.probe(signal()); assert.equal((await service.evaluate('off', batch, signal())).status, 'fallback')
})

test('compaction forwards per-part preflight through wrapper before any batch inference, and overflow preserves readiness', async () => {
  let inference = 0, preflight = 0, reject = true
  const backend: DecisionProvider = { capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144, maxPromptTokens: 96 },
    preflight: async part => { preflight++; assert.equal(part.questions.length, 1); if (reject && part.questions[0]!.id === 'later') throw new DecisionError('TOO_LARGE') },
    evaluate: async part => { if (part.purpose === 'compaction') inference++; return { provider: 'laya-coreml', requestedModel: layaRuntime.model, policyVersion: 'fixture', answers: part.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : '20' })) } } }
  const service = new DecisionService(layaConfig(), () => backend)
  const input: DecisionBatch = { ...batch, purpose: 'compaction', questions: [...batch.questions, { ...batch.questions[0]!, id: 'later' }] }
  assert.deepEqual(await service.evaluate('too-big', input, signal()), { status: 'fallback', reason: 'DECISION_TOO_LARGE' })
  assert.equal(preflight, 2); assert.equal(inference, 0); assert.equal((service.status() as any).readiness.state, 'ready')
  reject = false
  assert.equal((await service.evaluate('fits', input, signal())).status, 'completed'); assert.equal(inference, 2)
  assert.equal((await service.evaluate('fits', input, signal())).status, 'completed'); assert.equal(inference, 2)
})
