import assert from 'node:assert/strict'
import test from 'node:test'
import { HeadWorkerConfigurationSchema, headWorkerCandidates, validateHeadWorker, headWorkerEnnoConfiguration } from '../../../src/dsh/head-worker-configuration.js'
import type { ModelCatalogSnapshot, DshModelCatalog } from '../../../src/dsh/model-configuration.js'
const catalog: ModelCatalogSnapshot = {
  providers: [
    { id: 'sol', name: 'Head', route: { provider: 'sol', family: 'openai', connection: 'codex', protocol: 'responses' } },
    { id: 'flash', name: 'Worker', route: { provider: 'flash', family: 'deepseek', connection: 'api', protocol: 'chat-completions' } },
    { id: 'zen', name: 'Zen', route: { provider: 'zen', family: 'opencode-zen', connection: 'api', protocol: 'chat-completions' } },
  ], models: [
    { provider: 'sol', id: 'gpt-6.1-sol', name: 'Sol' }, { provider: 'flash', id: 'deepseek-flash', name: 'Flash' },
    { provider: 'zen', id: 'gpt-6.1-sol', name: 'Sol' }, { provider: 'zen', id: 'deepseek-v4.1-flash', name: 'Flash' },
    { provider: 'flash', id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash' },
  ], failures: [], resolveCallConfig: async binding => binding,
}
const pair = { preset: 'gpt-6.1-sol-deepseek-v4.1-flash' as const, head: { provider: 'sol', model: 'gpt-6.1-sol' }, worker: { provider: 'flash', model: 'deepseek-flash' } }
const llm: DshModelCatalog = { listProviders: () => catalog.providers, listModels: async provider => catalog.models.filter(m => m.provider === provider), resolveCallConfig: async binding => binding }
test('pair validation never lists an unselected provider', async () => {
  const called: string[] = []
  const scoped = { ...llm, listModels: async (provider: string) => {
    called.push(provider)
    assert.notEqual(provider, 'zen', 'unselected authentication must remain untouched')
    return catalog.models.filter(m => m.provider === provider)
  } }
  assert.deepEqual(await validateHeadWorker(pair, scoped, []), [])
  assert.deepEqual(called.sort(), ['flash', 'sol'])
})
test('pair discovers exact available routes, including mixed providers, never display-name aliases', async () => {
  const result = await headWorkerCandidates(catalog, [])
  assert.deepEqual(result.heads, [pair.head, { provider: 'zen', model: 'gpt-6.1-sol' }])
  assert.deepEqual(result.workers, [pair.worker, { provider: 'zen', model: 'deepseek-v4.1-flash' }])
  assert.deepEqual(result.problems, [])
  assert.deepEqual(await validateHeadWorker(pair, llm, []), [])
})
test('pair schema and validation reject fallback models, unknown routes and unavailable bindings', async () => {
  assert.equal(HeadWorkerConfigurationSchema.safeParse({ ...pair, head: { ...pair.head, model: 'gpt-6-sol' } }).success, false)
  assert.equal(HeadWorkerConfigurationSchema.safeParse({ ...pair, worker: { ...pair.worker, model: 'deepseek-v4-flash' } }).success, false)
  const missing = await headWorkerCandidates({ ...catalog, models: [], failures: ['flash'] }, [])
  assert.equal(missing.heads.length, 0); assert.equal(missing.workers.length, 0); assert.ok(missing.problems.length >= 2)
  assert.ok((await validateHeadWorker(pair, { ...llm, resolveCallConfig: async b => ({ ...b, model: 'fallback' }) }, [])).length)
  assert.ok((await validateHeadWorker({ ...pair, worker: { provider: 'sol', model: 'deepseek-flash' } }, llm, [])).length)
})
test('Enno maps all parent roles to head and only delegated worker to Flash', () => {
  const config = headWorkerEnnoConfiguration(pair)
  for (const role of ['ideal', 'zenki', 'goki', 'check'] as const) assert.deepEqual(config.roles[role], pair.head)
  assert.deepEqual(config.roles.worker, pair.worker)
  assert.equal(config.custom, false)
  assert.equal(config.maxConcurrentChildren, 4)
})
test('provider-specific IDs cannot migrate across a different route family', async () => {
  const wrong = { ...catalog, models: [...catalog.models, { provider: 'sol', id: 'deepseek-flash', name: 'Flash' }] }
  const candidates = await headWorkerCandidates(wrong, [])
  assert.ok(!candidates.workers.some(b => b.provider === 'sol'))
})
test('unknown connection metadata cannot silently turn a Flash-shaped ID into the worker route', async () => {
  const unknown = { ...catalog, providers: catalog.providers.map(p => ({ id:p.id,name:p.name })) }
  assert.equal((await headWorkerCandidates(unknown, [])).workers.length, 0)
})
test('pair diagnostics never copy provider exception bodies into the settings response', async () => {
  const failures = await validateHeadWorker(pair, { ...llm, resolveCallConfig: async () => { throw new Error('private-provider-response-secret') } })
  assert.ok(failures.length)
  assert.ok(failures.every(problem => !problem.includes('private-provider-response-secret')))
})
