import assert from 'node:assert/strict'
import test from 'node:test'
import { ExecutionSelectionPending, selectExecution } from '../../../src/dsh/model-selection-ui.js'
import type { StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { MODEL_ROLES, MODEL_TEMPLATES, ROLE_LABELS, templateBindings, type DshModelCatalog, type DshModelCompatibility, type ModelConfigurationDraft, type ModelRoute } from '../../../src/dsh/model-configuration.js'
import type { DshUserQuestionRequest } from '../../../src/dsh/user-interaction.js'

type Question = DshUserQuestionRequest['questions'][0]
type Step = readonly [id: string, answer: string | { custom: string } | null, check?: (question: Question) => void]
const codexProvider = { id: 'openai-codex', name: 'OpenAI Codex' }
const modelIds = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna']
const codexCatalog: DshModelCatalog = {
  listProviders: () => [codexProvider],
  listModels: async provider => modelIds.map(id => ({ provider, id, name: id })),
  resolveCallConfig: async binding => ({ ...binding }),
}
const codexRoute: ModelRoute = { provider: 'openai-codex', family: 'openai', connection: 'codex', protocol: 'responses' }
const roleDraft: ModelConfigurationDraft = { roles: { ideal: { provider: 'openai-codex', model: 'gpt-6-astra' } }, custom: true, maxConcurrentChildren: 4 }
const initial = (draft?: ModelConfigurationDraft): StoredExecutionSelection => ({ revision: 0, value: { mode: 'enno', status: 'selecting', ...(draft ? { draft } : {}) } })

async function navigate(steps: readonly Step[], options: { stored?: StoredExecutionSelection; task?: string; llm?: DshModelCatalog; routes?: readonly ModelRoute[]; compatibility?: DshModelCompatibility } = {}) {
  let stored = options.stored ?? initial()
  const seen: string[] = [], checks: Error[] = []
  const saved: StoredExecutionSelection[] = []
  const result = await selectExecution({
    stored, task: options.task ?? 'Fix selection', signal: new AbortController().signal,
    routes: options.routes ?? [codexRoute], llm: options.llm ?? codexCatalog,
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
    save: async (revision, value) => {
      assert.equal(revision, stored.revision)
      stored = { revision: revision + 1, value }; saved.push(stored); return stored
    },
    questions: { ask: async request => {
      const question = request.questions[0], step = steps[seen.length]
      seen.push(question.id)
      if (!step || step[0] !== question.id) return { answers: [{ id: question.id, selected: [] }] }
      try { step[2]?.(question) } catch (error) { checks.push(error as Error) }
      const answer = step[1]
      return { answers: [{ id: question.id, selected: typeof answer === 'string' ? [answer] : [], ...(answer && typeof answer === 'object' ? answer : {}) }] }
    } },
  }).catch(error => { if (!(error instanceof ExecutionSelectionPending)) throw error; return undefined })
  assert.deepEqual(seen, steps.map(step => step[0]))
  if (checks.length) throw checks[0]
  return { stored, saved, result }
}
const hasChoice = (label: string) => (q: Question) => assert.ok(q.options?.some(o => o.label === label), `${q.id}: missing ${label}`)

test('back from explicit Enno source reaches the mode choice instead of reentering source', async () => {
  const { result } = await navigate([
    ['enno-model-source', '戻る'], ['enno-execution-mode', '通常実行'],
  ], { stored: { revision: 0, value: { mode: 'pending', status: 'selecting' } }, task: 'Use enno-oduno to fix selection' })
  assert.equal(result?.value.mode, 'normal')
})

test('invalid fixed choices explain the error without changing screens or choosing a default', async () => {
  await navigate([
    ['enno-model-source', { custom: 'typo' }],
    ['enno-model-source', 'DSHに設定済みのモデルから選ぶ', q => assert.match(q.detail ?? '', /選択肢/u)],
    ['enno-model-review', null],
  ])
})

test('fixed-choice cards still accept a typed option number', async () => {
  const { result } = await navigate([['enno-execution-mode', { custom: '1' }]], {
    stored: { revision: 0, value: { mode: 'pending', status: 'selecting' } },
  })
  assert.deepEqual(result?.value, { mode: 'normal', status: 'ready' })
})

test('numeric free-text remains a model search and empty results can be cleared', async () => {
  const { stored } = await navigate([
    ['enno-model-review', 'enno-idealを変更'],
    ['enno-model-ideal', { custom: '5.6' }],
    ['enno-model-ideal', { custom: 'missing' }, q => assert.equal(q.options?.some(o => o.label.includes('astra')), false)],
    ['enno-model-ideal', '検索をクリア', q => { hasChoice('検索をクリア')(q); assert.match(q.detail ?? '', /該当するモデルがありません/u) }],
    ['enno-model-ideal', { custom: '5' }],
    ['enno-model-ideal', 'gpt-5.6-sol [gpt-5.6-sol]', q => assert.equal(q.options?.some(o => o.label.includes('astra')), false)],
    ['enno-model-review', null],
  ], { stored: initial(roleDraft) })
  assert.equal(stored.value.draft?.roles.ideal?.model, 'gpt-5.6-sol')
})

test('one provider/model selection returns directly to review and survives cancellation', async () => {
  const { stored } = await navigate([
    ['enno-model-source', 'DSHに設定済みのモデルから選ぶ'],
    ['enno-model-review', 'enno-idealを変更'],
    ['enno-provider-ideal', 'OpenAI Codex [openai-codex]'],
    ['enno-model-ideal', 'gpt-6-astra [gpt-6-astra]'],
    ['enno-model-review', null],
  ], { routes: [] })
  assert.deepEqual(stored.value.draft?.roles.ideal, roleDraft.roles.ideal)
})


test('an existing model draft resumes without asking for provider type or protocol', async () => {
  const { stored } = await navigate([
    ['enno-model-review', null, q => assert.equal(q.options?.some(o => o.label === '接続設定を確認'), false)],
  ], { stored: initial(roleDraft), routes: [] })
  assert.deepEqual(stored.value.draft?.roles, roleDraft.roles)
})


test('dsh-codex recommendation binds its exact plugin route and starts without redundant route questions', async () => {
  const { result } = await navigate([
    ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'OpenAI Codex・推奨（dsh-codex） — 適用可能', hasChoice('OpenAI Codex・推奨（dsh-codex） — 適用可能')],
    ['enno-model-review', 'この構成で開始'],
  ], { routes: [] })
  assert.equal(result?.value.status, 'ready')
  assert.deepEqual(result?.value.configuration?.routeBindings, [codexRoute])
  assert.deepEqual(result?.value.configuration?.template, { id: 'openai-codex', version: 1 })
  assert.deepEqual(Object.fromEntries(Object.entries(result!.value.configuration!.roles).map(([role, binding]) => [role, binding.model])), {
    ideal: 'gpt-6-astra', zenki: 'gpt-6-astra', goki: 'gpt-5.6-sol', worker: 'gpt-5.6-luna', check: 'gpt-6-astra',
  })
})

test('native model validation owns transport even when a legacy declaration is stale', async () => {
  const declared = { ...codexRoute, protocol: 'chat-completions' as const }
  const { result } = await navigate([
    ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'OpenAI Codex・推奨（dsh-codex） — 適用可能'],
    ['enno-model-review', 'この構成で開始'],
  ], { routes: [declared] })
  assert.equal(result?.value.status, 'ready')
  assert.equal(declared.protocol, 'chat-completions', 'caller configuration remains untouched')
})


test('model-list failure can be refreshed inside the picker', async () => {
  let reads = 0
  const llm: DshModelCatalog = { ...codexCatalog, listModels: async provider => {
    if (++reads < 2) throw new Error('offline')
    return codexCatalog.listModels(provider)
  } }
  const { stored } = await navigate([
    ['enno-model-review', 'enno-idealを変更'],
    ['enno-model-ideal', '一覧を再取得', hasChoice('一覧を再取得')],
    ['enno-model-ideal', 'gpt-5.6-sol [gpt-5.6-sol]'],
    ['enno-model-review', null],
  ], { stored: initial(roleDraft), llm })
  assert.equal(stored.value.draft?.roles.ideal?.model, 'gpt-5.6-sol')
})

test('provider and model pagination, numeric selections, searches and reset stay on the intended list', async () => {
  const providers = Array.from({ length: 21 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))
  const llm: DshModelCatalog = {
    listProviders: () => providers,
    listModels: async provider => Array.from({ length: 21 }, (_, i) => ({ provider, id: `m${i}`, name: `M${i}` })),
  }
  const { stored } = await navigate([
    ['enno-model-source', 'DSHに設定済みのモデルから選ぶ'],
    ['enno-model-review', 'enno-idealを変更'],
    ['enno-provider-ideal', '次のページ', hasChoice('次のページ')],
    ['enno-provider-ideal', '前のページ', hasChoice('P20 [p20]')],
    ['enno-provider-ideal', { custom: 'missing' }],
    ['enno-provider-ideal', '検索をクリア', q => assert.match(q.detail ?? '', /該当する接続がありません/u)],
    ['enno-provider-ideal', '次のページ'], ['enno-provider-ideal', '1'],
    ['enno-model-ideal', '次のページ', hasChoice('M0 [m0]')],
    ['enno-model-ideal', '前のページ', hasChoice('M20 [m20]')],
    ['enno-model-ideal', { custom: 'missing' }],
    ['enno-model-ideal', '検索をクリア'],
    ['enno-model-ideal', '次のページ'], ['enno-model-ideal', '1'],
    ['enno-model-review', null],
  ], { llm, routes: [{ provider: 'p20', family: 'other', connection: 'api', protocol: 'responses' }] })
  assert.deepEqual(stored.value.draft?.roles.ideal, { provider: 'p20', model: 'm20' })
})

test('unavailable page controls cannot move outside list bounds', async () => {
  await navigate([
    ['enno-model-review', 'enno-idealを変更'],
    ['enno-model-ideal', { custom: '前のページ' }],
    ['enno-model-ideal', 'gpt-6-astra [gpt-6-astra]', q => {
      assert.match(q.detail ?? '', /表示されている選択肢/u)
      hasChoice('gpt-6-astra [gpt-6-astra]')(q)
    }],
    ['enno-model-review', null],
  ], { stored: initial(roleDraft) })
})

test('template connection selection proceeds directly to confirmation using DSH settings', async () => {
  const { result } = await navigate([
    ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'OpenAI — 接続未設定'],
    ['enno-bind-provider', '戻る'],
    ['enno-template', 'OpenAI — 接続未設定'],
    ['enno-bind-provider', 'OpenAI Codex [openai-codex]'],
    ['enno-model-review', 'この構成で開始'],
  ], { routes: [] })
  assert.equal(result?.value.configuration?.roles.ideal.provider, 'openai-codex')
})


test('missing provider templates explain recovery and retain an existing draft', async () => {
  const { stored, saved } = await navigate([
    ['enno-model-review', '戻る'], ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'Ollama・ローカル標準 — 接続未設定'],
    ['enno-template-unavailable', '戻る', hasChoice('一覧を再取得')],
    ['enno-template', null],
  ], { stored: initial(roleDraft) })
  assert.deepEqual(stored.value.draft, roleDraft)
  assert.equal(saved.length, 0)
})

test('provider-catalog failure retries explicitly and does not repeat mode or source selection', async () => {
  let reads = 0
  await navigate([
    ['enno-model-source', 'DSHに設定済みのモデルから選ぶ'],
    ['enno-catalog-retry', '再取得'], ['enno-model-review', null],
  ], { llm: { ...codexCatalog, listProviders: () => { if (++reads === 1) throw new Error('offline'); return [codexProvider] } } })
  assert.equal(reads, 2)
})

test('a saved model configuration uses current DSH validation without reselecting models or protocol', async () => {
  const template = MODEL_TEMPLATES.find(t => t.id === 'openai-codex')!
  const roles = Object.fromEntries(Object.entries(template.models).map(([role, ids]) => [role, { provider: 'openai-codex', model: ids[0]! }]))
  const draft: ModelConfigurationDraft = { ...roleDraft, roles, routeBindings: [{ ...codexRoute, protocol: 'unknown' }] }
  const { result } = await navigate([['enno-model-review', 'この構成で開始']], { stored: initial(draft), routes: [] })
  assert.deepEqual(result?.value.configuration?.roles, roles)
})


test('a live Codex catalog missing a recommended model cannot silently substitute or start', async () => {
  const { stored } = await navigate([
    ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'OpenAI Codex・推奨（dsh-codex） — モデル不足'],
    ['enno-model-review', null, q => assert.equal(q.options?.some(o => o.label === 'この構成で開始'), false)],
  ], { routes: [], llm: { ...codexCatalog, listModels: async provider => [{ provider, id: 'gpt-6-astra', name: 'Astra' }] } })
  assert.equal(stored.value.draft?.roles.worker, undefined)
  assert.equal(stored.value.draft?.roles.goki, undefined)
  assert.equal(stored.value.status, 'selecting')
})

test('catalog changes at final adoption return to review with no ready selection saved', async () => {
  let reads = 0
  const { result, saved } = await navigate([
    ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'OpenAI Codex・推奨（dsh-codex） — 適用可能'],
    ['enno-model-review', 'この構成で開始'],
    ['enno-model-review', null, q => assert.equal(q.options?.some(o => o.label === 'この構成で開始'), false)],
  ], { routes: [], llm: { ...codexCatalog, listModels: async provider => {
    const models = await codexCatalog.listModels(provider)
    return ++reads < 3 ? models : models.filter(m => m.id !== 'gpt-5.6-luna')
  } } })
  assert.equal(result, undefined)
  assert.equal(saved.some(s => s.value.status === 'ready'), false)
})

test('Go, Zen, OpenRouter, Ollama and OrcaRouter models are searchable by name and retain distinct connections', async () => {
  const connections = [
    { id: 'go-account', name: 'OpenCode Go', family: 'opencode-go', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash' },
    { id: 'zen-account', name: 'OpenCode Zen', family: 'opencode-zen', model: 'configured-zen-model', modelName: 'Zen configured model' },
    { id: 'router-account', name: 'OpenRouter', family: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash' },
    { id: 'local-account', name: 'Ollama', family: 'ollama', model: 'qwen3-coder:30b', modelName: 'Qwen Coder' },
    { id: 'orca-account', name: 'OrcaRouter', family: 'orcarouter', model: 'deepseek/deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash' },
  ] as const
  const llm: DshModelCatalog = {
    listProviders: () => connections.map(({ id, name, family }) => ({ id, name, route: { provider: id, family, connection: family === 'ollama' ? 'local' : 'api', protocol: 'chat-completions' } })),
    resolveCallConfig: async binding => ({ ...binding }),
    listModels: async provider => {
      const connection = connections.find(c => c.id === provider)!
      return [{ provider, id: connection.model, name: connection.modelName }, { provider, id: 'unrelated', name: 'Unrelated model' }]
    },
  }
  const steps: Step[] = [['enno-model-source', 'DSHに設定済みのモデルから選ぶ']]
  for (const [index, role] of MODEL_ROLES.entries()) {
    const connection = connections[index]!
    steps.push(['enno-model-review', `${ROLE_LABELS[role]}を変更`])
    if (index > 0) steps.push([`enno-model-${role}`, '接続を変更'])
    steps.push(
      [`enno-provider-${role}`, { custom: connection.name }],
      [`enno-provider-${role}`, `${connection.name} [${connection.id}]`, q => {
        assert.deepEqual((q.options ?? []).filter(o => o.label.includes('[')).map(o => o.label), [`${connection.name} [${connection.id}]`])
      }],
      [`enno-model-${role}`, { custom: connection.modelName }],
      [`enno-model-${role}`, `${connection.modelName} [${connection.model}]`, q => {
        assert.deepEqual((q.options ?? []).filter(o => o.label.includes('[')).map(o => o.label), [`${connection.modelName} [${connection.model}]`])
      }],
    )
  }
  steps.push(['enno-model-review', 'この構成で開始'])
  // Synthetic catalog and explicit fixture evidence do not claim live Go/account access.
  const { result } = await navigate(steps, { llm, routes: [], compatibility: { inspect: async () => ({ protocol: 'chat-completions', goSessionHeaders: true }) } })
  assert.equal(result?.value.status, 'ready')
  assert.deepEqual(result?.value.configuration?.roles, Object.fromEntries(MODEL_ROLES.map((role, index) => [role, { provider: connections[index]!.id, model: connections[index]!.model }])))
  assert.equal(result?.value.configuration?.routeBindings, undefined, 'custom selection does not duplicate DSH connection settings')
  assert.equal(result?.value.configuration?.maxConcurrentChildren, 1)
  const resumed = await navigate([], { stored: result!, llm, routes: [] })
  assert.deepEqual(resumed.result, result)
})

for (const template of MODEL_TEMPLATES) test(`${template.id}: template adoption, cancellation and restart retain exact roles and route`, async () => {
  const route: ModelRoute = template.route ?? { provider: `fixture-${template.id}`, family: template.family, connection: template.family === 'ollama' ? 'local' : 'api', protocol: 'responses' }
  const models = [...new Set(Object.values(template.models).map(ids => ids[0]!))].map(id => ({ id, name: id, provider: route.provider }))
  const providers = [{ id: route.provider, name: template.name }]
  const llm: DshModelCatalog = { listProviders: () => providers, listModels: async () => models }
  // Only this fixture declares Go header evidence; UI answers cannot do so.
  const compatibility: DshModelCompatibility = { inspect: async () => ({ protocol: 'responses', goSessionHeaders: true }) }
  const options = { llm, routes: [route], compatibility }
  const { stored } = await navigate([
    ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', `${template.name} — 適用可能`, hasChoice(`${template.name} — 適用可能`)],
    ['enno-model-review', '取消・作業を保持'],
  ], options)
  assert.deepEqual(stored.value.draft?.roles, templateBindings(template, route.provider, { providers, models, failures: [] }))
  const { result } = await navigate([['enno-model-review', 'この構成で開始']], { ...options, stored })
  assert.equal(result?.value.status, 'ready')
  assert.deepEqual(result?.value.configuration?.roles, stored.value.draft?.roles)
  assert.equal(result?.value.configuration?.maxConcurrentChildren, template.maxConcurrentChildren)
  const completed = await navigate([], { ...options, stored: result! })
  assert.equal(completed.result, result)
})
