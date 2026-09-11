import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_ROLES, MODEL_TEMPLATES, ROLE_LABELS, ModelBindingSchema, configurationProblems, readModelCatalog, templateBindings, type ModelConfiguration, type ModelRoute } from '../../../src/dsh/model-configuration.js'
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

async function selectWithAnswers(initial: StoredExecutionSelection, steps: readonly (readonly [string, string])[]) {
  let stored = initial
  const seen: string[] = []
  const saved: StoredExecutionSelection[] = []
  const result = await selectExecution({ task: 'Fix model selection', signal, routes, stored, llm,
    save: async (revision, value) => {
      assert.equal(revision, stored.revision)
      stored = { revision: revision + 1, value }
      saved.push(stored)
      return stored
    },
    questions: { ask: async request => {
      const question = request.questions[0]
      const step = steps[seen.length]
      seen.push(question.id)
      return { answers: [{ id: question.id, selected: [step?.[0] === question.id ? step[1] : '取消・作業を保持'] }] }
    } },
  }).catch(error => {
    if (!(error instanceof ExecutionSelectionPending)) throw error
    return undefined
  })
  // Assert outside ask: native question errors intentionally become cancellation.
  assert.deepEqual(seen, steps.map(([id]) => id))
  return { stored, result, saved }
}

test('custom configuration chooses the provider once and only models for subsequent roles', async () => {
  const { result } = await selectWithAnswers({ revision: 0, value: { mode: 'enno', status: 'selecting' } }, [
    ['enno-model-source', 'DSHに設定済みのモデルから選ぶ'],
    ['enno-model-review', 'enno-idealを変更'],
    ['enno-provider-ideal', 'Same name [oauth-two]'],
    ['enno-model-ideal', 'Same model [gpt-6-astra]'],
    ...MODEL_ROLES.filter(role => role !== 'ideal').flatMap(role => [
      ['enno-model-review', `${ROLE_LABELS[role]}を変更`] as const,
      [`enno-model-${role}`, 'Same model [gpt-5.6-luna]'] as const,
    ]),
    ['enno-model-review', 'この構成で開始'],
  ])
  assert.equal(result?.value.status, 'ready')
  for (const role of MODEL_ROLES) assert.deepEqual(result?.value.configuration?.roles[role], {
    provider: 'oauth-two', model: role === 'ideal' ? 'gpt-6-astra' : 'gpt-5.6-luna',
  })
})

test('editing uses the role connection, supports explicit connection changes and preserves drafts on back and cancel', async () => {
  const initial: StoredExecutionSelection = { revision: 3, value: { mode: 'enno', status: 'selecting', draft: {
    roles: { ideal: { provider: 'api-one', model: 'gpt-6-astra' }, zenki: { provider: 'oauth-two', model: 'gpt-5.6-sol' } },
    custom: true, maxConcurrentChildren: 4,
  } } }
  const { stored, saved } = await selectWithAnswers(initial, [
    ['enno-model-review', '前鬼 (Zenki)を変更'],
    ['enno-model-zenki', 'Same model [gpt-5.6-luna]'],
    ['enno-model-review', '前鬼 (Zenki)を変更'],
    ['enno-model-zenki', '接続を変更'],
    ['enno-provider-zenki', 'Same name [api-one]'],
    ['enno-model-zenki', 'Same model [gpt-5.6-sol]'],
    ['enno-model-review', '前鬼 (Zenki)を変更'],
    ['enno-model-zenki', '戻る'],
    ['enno-model-review', '後鬼 (Goki) ヘッドを変更'],
    ['enno-model-goki', '取消・作業を保持'],
  ])
  assert.deepEqual(saved[0]?.value.draft?.roles.zenki, { provider: 'oauth-two', model: 'gpt-5.6-luna' })
  assert.deepEqual(stored.value.draft?.roles, { ...initial.value.draft!.roles, zenki: { provider: 'api-one', model: 'gpt-5.6-sol' } })
  assert.equal(stored.revision, 5)
  assert.equal(initial.value.draft?.roles.zenki?.provider, 'oauth-two')
})

test('a removed role connection opens provider selection without silently adopting enno-ideal', async () => {
  const initial: StoredExecutionSelection = { revision: 1, value: { mode: 'enno', status: 'reselect', draft: {
    roles: { ideal: { provider: 'api-one', model: 'gpt-6-astra' }, zenki: { provider: 'removed', model: 'old-model' } },
    custom: true, maxConcurrentChildren: 4,
  } } }
  const { stored, saved } = await selectWithAnswers(initial, [
    ['enno-model-review', '前鬼 (Zenki)を変更'],
    ['enno-provider-zenki', 'Same name [oauth-two]'],
    ['enno-model-zenki', '戻る'],
    ['enno-provider-zenki', '戻る'],
    ['enno-model-review', '取消・作業を保持'],
  ])
  assert.equal(saved.length, 0)
  assert.deepEqual(stored, initial)
})
test('twelve versioned templates cover seven families with exact IDs and conservative local concurrency', () => {
  assert.equal(MODEL_TEMPLATES.length, 12)
  assert.equal(new Set(MODEL_TEMPLATES.map(t => t.group)).size, 7)
  for (const t of MODEL_TEMPLATES) { assert.equal(t.version, 1); assert.deepEqual(Object.keys(t.models), [...MODEL_ROLES]) }
  const local = MODEL_TEMPLATES.at(-1)!
  assert.equal(local.maxConcurrentChildren, 1)
  assert.equal(new Set(Object.values(local.models).flat()).size, 1)
  assert.deepEqual(templateBindings(MODEL_TEMPLATES[0]!, 'not-configured', catalog), {})
  assert.deepEqual(templateBindings(MODEL_TEMPLATES[0]!, 'api-one', { ...catalog, models: [{ provider: 'api-one', id: 'gpt-6-astra-similar', name: 'gpt-6-astra' }] }), {})
  assert.equal(ModelBindingSchema.safeParse({ provider: 'api-one', model: ' gpt-6-astra' }).success, false)
})
test('DeepSeek recommendations bind every role to the provider-specific V4.1 Flash ID without legacy substitution', () => {
  const recommendations = [
    ['deepseek-flash', 'deepseek-flash'],
    ['go-deepseek-flash', 'deepseek-v4.1-flash'],
    ['router-deepseek-flash', 'deepseek/deepseek-v4.1-flash'],
    ['orca-deepseek-flash', 'deepseek/deepseek-v4.1-flash'],
  ] as const
  for (const [templateId, model] of recommendations) {
    const t = MODEL_TEMPLATES.find(t => t.id === templateId)!
    const provider = t.route?.provider ?? `configured-${templateId}`
    const models = [{ provider, id: model, name: 'DeepSeek V4.1 Flash' }]
    const available = { providers: [{ id: provider, name: t.group }], models, failures: [] }
    for (const role of MODEL_ROLES) {
      assert.deepEqual(t.models[role], [model])
      assert.deepEqual(templateBindings(t, provider, available)[role], { provider, model })
    }
    const legacy = ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek/deepseek-v4-pro'].map(id => ({ provider, id, name: 'DeepSeek V4.1 Flash' }))
    assert.deepEqual(templateBindings(t, provider, { ...available, models: legacy }), {})
    assert.deepEqual(templateBindings(t, provider, { ...available, models: models.map(m => ({ ...m, provider: 'another-route' })) }), {})
  }
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
        assert.equal(q.options.filter((o: any) => /接続未設定/u.test(o.label)).length, MODEL_TEMPLATES.length - 1)
        selected = q.options[0].label
      } else if (q.id === 'enno-template-provider') { assert.match(q.options[1].label, /oauth-two/u); selected = q.options[1].label }
      else if (q.id === 'enno-model-review') selected = reviewCount++ === 0 ? '後鬼 (Goki) ヘッドを変更' : '取消・作業を保持'
      else if (q.id === 'enno-model-goki') selected = 'enno-idealからコピー'
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
