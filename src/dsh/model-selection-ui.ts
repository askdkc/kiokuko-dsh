import type { DshUserQuestionAgent, DshUserQuestions } from './user-interaction.js'
import { explicitExecutionMode, type StoredExecutionSelection, type ExecutionSelection } from './execution-selection.js'
import { MODEL_ROLES, MODEL_TEMPLATES, ROLE_LABELS, ModelConfigurationSchema, configurationProblems, modelRoutesForCatalog, readModelCatalog, templateBindings,
  type DshModelCatalog, type DshModelCompatibility, type ModelBinding, type ModelCatalogSnapshot, type ModelConfigurationDraft, type ModelRole, type ModelRoute, type ModelTemplate } from './model-configuration.js'

export class ExecutionSelectionPending extends Error {
  constructor() { super('実行方式・モデル構成の選択待ちです。依頼と完了済みの作業は保持されています。') }
}
interface SelectionUiInput {
  readonly task: string
  readonly agent?: DshUserQuestionAgent
  readonly signal: AbortSignal
  readonly questions?: DshUserQuestions
  readonly llm?: DshModelCatalog
  readonly routes: readonly ModelRoute[]
  readonly compatibility?: DshModelCompatibility
  readonly stored: StoredExecutionSelection
  readonly save: (revision: number, value: ExecutionSelection) => Promise<StoredExecutionSelection>
}
const BACK = '戻る', CANCEL = '取消・作業を保持', NEXT_PAGE = '次のページ', PREVIOUS_PAGE = '前のページ', CHANGE_PROVIDER = '接続を変更'
const CLEAR_SEARCH = '検索をクリア', RELOAD = '一覧を再取得'
async function ask(input: SelectionUiInput, id: string, question: string, choices: readonly string[], detail = '', searchable = false): Promise<string> {
  let validation = ''
  while (true) {
    if (!input.questions || input.signal.aborted) throw new ExecutionSelectionPending()
    let response
    try {
      response = await input.questions.ask({
        questions: [{ id, header: '実行方式とモデル', question, options: [...choices, CANCEL].map(label => ({ label })), detail: [detail, validation].filter(Boolean).join('\n') }],
        ...(input.agent ? { agent: input.agent } : {}), signal: input.signal,
      })
      input.signal.throwIfAborted()
    } catch {
      // Native cancellation, missing UI and abort all leave the durable draft intact.
      throw new ExecutionSelectionPending()
    }
    const answer = response.answers[0]
    if (answer?.id !== id || answer.selected.length > 1) throw new ExecutionSelectionPending()
    const custom = answer.custom?.trim()
    const value = custom || answer.selected[0]
    if (!value) throw new ExecutionSelectionPending()
    // Search cards keep free-text digits literal; fixed menus also accept typed option numbers.
    const index = (!custom || !searchable) && /^\d+$/u.test(value) ? Number(value) - 1 : -1
    const resolved = index >= 0 ? [...choices, CANCEL][index] : value
    if (resolved === CANCEL) throw new ExecutionSelectionPending()
    const navigation = [BACK, NEXT_PAGE, PREVIOUS_PAGE, CHANGE_PROVIDER, CLEAR_SEARCH, RELOAD]
    if (resolved && (choices.includes(resolved) || (searchable && !navigation.includes(resolved)))) return resolved
    validation = '表示されている選択肢を選んでください。'
  }
}
async function selectionCatalog(input: SelectionUiInput): Promise<ModelCatalogSnapshot> {
  if (!input.llm) throw new ExecutionSelectionPending()
  while (true) {
    try { return await readModelCatalog(input.llm) } catch {
      await ask(input, 'enno-catalog-retry', 'DSHのモデル一覧を取得できません。作業を保持しています。', ['再取得'])
    }
  }
}
function modelLabel(catalog: ModelCatalogSnapshot, binding: ModelBinding): string {
  const provider = catalog.providers.find(p => p.id === binding.provider)
  const model = catalog.models.find(m => m.provider === binding.provider && m.id === binding.model)
  return `${provider?.name ?? binding.provider} [${binding.provider}] / ${model?.name ?? binding.model} [${binding.model}]`
}
async function pickModel(input: SelectionUiInput, catalog: ModelCatalogSnapshot, draft: ModelConfigurationDraft, role: ModelRole): Promise<ModelBinding | undefined> {
  let query = ''
  let providerPage = 0
  // Editing keeps this role's connection; unset roles start with enno-ideal's.
  const preferredProvider = (draft.roles[role] ?? draft.roles.ideal)?.provider
  let provider = catalog.providers.find(p => p.id === preferredProvider)
  const copies = MODEL_ROLES.filter(r => r !== role && draft.roles[r]).map(r => ({ role: r, label: `${ROLE_LABELS[r]}からコピー` }))
  while (true) {
    const selectedFromProviderList = !provider
    if (!provider) {
      const filteredProviders = catalog.providers.filter(p => !query || `${p.name} ${p.id}`.toLowerCase().includes(query))
      const providers = filteredProviders.slice(providerPage * 20, (providerPage + 1) * 20)
      const labels = providers.map(p => `${p.name} [${p.id}]`)
      const choice = await ask(input, `enno-provider-${role}`, `${ROLE_LABELS[role]}の接続を選択`, [...labels, ...(filteredProviders.length > (providerPage + 1) * 20 ? [NEXT_PAGE] : []), ...(providerPage ? [PREVIOUS_PAGE] : []), ...(query ? [CLEAR_SEARCH] : []), RELOAD, ...copies.map(c => c.label), BACK],
        `${filteredProviders.length ? '' : '該当する接続がありません。DSHに接続を登録して「一覧を再取得」してください。'}自由入力で接続名を検索できます。同名モデルも接続IDとモデルIDで区別します。`, true)
      if (choice === BACK) return undefined
      if (choice === CLEAR_SEARCH) { query = ''; providerPage = 0; continue }
      if (choice === RELOAD) { catalog = await selectionCatalog(input); providerPage = 0; continue }
      if (choice === NEXT_PAGE) { providerPage++; continue }
      if (choice === PREVIOUS_PAGE) { providerPage--; continue }
      const copy = copies.find(c => c.label === choice)
      if (copy) return { ...draft.roles[copy.role]! }
      provider = providers[labels.indexOf(choice)]
      if (!provider) { query = choice.toLowerCase(); providerPage = 0; continue }
    }
    const selectedProvider = provider
    let search = ''
    let modelPage = 0
    while (true) {
      const filteredModels = catalog.models.filter(m => m.provider === selectedProvider.id && `${m.id} ${m.name}`.toLowerCase().includes(search))
      const models = filteredModels.slice(modelPage * 20, (modelPage + 1) * 20)
      const displayed = models.map(m => `${m.name} [${m.id}]`)
      const model = await ask(input, `enno-model-${role}`, `${selectedProvider.name} [${selectedProvider.id}]: ${ROLE_LABELS[role]}のモデル`, [...displayed, ...(filteredModels.length > (modelPage + 1) * 20 ? [NEXT_PAGE] : []), ...(modelPage ? [PREVIOUS_PAGE] : []), ...(search ? [CLEAR_SEARCH] : []), RELOAD, CHANGE_PROVIDER, ...copies.map(c => c.label), BACK],
        catalog.failures.includes(selectedProvider.id) ? 'この接続のモデル一覧を取得できません。「一覧を再取得」で再試行できます。' : `${filteredModels.length ? '' : '該当するモデルがありません。'}自由入力でモデルを検索できます。別の接続を使う場合は「接続を変更」を選んでください。未登録モデルの入力や自動ダウンロードは行いません。`, true)
      if (model === BACK) {
        if (!selectedFromProviderList) return undefined
        break
      }
      if (model === CHANGE_PROVIDER) break
      if (model === CLEAR_SEARCH) { search = ''; modelPage = 0; continue }
      if (model === RELOAD) { catalog = await selectionCatalog(input); modelPage = 0; continue }
      if (model === NEXT_PAGE) { modelPage++; continue }
      if (model === PREVIOUS_PAGE) { modelPage--; continue }
      const copy = copies.find(c => c.label === model)
      if (copy) return { ...draft.roles[copy.role]! }
      const selected = models[displayed.indexOf(model)]
      if (selected) return { provider: selectedProvider.id, model: selected.id }
      search = model.toLowerCase(); modelPage = 0
    }
    provider = undefined
  }
}
function templateRoutes(template: ModelTemplate, catalog: ModelCatalogSnapshot, known: readonly ModelRoute[]): readonly ModelRoute[] {
  const required = template.route
  if (!required) return known.filter(r => r.family === template.family && catalog.providers.some(p => p.id === r.provider))
  if (!catalog.providers.some(p => p.id === required.provider)) return []
  const declared = known.find(r => r.provider === required.provider)
  if (!catalog.resolveCallConfig && declared && (declared.family !== required.family || declared.connection !== required.connection || declared.protocol !== required.protocol)) return []
  return [declared ?? required]
}
async function templateStatus(input: SelectionUiInput, template: ModelTemplate, catalog: ModelCatalogSnapshot): Promise<string> {
  const routes = templateRoutes(template, catalog, input.routes)
  if (!routes.length && template.route && catalog.providers.some(p => p.id === template.route!.provider) && input.routes.some(r => r.provider === template.route!.provider)) return '接続設定が不一致'
  if (!routes.length) return '接続未設定'
  if (routes.every(r => catalog.failures.includes(r.provider))) return '一覧取得失敗'
  let complete = false
  for (const route of routes) {
    const configuration = ModelConfigurationSchema.safeParse({ roles: templateBindings(template, route.provider, catalog), custom: false, maxConcurrentChildren: template.maxConcurrentChildren })
    if (!configuration.success) continue
    complete = true
    if (!(await configurationProblems(configuration.data, catalog, routes, input.compatibility)).length) return '適用可能'
  }
  return complete ? '互換性の確認が必要' : 'モデル不足'
}
/** Native question cards keep keyboard, cancellation and answer routing owned by DSH. */
export async function selectExecution(input: SelectionUiInput): Promise<StoredExecutionSelection> {
  let stored = input.stored
  const save = async (value: ExecutionSelection) => { stored = await input.save(stored.revision, value) }
  if (stored.value.status === 'ready') return stored
  let draft: ModelConfigurationDraft = structuredClone(stored.value.draft ?? stored.value.configuration ?? { roles: {}, custom: true, maxConcurrentChildren: 4 })
  let explicit = stored.value.mode === 'pending' ? explicitExecutionMode(input.task) : undefined
  let screen: 'mode' | 'source' | 'templates' | 'review' = stored.value.mode === 'pending' ? 'mode' : Object.keys(draft.roles).length ? 'review' : 'source'
  while (true) {
    if (screen === 'mode') {
      const mode = explicit ?? await ask(input, 'enno-execution-mode', 'この作業をどう実行しますか？', ['通常実行', '役小角を使う'], '通常実行は現在のDSHモデルで進めます。記憶・Skill・権限判定・検証は維持します。')
      // Explicit intent is consumed once. Back navigation is a new user choice.
      explicit = undefined
      if (mode === 'normal' || mode === '通常実行') {
        await save({ mode: 'normal', status: 'ready', ...(stored.value.ordinaryModel ? { ordinaryModel: stored.value.ordinaryModel } : {}) }); return stored
      }
      await save({ ...stored.value, mode: 'enno', status: 'selecting', draft })
      screen = Object.keys(draft.roles).length ? 'review' : 'source'
      continue
    }
    if (screen === 'source') {
      const source = await ask(input, 'enno-model-source', 'モデル構成の設定方法', ['おすすめテンプレートから選ぶ', 'DSHに設定済みのモデルから選ぶ', BACK],
        [stored.value.problem, 'モデル名から選ぶ場合は「DSHに設定済みのモデルから選ぶ」。OpenCode Go / Zen、OpenRouter、Ollama、OrcaRouterなど、登録した接続の一覧を使えます。'].filter(Boolean).join('\n'))
      if (source === BACK) { screen = stored.value.status === 'reselect' ? 'review' : 'mode'; continue }
      screen = source === 'おすすめテンプレートから選ぶ' ? 'templates' : 'review'
      continue
    }
    const catalog = await selectionCatalog(input)
    if (screen === 'templates') {
      const statusRoutes = modelRoutesForCatalog(catalog, [...input.routes, ...(draft.routeBindings ?? []).filter(r => !input.routes.some(k => k.provider === r.provider))])
      const statuses = await Promise.all(MODEL_TEMPLATES.map(t => templateStatus({ ...input, routes: statusRoutes }, t, catalog)))
      const labels = MODEL_TEMPLATES.map((t, i) => `${t.name} — ${statuses[i]}`)
      const picked = await ask(input, 'enno-template', 'おすすめテンプレート', [...labels, BACK], 'OpenAI / DeepSeek / OpenCode Go / OpenCode Zen / OpenRouter / OrcaRouter / Ollama。接続・認証はDSHが管理します。')
      if (picked === BACK) { screen = 'source'; continue }
      const template = MODEL_TEMPLATES[labels.indexOf(picked)]
      if (!template) continue
      const knownRoutes = statusRoutes
      const routes = templateRoutes(template, catalog, knownRoutes)
      if (template.route && !routes.length) {
        await ask(input, 'enno-template-unavailable', 'このテンプレートの接続を利用できません。', [RELOAD, BACK],
          `${template.group}の接続 ${template.route.provider} が必要です。対象DSHプロファイルで接続を有効にし、一覧を再取得してください。`)
        continue
      }
      let route = routes.length === 1 ? routes[0] : undefined
      if (routes.length > 1) {
        const names = routes.map(r => `${catalog.providers.find(p => p.id === r.provider)?.name ?? r.provider} [${r.provider}]`)
        const routeChoice = await ask(input, 'enno-template-provider', 'このテンプレートで使うDSH接続', [...names, BACK])
        if (routeChoice === BACK) continue
        route = routes[names.indexOf(routeChoice)]
      }
      if (!route) {
        const unbound = catalog.providers.filter(p => !knownRoutes.some(r => r.provider === p.id))
        if (!unbound.length) {
          await ask(input, 'enno-template-unavailable', 'このテンプレートに対応する接続がありません。', [RELOAD, BACK],
            `${template.group}の接続をDSHに登録するか、別のテンプレートを選んでください。既存のモデル構成は保持しています。`)
          continue
        }
        const labels = unbound.map(p => `${p.name} [${p.id}]`)
        const answer = await ask(input, 'enno-bind-provider', `${template.group}で使う設定済み接続`, [...labels, BACK], '認証・通信方式は、選択したDSH接続の設定を使います。')
        if (answer === BACK) continue
        const provider = unbound[labels.indexOf(answer)]!
        route = { provider: provider.id, family: template.family, connection: template.family === 'ollama' ? 'local' : 'api', protocol: 'unknown' }
      }
      draft = { roles: templateBindings(template, route.provider, catalog), routeBindings: [...knownRoutes.filter(r => r.provider !== route.provider), route], template: { id: template.id, version: template.version }, custom: false, maxConcurrentChildren: template.maxConcurrentChildren }
      await save({ ...stored.value, draft })
      screen = 'review'
      continue
    }
    const complete = ModelConfigurationSchema.safeParse(draft)
    const problems = complete.success ? await configurationProblems(complete.data, catalog, input.routes, input.compatibility) : ['未設定の役割を選択してください。']
    const detail = [draft.custom ? 'カスタム' : MODEL_TEMPLATES.find(t => t.id === draft.template?.id)?.name ?? 'カスタム',
      ...MODEL_ROLES.map(role => `${ROLE_LABELS[role]}: ${draft.roles[role] ? modelLabel(catalog, draft.roles[role]!) : '未設定'}`),
      ...problems, ...(catalog.failures.length ? [`一覧取得失敗: ${catalog.failures.join(', ')}`] : []),
      'reasoningはモデルの既定値。カタログへの登録は契約上の利用成功を保証しません。',
    ].join('\n')
    const roleLabels = MODEL_ROLES.map(role => `${ROLE_LABELS[role]}を変更`)
    const selected = await ask(input, 'enno-model-review', '構成を確認して開始', [...(complete.success && !problems.length ? ['この構成で開始'] : []), ...roleLabels, RELOAD, BACK], detail)
    if (selected === BACK) { screen = 'source'; continue }
    if (selected === 'この構成で開始' && complete.success && !problems.length) {
      // Revalidate immediately before adoption. No provider defaults or credentials are written.
      const latest = await selectionCatalog(input)
      if ((await configurationProblems(complete.data, latest, input.routes, input.compatibility)).length) continue
      const routes = modelRoutesForCatalog(latest, [...input.routes, ...(complete.data.routeBindings ?? [])])
      const usesOllama = MODEL_ROLES.some(role => routes.some(r => r.provider === complete.data.roles[role].provider && (r.family === 'ollama' || r.connection === 'local')))
      await save({ mode: 'enno', status: 'ready', ...(stored.value.ordinaryModel ? { ordinaryModel: stored.value.ordinaryModel } : {}), configuration: { ...complete.data, maxConcurrentChildren: usesOllama ? 1 : complete.data.maxConcurrentChildren } })
      return stored
    }
    const role = MODEL_ROLES[roleLabels.indexOf(selected)]
    if (role) {
      const binding = await pickModel(input, catalog, draft, role)
      if (binding) {
        // The selected model already identifies its configured DSH provider.
        draft = { ...draft, custom: true, roles: { ...draft.roles, [role]: binding } }
        await save({ ...stored.value, draft })
      }
    }
  }
}
