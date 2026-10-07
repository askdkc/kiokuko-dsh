import assert from 'node:assert/strict'
import test from 'node:test'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { decodeLayaResult, LayaCoreMLDecisionProvider } from '../../../../src/dsh/decisions/laya-coreml.js'
import { LayaV1DecisionProvider } from '../../../../src/dsh/decisions/laya-v1.js'
import type { DecisionBatch } from '../../../../src/dsh/decisions/contracts.js'
import type { ChoiceDiagnostic } from '../../../../src/dsh/decisions/choice-diagnostics.js'
import { layaConfig, layaReply, layaRuntime } from '../../helpers/laya.js'

const settings = TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } })['laya-coreml']!
const signal = () => new AbortController().signal
const batch: DecisionBatch = {
  purpose: 'akinator', state: '富士山って日本で一番高い山?', questions: [{
    id: 'task-type', instructions: 'Choose intent; abstain if unclear or unsupported.',
    choices: [
      { id: 'debug', description: 'Diagnose or fix a software bug.' },
      { id: 'research', description: 'Look up sources.' },
      { id: 'writing', description: 'Write or transform prose.' },
      { id: 'chat', description: 'Answer questions, advise, or converse.' },
      { id: 'abstain', description: 'Build, review, deploy, analyze, or unclear.' },
    ], abstainId: 'abstain',
  }],
}

// Unmodified response recorded with laya 0.3.24, multilingual revision
// e4e9ddf21a7b1903b7acffd8814ad4307bf63a67, CPU float32 on 2026-10-07.
// This is a decoder regression fixture, not a claim that research is the right intent.
function rawReply() {
  return { version: 1, ok: true, result: { model: 'laya-rl-agent', answers: {
    'task-type': { type: 'choice', choice: 'research',
      probabilities: { debug: 0.0131, research: 0.9466, writing: 0.0122, chat: 0.0167, abstain: 0.0113 },
      confidence: 0.8248, answer_confidence: 0.9466, action: { act_probability: 1.0 } },
  }, usage: { input_tokens: 74, output_tokens: 0, state_tokens: 8, state_tokens_dropped: 0, truncated: false, truncated_questions: [] } },
  server: { predict_ms: 119.658 } }
}

function legacyReply() {
  const reply: any = rawReply()
  delete reply.result.answers['task-type'].answer_confidence
  for (const key of ['state_tokens', 'state_tokens_dropped', 'truncated', 'truncated_questions']) delete reply.result.usage[key]
  return reply
}

test('v1 accepts the recorded raw telemetry result without changing its choice, probabilities or public usage', async () => {
  const raw = rawReply(), before = structuredClone(raw), diagnostics: ChoiceDiagnostic[] = [], calls: string[] = []
  const provider = new LayaV1DecisionProvider(settings, async (_path, body) => {
    const request = JSON.parse(body); calls.push(request.op)
    return request.op === 'health' ? { version: 1, ok: true, status: 'ready' } : raw
  }, diagnostic => { diagnostics.push(diagnostic) })
  const result = await provider.evaluate(batch, signal())
  assert.deepEqual(result.answers, [{ id: 'task-type', status: 'selected', choiceId: 'research' }])
  assert.deepEqual(result.usage, { input_tokens: 74, output_tokens: 0 })
  assert.deepEqual(diagnostics[0]?.probabilities, Object.entries(raw.result.answers['task-type'].probabilities).map(([id, probability]) => ({ id, probability })))
  assert.equal(diagnostics[0]?.confidence, 0.8248)
  assert.deepEqual(raw, before)
  assert.deepEqual(calls, ['health', 'predict'])
  assert.deepEqual(decodeLayaResult(raw.result, batch, settings), decodeLayaResult(legacyReply().result, batch, settings))
})

test('known telemetry stays optional and never replaces the probability/margin gate', () => {
  for (const key of ['answer_confidence', 'state_tokens', 'state_tokens_dropped', 'truncated', 'truncated_questions']) {
    const raw: any = rawReply(), partial = legacyReply()
    if (key === 'answer_confidence') partial.result.answers['task-type'][key] = raw.result.answers['task-type'][key]
    else partial.result.usage[key] = raw.result.usage[key]
    assert.deepEqual(decodeLayaResult(partial.result, batch, settings), decodeLayaResult(raw.result, batch, settings))
  }
  const high = rawReply()
  high.result.answers['task-type'].answer_confidence = 0
  assert.equal(decodeLayaResult(high.result, batch, settings).answers[0]?.status, 'selected')
  const low = rawReply()
  Object.assign(low.result.answers['task-type'], { choice: 'research', probabilities: { debug: .05, research: .9, writing: .02, chat: .02, abstain: .01 }, confidence: 1, answer_confidence: 1 })
  assert.deepEqual(decodeLayaResult(low.result, batch, settings).answers, [{ id: 'task-type', status: 'abstained', reason: 'uncertain' }])
  const margin = rawReply()
  Object.assign(margin.result.answers['task-type'], { probabilities: { debug: 0, research: .6, writing: 0, chat: .4, abstain: 0 }, answer_confidence: 1 })
  assert.deepEqual(decodeLayaResult(margin.result, batch, { ...settings, acceptance: { minProbability: .5, minMargin: .2 } }).answers,
    [{ id: 'task-type', status: 'abstained', reason: 'uncertain' }])
})

test('shared strict decoder normalizes known telemetry without relaxing runtime identity or token limits', async () => {
  const provider = new LayaCoreMLDecisionProvider(layaConfig()['laya-coreml'], async (_path, body) =>
    JSON.parse(body).op === 'health' ? layaReply({ op: 'health' }) : { ...rawReply(), runtime: layaRuntime })
  assert.deepEqual((await provider.evaluate(batch, signal())).usage, { input_tokens: 74, output_tokens: 0 })
  for (const mutate of [
    (reply: any) => { reply.runtime = { ...reply.runtime, runtimeFingerprint: `sha256:${'b'.repeat(64)}` } },
    (reply: any) => { reply.result.usage.input_tokens = 97 },
  ]) {
    const invalid = new LayaCoreMLDecisionProvider(layaConfig()['laya-coreml'], async (_path, body) => {
      if (JSON.parse(body).op === 'health') return layaReply({ op: 'health' })
      const reply = { ...rawReply(), runtime: layaRuntime }; mutate(reply); return reply
    })
    await assert.rejects(invalid.evaluate(batch, signal()), (error: any) => ['DECISION_UNSUPPORTED', 'DECISION_MALFORMED_RESPONSE'].includes(error.code))
  }
})

test('known telemetry cannot hide a malformed or truncated result', async t => {
  const cases: Array<[string, (reply: any) => void]> = [
    ['missing choice', r => { delete r.result.answers['task-type'].choice }],
    ['unknown choice', r => { r.result.answers['task-type'].choice = 'other' }],
    ['non-top choice', r => { r.result.answers['task-type'].choice = 'chat' }],
    ['missing probabilities', r => { delete r.result.answers['task-type'].probabilities }],
    ['missing probability', r => { delete r.result.answers['task-type'].probabilities.chat }],
    ['unknown probability', r => { r.result.answers['task-type'].probabilities.other = 0 }],
    ['probability range', r => { r.result.answers['task-type'].probabilities.chat = -1 }],
    ['probability sum', r => { r.result.answers['task-type'].probabilities.research = .5 }],
    ['non-finite probability', r => { r.result.answers['task-type'].probabilities.research = NaN }],
    ['missing confidence', r => { delete r.result.answers['task-type'].confidence }],
    ['confidence range', r => { r.result.answers['task-type'].confidence = 1.1 }],
    ['missing action', r => { delete r.result.answers['task-type'].action }],
    ['action range', r => { r.result.answers['task-type'].action.act_probability = -1 }],
    ['missing answer', r => { delete r.result.answers['task-type'] }],
    ['extra answer', r => { r.result.answers.extra = r.result.answers['task-type'] }],
    ['wrong model', r => { r.result.model = 'other' }],
    ['wrong answer type', r => { r.result.answers['task-type'].type = 'noul' }],
    ['zero input', r => { r.result.usage.input_tokens = 0 }],
    ['fractional input', r => { r.result.usage.input_tokens = 1.5 }],
    ['nonzero output', r => { r.result.usage.output_tokens = 1 }],
    ['missing usage', r => { delete r.result.usage }],
    ['unknown result field', r => { r.result.extra = true }],
    ['unknown answer field', r => { r.result.answers['task-type'].extra = true }],
    ['unknown action field', r => { r.result.answers['task-type'].action.extra = true }],
    ['unknown usage field', r => { r.result.usage.extra = true }],
    ['collapsed options telemetry', r => { r.result.usage.options = {} }],
    ['answer confidence range', r => { r.result.answers['task-type'].answer_confidence = 1.1 }],
    ['answer confidence non-finite', r => { r.result.answers['task-type'].answer_confidence = Infinity }],
    ['answer confidence type', r => { r.result.answers['task-type'].answer_confidence = '0.9' }],
    ['negative state tokens', r => { r.result.usage.state_tokens = -1 }],
    ['fractional state tokens', r => { r.result.usage.state_tokens = 1.5 }],
    ['non-finite state tokens', r => { r.result.usage.state_tokens = Infinity }],
    ['negative dropped tokens', r => { r.result.usage.state_tokens_dropped = -1 }],
    ['fractional dropped tokens', r => { r.result.usage.state_tokens_dropped = .5 }],
    ['dropped tokens', r => { r.result.usage.state_tokens_dropped = 1 }],
    ['truncated flag', r => { r.result.usage.truncated = true }],
    ['truncated type', r => { r.result.usage.truncated = 'false' }],
    ['truncated question', r => { r.result.usage.truncated_questions = ['task-type'] }],
    ['truncated questions type', r => { r.result.usage.truncated_questions = false }],
    ['truncated question type', r => { r.result.usage.truncated_questions = [1] }],
    ['null telemetry', r => { r.result.usage.state_tokens = null }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const reply = rawReply(); mutate(reply)
    const diagnostics: ChoiceDiagnostic[] = []
    assert.throws(() => decodeLayaResult(reply.result, batch, settings, diagnostic => { diagnostics.push(diagnostic) }), { code: 'DECISION_MALFORMED_RESPONSE' })
    assert.deepEqual(diagnostics, [])
  })
})

test('v1 retains version, success and server timing validation with telemetry present', async t => {
  const cases: Array<[string, (reply: any) => void]> = [
    ['wrong version', r => { r.version = 2 }],
    ['missing version', r => { delete r.version }],
    ['not successful', r => { r.ok = false }],
    ['wrong success type', r => { r.ok = 'true' }],
    ['missing result', r => { delete r.result }],
    ['negative timing', r => { r.server.predict_ms = -1 }],
    ['non-finite timing', r => { r.server.predict_ms = Infinity }],
  ]
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const provider = new LayaV1DecisionProvider(settings, async (_path, body) => {
      if (JSON.parse(body).op === 'health') return { version: 1, ok: true, status: 'ready' }
      const reply = rawReply(); mutate(reply); return reply
    })
    await assert.rejects(provider.evaluate(batch, signal()), { code: 'DECISION_MALFORMED_RESPONSE' })
  })
})
