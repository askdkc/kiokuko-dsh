import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { ModelAutoCoordinator } from '../../../src/dsh/model-auto/coordinator.js'
import { ModelAutoStore } from '../../../src/dsh/model-auto/store.js'
import { modelAutoCandidates } from '../../../src/dsh/model-auto/candidates.js'
import { ModelAutoConfig } from '../../../src/dsh/model-auto/contracts.js'
import type { DecisionBatch } from '../../../src/dsh/decisions/contracts.js'
import type { DshModelCatalog, ModelBinding } from '../../../src/dsh/model-configuration.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'

const signal = new AbortController().signal
const luna = (effort: string): ModelBinding => ({ provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: effort })
const catalog = (): DshModelCatalog => ({
  listProviders: () => [{ id: 'openai-codex', name: 'Codex' }],
  listModels: async provider => ['gpt-6-luna', 'gpt-6-sol'].map(id => ({ provider, id, name: id })),
  resolveModelInfo: async (provider, id) => ({ provider, id, name: id, inputModalities: ['text', 'image'],
    context: { contextWindow: 200_000 }, reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id })) } }),
  resolveCallConfig: async binding => binding,
})
async function fixture(choice = 'luna-medium', mode: 'off' | 'observe' | 'auto' = 'auto') {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec("CREATE TABLE ledger_runs(run_id TEXT PRIMARY KEY); INSERT INTO ledger_runs(run_id) VALUES ('r1'),('r2'),('r3')")
  db.exec(readFileSync(new URL('../../../migrations/028_model_auto.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async <T>(fn: (database: NodeSqliteAdapter) => T) => fn(db) }
  let calls = 0, decide: ((batch: DecisionBatch) => Promise<string>) | undefined
  const service = new DecisionService(TypedDecisionsConfig.parse({}), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 },
    evaluate: async batch => {
      calls++
      const selected = batch.purpose === 'memory-reuse' ? 'apple' : decide ? await decide(batch) : choice
      return { provider: 'typesafe', requestedModel: 'jev-latest', policyVersion: 'fixture',
        answers: batch.questions.map(question => ({ id: question.id, status: 'selected' as const, choiceId: selected })) }
    },
  }))
  const config = ModelAutoConfig.parse({ mode })
  const store = new ModelAutoStore(runtime, config.mode, canonicalContentHash(config))
  const coordinator = new ModelAutoCoordinator(store, service, catalog(), config)
  const input = (runId = 'r1', turn = 1) => ({ runId, sessionId: 's1', requestId: `request-${turn}`, turn,
    task: 'Implement a small TypeScript change and verify it.', taskType: 'build', admitted: true, measureContext: () => 0, signal })
  return { db, runtime, store, coordinator, input, calls: () => calls, setDecision: (fn: (batch: DecisionBatch) => Promise<string>) => { decide = fn }, close: () => db.close() }
}

test('off makes no decision or catalog call; auto freezes one route across replay and records actual header separately', async t => {
  const f = await fixture('luna-medium', 'off'); t.after(f.close)
  assert.deepEqual(await f.coordinator.resolve(f.input()), { kind: 'native', reason: 'mode_off' })
  assert.equal(f.calls(), 0)
  await f.coordinator.setMode('s1', 'auto')
  assert.deepEqual(await f.coordinator.resolve(f.input()), { kind: 'apply', binding: luna('medium'), reason: 'selected' })
  const calls = f.calls()
  assert.deepEqual(await f.coordinator.resolve(f.input()), { kind: 'apply', binding: luna('medium'), reason: 'selected' })
  assert.equal(f.calls(), calls)
  await f.coordinator.requestHeader('s1', 'r1', luna('medium'))
  assert.equal(((await f.coordinator.status('s1')).last as { matched: boolean }).matched, true)
  await f.coordinator.manual('s1', 10, { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'high' })
  assert.deepEqual(await f.coordinator.resolve(f.input('r2', 2)), { kind: 'native', reason: 'manual_pin' })
  assert.equal(f.calls(), calls)
  await f.coordinator.setMode('s1', 'auto')
  assert.deepEqual(await f.coordinator.resolve(f.input('r2', 2)), { kind: 'apply', binding: luna('medium'), reason: 'selected' })
  await f.coordinator.setMode('s1', 'off')
  assert.deepEqual(await f.coordinator.resolve(f.input('r3', 3)), { kind: 'native', reason: 'mode_off' })
})

test('observe records proposal without changing the request; missing adapter metadata leaves native route', async t => {
  const f = await fixture('sol-high', 'observe'); t.after(f.close)
  assert.deepEqual(await f.coordinator.resolve(f.input()), { kind: 'native', reason: 'observed' })
  assert.equal((await f.store.route('r1'))?.binding, null)
  const unsupported = await modelAutoCandidates({ listProviders: catalog().listProviders, listModels: catalog().listModels }, ModelAutoConfig.parse({ mode: 'auto' }), [], signal, 0)
  assert.equal(unsupported.reason, 'candidate_unavailable')
})

test('manual selection invalidates a late classifier result and restart does not resend an unknown decision', async t => {
  const f = await fixture(); t.after(f.close)
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  f.setDecision(async () => { await wait; return 'luna-low' })
  const pending = f.coordinator.resolve(f.input())
  while (f.calls() < 2) await new Promise(resolve => setImmediate(resolve))
  await f.coordinator.manual('s1', 1, luna('high'))
  const revision = (await f.store.session('s1')).revision
  await f.coordinator.manual('s1', 1, luna('low'))
  assert.equal((await f.store.session('s1')).revision, revision)
  assert.deepEqual((await f.store.session('s1')).pin, luna('high'))
  release()
  assert.deepEqual(await pending, { kind: 'native', reason: 'session_changed' })
  assert.equal((await f.store.route('r1'))?.status, 'cancelled')
  await f.store.claim({ runId: 'r2', sessionId: 's1', requestId: 'request-2', turn: 2,
    inputDigest: 'pending', configDigest: 'config', catalogDigest: 'catalog', sessionRevision: (await f.store.session('s1')).revision, policy: 'codex-luna-sol-v1' })
  assert.equal((await f.store.recover('r2'))?.reason, 'restart_no_retry')
})

test('catalog rejects unsupported effort and retains only exact validated bindings', async () => {
  const base = catalog()
  const candidates = await modelAutoCandidates({ ...base, resolveCallConfig: async binding => {
    if (binding.reasoningEffort === 'medium') throw new Error('unsupported')
    return binding
  } }, ModelAutoConfig.parse({ mode: 'auto' }), [], signal, 0)
  assert.deepEqual(candidates.routes.map(route => route.id), ['luna-low', 'luna-high', 'sol-high'])
})

test('configuration change resets persisted session mode so off plus restart disables routing', async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal((await f.store.session('s1')).mode, 'auto')
  const disabled = ModelAutoConfig.parse({ mode: 'off' })
  const restarted = new ModelAutoStore(f.runtime, disabled.mode, canonicalContentHash(disabled))
  assert.equal((await restarted.session('s1')).mode, 'off')
})
