import assert from 'node:assert/strict'
import test from 'node:test'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import type { DecisionProvider } from '../../../../src/dsh/decisions/contracts.js'
import { layaConfig } from '../../helpers/laya.js'
const signal = () => new AbortController().signal
const backend: DecisionProvider = { capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 }, evaluate: async batch => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: 'apple' })) }) }

test('cancelled discovery cannot change selection later; overlapping commands fail and an explicit retry works', async () => {
  let complete!: (value: ReturnType<typeof layaConfig>) => void, saves = 0, calls = 0
  const pending = new Promise<ReturnType<typeof layaConfig>>(resolve => { complete = resolve })
  const service = new DecisionService(TypedDecisionsConfig.parse({}), () => backend, undefined, {
    resolveConfiguration: async () => ++calls === 1 ? pending : layaConfig(),
    selectionStore: { load: async () => undefined, save: async (_config, revision) => { saves++; return revision + 1 } },
  })
  const controller = new AbortController(), operation = service.selectProvider('laya-coreml', controller.signal)
  await assert.rejects(service.selectProvider('typesafe', signal()), { code: 'DECISION_UNAVAILABLE' })
  const rejected = assert.rejects(operation, { code: 'DECISION_CANCELLED' })
  while (!calls) await new Promise(resolve => setImmediate(resolve))
  controller.abort(); await rejected; complete(layaConfig()); await new Promise(resolve => setImmediate(resolve))
  assert.equal((service.status() as any).provider, 'typesafe'); assert.equal(saves, 0)
  await service.selectProvider('laya-coreml', signal()); assert.equal(saves, 1)
})

test('discovery timeout and persistence failure do not report a successful switch', async () => {
  const config = TypedDecisionsConfig.parse({ 'laya-coreml': { timeoutMs: 10 } })
  const service = new DecisionService(config, () => backend, undefined, { resolveConfiguration: async () => new Promise(() => {}) })
  // Keep the test alive while AbortSignal.timeout's unref timer expires.
  const keepAlive = setInterval(() => {}, 100)
  try { await assert.rejects(service.selectProvider('laya-coreml', signal()), { code: 'DECISION_TIMEOUT' }) }
  finally { clearInterval(keepAlive) }
  assert.equal((service.status() as any).provider, 'typesafe')
  const failed = new DecisionService(config, () => backend, undefined, { resolveConfiguration: async () => layaConfig(), selectionStore: {
    load: async () => undefined, save: async () => { throw new Error('storage failure') },
  } })
  await assert.rejects(failed.selectProvider('laya-coreml', signal()), /storage failure/)
  assert.equal((failed.status() as any).provider, 'typesafe')
})

test('a request admitted during discovery keeps its original backend after the command completes', async () => {
  let complete!: (value: ReturnType<typeof layaConfig>) => void
  const service = new DecisionService(TypedDecisionsConfig.parse({}), () => backend, undefined, {
    resolveConfiguration: async () => new Promise(resolve => { complete = resolve }),
  })
  const operation = service.selectProvider('laya-coreml', signal())
  const before = await service.bind('before')
  assert.equal(before.provider, 'typesafe')
  complete(layaConfig()); await operation
  assert.equal((await service.bind('before')).provider, 'typesafe')
  assert.equal((await service.bind('after')).provider, 'laya-coreml')
  before.typesafe.model = 'caller-mutation'
  assert.equal((await service.bind('before')).typesafe.model, 'jev-latest')
})

test('Laya uses the default home socket with no section and respects explicit runtime constraints', async () => {
  const { discoverLayaConfiguration } = await import('../../../../src/dsh/decisions/laya-coreml.js')
  const { homedir } = await import('node:os'), { resolve } = await import('node:path')
  const { layaReply, layaRuntime } = await import('../../helpers/laya.js')
  const input = TypedDecisionsConfig.parse({ provider: 'laya-coreml' })
  const resolved = await discoverLayaConfiguration(input, '/repo', signal(), async (path, body) => {
    assert.equal(path, resolve(homedir(), 'Library/Caches/laya-coreml/worker.sock'))
    assert.deepEqual(JSON.parse(body), { version: 1, op: 'health' })
    return layaReply(JSON.parse(body))
  })
  assert.equal(input['laya-coreml'], undefined)
  assert.equal(resolved['laya-coreml']?.runtimeFingerprint, layaRuntime.runtimeFingerprint)
  const pinned = TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { model: 'aac6fef/laya-multilingual-coreml' } })
  await assert.rejects(discoverLayaConfiguration(pinned, '/repo', signal(), async () => layaReply({ op: 'health' })), { code: 'DECISION_UNSUPPORTED' })
})
