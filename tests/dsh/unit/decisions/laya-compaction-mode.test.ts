import assert from 'node:assert/strict'
import test from 'node:test'
import { TypedDecisionsConfig, layaCompactionStatus } from '../../../../src/dsh/decisions/config.js'
import { DecisionService, type DecisionStore } from '../../../../src/dsh/decisions/service.js'
import { DecisionError } from '../../../../src/dsh/decisions/contracts.js'
import { compactionBatch, selectCandidates } from '../../../../src/dsh/semantic-compaction/policy.js'
import { fixture } from '../../helpers/semantic-compaction.js'

const signal = () => new AbortController().signal
export function config(mode?: 'off' | 'shadow' | 'auto') {
  return TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { model: 'aac6fef/laya-multilingual-coreml',
    runtimeFingerprint: `sha256:${'a'.repeat(64)}`, ...(mode ? { compaction: { mode } } : {}) } })
}
for (const mode of [undefined, 'off', 'shadow', 'auto'] as const) test(`coordinator Laya ${mode ?? 'default'} never appends and reports its separate policy`, async () => {
  const f = fixture({ decisionConfig: config(mode), preflight: async () => {}, evaluate: async batch => ({ provider: 'laya-coreml', requestedModel: 'fixture', policyVersion: 'fixture',
    answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : 'lossless' })) }) })
  const before = structuredClone(f.events)
  try {
    await f.step()
    assert.deepEqual(f.events, before)
    const status = f.service.status() as any
    assert.equal(status.semanticCompaction.active, false)
    assert.equal(status.semanticCompaction.last.reason, mode === 'shadow' ? 'shadow_no_commit' : mode === 'auto' ? 'experimental_not_qualified' : 'laya_compaction_off')
    assert.equal(f.calls.filter(batch => batch.purpose === 'compaction').length, mode === 'shadow' ? 1 : 0)
  } finally { f.coordinator.stop(); await f.coordinator.drain() }
})

test('default/off/unqualified auto reject before cached results, preflight or provider access', async () => {
  for (const mode of [undefined, 'off', 'auto'] as const) {
    let reads = 0, providerCalls = 0
    const store: DecisionStore = { bind: async (_id, value) => value, read: async () => { reads++; throw new Error('old accepted cache must not be read') }, write: async () => {} }
    const service = new DecisionService(config(mode), () => { providerCalls++; throw new Error('must not construct provider') }, store)
    const f = fixture()
    try {
      const candidates = selectCandidates(f.events, f.meter, new Map(), undefined, 'laya-coreml')
      const batch = compactionBatch(f.events, [], candidates, undefined, 'laya-coreml')
      for (const purpose of ['compaction', 'model-handoff'] as const) {
        assert.deepEqual(await service.evaluate(purpose, { ...batch, purpose }, signal()), { status: 'fallback', reason: mode === 'auto' ? 'experimental_not_qualified' : 'laya_compaction_off' })
      }
      assert.equal(reads, 0); assert.equal(providerCalls, 0)
    } finally { f.coordinator.stop(); await f.coordinator.drain() }
  }
})

test('shadow preflights all complete candidate inputs before prediction and binds task/source cache identity', async () => {
  const f = fixture(), calls: string[] = []
  let reject = false
  const service = new DecisionService(config('shadow'), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144, maxPromptTokens: 1024 },
    preflight: async part => { calls.push(`preflight:${part.questions[0]!.id}`); if (reject && part.questions[0]!.id === 'second') throw new DecisionError('TOO_LARGE') },
    evaluate: async part => { calls.push(`predict:${part.purpose}:${part.questions[0]!.id}`); return { provider: 'laya-coreml', requestedModel: 'fixture', policyVersion: 'fixture',
      answers: part.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : 'lossless' })) } } }), undefined, { configurationCheck: async () => true })
  try {
    const one = compactionBatch(f.events, [], selectCandidates(f.events, f.meter, new Map(), undefined, 'laya-coreml'), undefined, 'laya-coreml')
    const two = structuredClone(one); (two.state as any).results.push({ ...(two.state as any).results[0], id: 'second' }); two.questions.push({ ...two.questions[0]!, id: 'second' })
    reject = true
    assert.deepEqual(await service.evaluate('overflow', two, signal()), { status: 'fallback', reason: 'DECISION_TOO_LARGE' })
    assert.equal(calls.filter(call => call.startsWith('predict:compaction')).length, 0)
    reject = false; calls.length = 0
    assert.equal((await service.evaluate('same', one, signal())).status, 'completed')
    const count = calls.length
    assert.equal((await service.evaluate('same', one, signal())).status, 'completed'); assert.equal(calls.length, count)
    const changed = structuredClone(one); (changed.state as any).task.currentRequest += ' New requirement.'
    assert.equal((await service.evaluate('same', changed, signal())).status, 'completed'); assert.ok(calls.length > count)
    const source = structuredClone(one); (source.state as any).results[0].sourceDigest = 'changed-source'
    const before = calls.length; await service.evaluate('same', source, signal()); assert.ok(calls.length > before)
  } finally { f.coordinator.stop(); await f.coordinator.drain() }
})

test('Laya compaction schema cannot accept stale policy or user qualification and preserves other provider defaults', () => {
  const legacy = TypedDecisionsConfig.parse({})
  assert.equal(legacy.provider, 'typesafe'); assert.equal(legacy['laya-coreml'], undefined)
  assert.equal(layaCompactionStatus(config()).mode, 'off')
  for (const compaction of [{ mode: 'auto', qualified: true }, { mode: 'shadow', policyVersion: 'laya-lossless-results-v2' }])
    assert.equal(TypedDecisionsConfig.safeParse({ provider: 'laya-coreml', 'laya-coreml': { compaction } }).success, false)
  const v1 = config('shadow'); v1['laya-coreml']!.protocol = 'v1'; v1['laya-coreml']!.model = 'laya-rl-agent'; delete v1['laya-coreml']!.runtimeFingerprint
  const service = new DecisionService(v1, () => { throw new Error('legacy v1 compaction must not infer') })
  return service.evaluate('v1', { purpose: 'compaction', state: {}, questions: [{ id: 'x', instructions: 'Choose', choices: [{ id: 'keep', description: '' }, { id: 'abstain', description: '' }], abstainId: 'abstain' }] }, signal())
    .then(outcome => assert.deepEqual(outcome, { status: 'fallback', reason: 'laya_compaction_strict_runtime_required' }))
})
