import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeModelCatalog } from '../../../src/dsh/native-model-catalog.js'
import { modelBindingProblems, modelRoutesForCatalog, readModelCatalog, type ModelBinding } from '../../../src/dsh/model-configuration.js'

test('native connection metadata recognizes aliases without reading credentials or guessing a protocol', async () => {
  const profiles = {
    'my-orca': { baseURL: 'https://api.orcarouter.ai/v1', api: 'openai-completions' },
    'my-go': { baseURL: 'https://opencode.ai/zen/go/v1' },
    'my-zen': { baseURL: 'https://opencode.ai/zen/v1', api: 'anthropic-messages' },
    'my-router': { baseURL: 'https://openrouter.ai/api/v1' },
    'my-local': { baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
    'mixed-api': {},
    'openai': { baseURL: 'https://unrecognized.invalid/v1', api: 'openai-completions' },
    'unrelated-path': { baseURL: 'https://opencode.ai/unrelated' },
    'ollama': {},
  }
  for (const profile of Object.values(profiles)) for (const name of ['apiKey', 'credential', 'headers']) {
    Object.defineProperty(profile, name, { enumerable: true, get() { assert.fail(`must not inspect ${name}`) } })
  }
  const llm = {
    listProviders: () => [...Object.keys(profiles), 'deepseek-official', 'custom-plugin'].map(id => ({ id, name: id })),
    listModels: async (provider: string) => [{ provider, id: 'exact-model', name: 'Model' }],
    listConfigurableProviders: () => [
      ...Object.keys(profiles).map(provider => ({ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: provider !== 'ollama' })),
      { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] },
    ],
  }
  const catalog = await readModelCatalog(nativeModelCatalog(llm, { get(namespace) {
    assert.equal(namespace, 'llm-pi-ai'); return { providers: profiles }
  } })!)
  const routes = modelRoutesForCatalog(catalog, [{ provider: 'my-orca', family: 'openai', connection: 'api', protocol: 'responses' }])
  const route = (provider: string) => routes.find(r => r.provider === provider)
  assert.deepEqual(route('my-orca'), { provider: 'my-orca', family: 'orcarouter', connection: 'api', protocol: 'chat-completions' })
  assert.equal(route('my-go')?.family, 'opencode-go'); assert.equal(route('my-go')?.protocol, 'unknown')
  assert.equal(route('my-zen')?.family, 'opencode-zen'); assert.equal(route('my-zen')?.protocol, 'messages')
  assert.equal(route('my-router')?.family, 'openrouter')
  assert.equal(route('my-local')?.connection, 'local'); assert.equal(route('ollama')?.connection, 'local')
  assert.equal(route('mixed-api')?.protocol, 'unknown')
  assert.equal(route('openai')?.family, 'other', 'a declared alias is not classified by its name')
  assert.equal(route('unrelated-path')?.family, 'other')
  assert.equal(route('deepseek-official')?.family, 'deepseek')
  assert.equal(route('custom-plugin'), undefined)
  assert.equal(routes.filter(r => r.provider === 'my-orca').length, 1)
})

test('DSH validation keeps the native service receiver and rejects unavailable or substituted models', async () => {
  let calls = 0, mode = 'valid'
  const binding = { provider: 'orcarouter', model: 'deepseek/deepseek-v4.1-flash' }
  const llm = {
    listProviders() { assert.equal(this, llm); return [{ id: binding.provider, name: 'OrcaRouter' }] },
    async listModels(provider: string) { assert.equal(this, llm); return [{ provider, id: binding.model, name: 'Flash' }] },
    async resolveCallConfig(input: ModelBinding) {
      assert.equal(this, llm); assert.notEqual(input, binding); calls++
      if (mode === 'invalid') throw new Error('Configured model unavailable')
      return mode === 'substitute' ? { ...input, provider: 'openrouter' } : input
    },
  }
  const catalog = await readModelCatalog(nativeModelCatalog(llm)!)
  const roles = ['分解', '解決', '検証', '集約'].map(label => ({ label, binding }))
  assert.deepEqual(await modelBindingProblems(roles, catalog, []), [])
  assert.equal(calls, 1, 'validate a shared binding only once per review')
  for (const [next, message] of [['invalid', 'Configured model unavailable'], ['substitute', 'different provider/model']]) {
    mode = next!
    const problems = await modelBindingProblems(roles, catalog, [])
    assert.equal(problems.length, 4); assert.ok(problems.every(problem => problem.includes(message!)))
  }
  assert.deepEqual(binding, { provider: 'orcarouter', model: 'deepseek/deepseek-v4.1-flash' })
  assert.match((await modelBindingProblems([{ label: '解決', binding: { ...binding, model: 'missing' } }], catalog, []))[0]!, /設定済みモデルがありません/u)
  assert.equal(calls, 3, 'missing catalog models never reach the adapter')
})
