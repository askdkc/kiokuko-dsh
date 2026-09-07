import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_ROLES, MODEL_TEMPLATES, ModelBindingSchema, configurationProblems, readModelCatalog, templateBindings, type ModelConfiguration, type ModelRoute } from '../../../src/dsh/model-configuration.js'
import { explicitExecutionMode, type StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { ExecutionSelectionPending, selectExecution } from '../../../src/dsh/model-selection-ui.js'
import { isModelAvailabilityFailure } from '../../../src/dsh/model-routing.js'

const signal = new AbortController().signal
const catalog = {
  providers: [{ id: 'api-one', name: 'Same name' }, { id: 'oauth-two', name: 'Same name' }],
  models: ['api-one', 'oauth-two'].flatMap(provider => ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'].map(id => ({ provider, id, name: 'Same model' }))), failures: [],
}
const llm = { listProviders: () => catalog.providers, listModels: async (provider: string) => catalog.models.filter(m => m.provider === provider) }
const routes: ModelRoute[] = ['api-one', 'oauth-two'].map(provider => ({ provider, family: 'openai', connection: provider === 'api-one' ? 'api' : 'codex', protocol: 'responses' }))
test('seven versioned templates cover all five families with exact IDs and conservative local concurrency', () => {
  assert.equal(MODEL_TEMPLATES.length, 7)
  assert.equal(new Set(MODEL_TEMPLATES.map(t => t.group)).size, 5)
  for (const t of MODEL_TEMPLATES) { assert.equal(t.version, 1); assert.deepEqual(Object.keys(t.models), [...MODEL_ROLES]) }
  const local = MODEL_TEMPLATES.at(-1)!
  assert.equal(local.maxConcurrentChildren, 1)
  assert.equal(new Set(Object.values(local.models).flat()).size, 1)
  assert.deepEqual(templateBindings(MODEL_TEMPLATES[0]!, 'not-configured', catalog), {})
  assert.deepEqual(templateBindings(MODEL_TEMPLATES[0]!, 'api-one', { ...catalog, models: [{ provider: 'api-one', id: 'gpt-6-astra-similar', name: 'gpt-6-astra' }] }), {})
  assert.equal(ModelBindingSchema.safeParse({ provider: 'api-one', model: ' gpt-6-astra' }).success, false)
})
test('catalog failures are distinct from empty models and duplicate names never collapse route identity', async () => {
  const read = await readModelCatalog(llm)
  assert.equal(read.providers.length, 2)
  assert.equal(read.models.length, 6)
  const broken = await readModelCatalog({ ...llm, listModels: async provider => { if (provider === 'api-one') throw new Error('No connection'); return [] } })
  assert.deepEqual(broken.failures, ['api-one'])
  assert.equal(broken.models.length, 0)
})
test('ordinary execution does not read provider catalogs, and explicit choice is not asked twice', async () => {
  assert.equal(explicitExecutionMode('役小角を使わずREADMEを直して'), 'normal')
  assert.equal(explicitExecutionMode('Use enno-oduno to fix README'), 'enno')
  let stored: StoredExecutionSelection = { revision: 0, value: { mode: 'pending', status: 'selecting' } }
  const selected = await selectExecution({ task: '役小角を使わずREADMEを修正', signal, routes: [], stored,
    questions: { ask: async () => { throw new Error('Must not ask') } },
    llm: { listProviders() { throw new Error('Must not read models') }, listModels: async () => [] },
    save: async (revision, value) => stored = { revision: revision + 1, value },
  })
  assert.deepEqual(selected.value, { mode: 'normal', status: 'ready' })
})
test('native cards show unavailable templates, resolve ambiguous providers, preserve custom template provenance and cancel drafts', async () => {
  let stored: StoredExecutionSelection = { revision: 0, value: { mode: 'pending', status: 'selecting' } }
  const ids: string[] = []
  let reviewCount = 0
  const input = { task: 'use enno-oduno to fix README', signal, routes, stored, llm,
    save: async (revision: number, value: StoredExecutionSelection['value']) => { assert.equal(revision, stored.revision); return stored = { revision: revision + 1, value } },
    questions: { ask: async (request: any) => {
      const q = request.questions[0]; ids.push(q.id)
      let selected = ''
      if (q.id === 'enno-model-source') selected = 'おすすめテンプレートから選ぶ'
      else if (q.id === 'enno-template') {
        assert.equal(q.options.filter((o: any) => /接続未設定/u.test(o.label)).length, 6)
        selected = q.options[0].label
      } else if (q.id === 'enno-template-provider') { assert.match(q.options[1].label, /oauth-two.*codex/u); selected = q.options[1].label }
      else if (q.id === 'enno-model-review') selected = reviewCount++ === 0 ? '後鬼 (Goki) ヘッドを変更' : '取消・作業を保持'
      else if (q.id === 'enno-provider-goki') selected = 'enno-idealからコピー'
      return { answers: [{ id: q.id, selected: [selected] }] } as any
    } },
  }
  await assert.rejects(selectExecution(input), ExecutionSelectionPending)
  assert.ok(!ids.includes('enno-execution-mode'))
  assert.equal(stored.value.draft?.custom, true)
  assert.deepEqual(stored.value.draft?.template, { id: 'openai', version: 1 })
  assert.equal(stored.value.draft?.roles.goki?.provider, 'oauth-two')
  assert.equal(stored.value.draft?.roles.goki?.model, 'gpt-6-astra')
  const resumed = await selectExecution({ ...input, stored, questions: { ask: async request => ({ answers: [{ id: request.questions[0].id, selected: ['この構成で開始'] }] }) } })
  assert.equal(resumed.value.status, 'ready')
  assert.equal(resumed.value.configuration?.custom, true)
})
test('Astra transport and Go session compatibility cannot be bypassed by custom assignments', async () => {
  const configuration: ModelConfiguration = { roles: templateBindings(MODEL_TEMPLATES[0]!, 'api-one', catalog) as ModelConfiguration['roles'], custom: true, maxConcurrentChildren: 4 }
  assert.deepEqual(await configurationProblems(configuration, catalog, routes), [])
  assert.ok((await configurationProblems(configuration, catalog, routes.map(r => ({ ...r, protocol: 'chat-completions' })))).some(p => p.includes('Responses')))
  const go = routes.map(r => ({ ...r, family: 'opencode-go' as const }))
  assert.ok((await configurationProblems(configuration, catalog, go)).some(p => p.includes('セッション情報')))
  assert.deepEqual(await configurationProblems(configuration, catalog, go, { inspect: async () => ({ protocol: 'responses', goSessionHeaders: true }) }), [])
  assert.equal(isModelAvailabilityFailure({ code: 'MODEL_NOT_FOUND' }), true)
  assert.equal(isModelAvailabilityFailure({ status: 429 }), true)
  assert.equal(isModelAvailabilityFailure(new Error('ordinary verifier failure')), false)
})
