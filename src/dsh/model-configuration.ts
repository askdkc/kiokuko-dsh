import { z } from 'zod'

const identity = z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u).refine(value => value === value.trim(), 'Identifiers must not have surrounding whitespace')
export const MODEL_ROLES = ['ideal', 'zenki', 'goki', 'worker', 'check'] as const
export type ModelRole = typeof MODEL_ROLES[number]
export const ROLE_LABELS: Record<ModelRole, string> = {
  ideal: 'enno-ideal', zenki: '前鬼 (Zenki)', goki: '後鬼 (Goki) ヘッド', worker: '後鬼のサブエージェント', check: 'enno-check・振り返り',
}
export const ModelRouteSchema = z.object({
  provider: identity,
  family: z.enum(['openai', 'opencode-go', 'opencode-zen', 'openrouter', 'ollama', 'other']),
  connection: z.enum(['api', 'codex', 'local']).default('api'),
  protocol: z.enum(['responses', 'chat-completions', 'messages', 'unknown']).default('unknown'),
}).strict()
export type ModelRoute = z.infer<typeof ModelRouteSchema>
export const ModelBindingSchema = z.object({ provider: identity, model: identity, reasoningEffort: identity.optional() }).strict()
export type ModelBinding = z.infer<typeof ModelBindingSchema>
export const ModelConfigurationSchema = z.object({
  routeBindings: z.array(ModelRouteSchema).max(128).optional(),
  roles: z.object({ ideal: ModelBindingSchema, zenki: ModelBindingSchema, goki: ModelBindingSchema, worker: ModelBindingSchema, check: ModelBindingSchema }).strict(),
  template: z.object({ id: identity, version: z.number().int().positive() }).strict().optional(),
  custom: z.boolean(),
  maxConcurrentChildren: z.number().int().min(1).max(8),
}).strict()
export type ModelConfiguration = z.infer<typeof ModelConfigurationSchema>
export const ModelConfigurationDraftSchema = ModelConfigurationSchema.extend({ roles: ModelConfigurationSchema.shape.roles.partial() })
export type ModelConfigurationDraft = z.infer<typeof ModelConfigurationDraftSchema>
export interface ModelTemplate {
  readonly id: string
  readonly version: number
  readonly name: string
  readonly group: string
  readonly family: ModelRoute['family']
  /** Exact connection contract of an explicitly selected plugin template. */
  readonly route?: ModelRoute
  readonly models: Readonly<Record<ModelRole, readonly string[]>>
  readonly maxConcurrentChildren: number
}
function template(id: string, name: string, group: string, family: ModelRoute['family'], head: string, worker: string, goki = head, aliases: readonly string[] = []): ModelTemplate {
  return Object.freeze({ id, version: 1, name, group, family,
    models: { ideal: [head, ...aliases], zenki: [head, ...aliases], goki: [goki, ...(goki === head ? aliases : [])], worker: [worker], check: [head, ...aliases] },
    maxConcurrentChildren: family === 'ollama' ? 1 : 4 })
}
/** Provider-owned exact identifiers only. Display names never select a model. */
export const MODEL_TEMPLATES: readonly ModelTemplate[] = [
  template('openai', 'OpenAI', 'OpenAI', 'openai', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol'),
  Object.freeze({
    ...template('openai-codex', 'OpenAI Codex・推奨（dsh-codex）', 'OpenAI', 'openai', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol'),
    // askdkc/dsh-codex e2e61b6 registers this exact route with the Codex Responses adapter.
    route: { provider: 'openai-codex', family: 'openai', connection: 'codex', protocol: 'responses' } as const,
  }),
  template('go-glm', 'OpenCode Go・GLM', 'OpenCode Go', 'opencode-go', 'glm-5.3', 'glm-5.3-flash'),
  template('go-qwen', 'OpenCode Go・Qwen', 'OpenCode Go', 'opencode-go', 'qwen3.8-max', 'qwen3.8-flash'),
  template('zen-glm', 'OpenCode Zen', 'OpenCode Zen', 'opencode-zen', 'glm-5.3', 'glm-5.3-flash'),
  template('router-glm', 'OpenRouter・GLM', 'OpenRouter', 'openrouter', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash'),
  template('router-qwen', 'OpenRouter・Qwen', 'OpenRouter', 'openrouter', 'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-flash'),
  template('ollama', 'Ollama・ローカル標準', 'Ollama', 'ollama', 'qwen3-coder:30b', 'qwen3-coder:30b'),
]
export interface ConfiguredModel { readonly provider: string; readonly id: string; readonly name: string }
export interface ConfiguredProvider { readonly id: string; readonly name: string }
export interface DshModelCatalog {
  listProviders(): readonly ConfiguredProvider[] | PromiseLike<readonly ConfiguredProvider[]>
  listModels(provider: string): PromiseLike<readonly ConfiguredModel[]>
}
export interface ModelCatalogSnapshot {
  readonly providers: readonly ConfiguredProvider[]
  readonly models: readonly ConfiguredModel[]
  readonly failures: readonly string[]
}
export async function readModelCatalog(llm: DshModelCatalog): Promise<ModelCatalogSnapshot> {
  const providers = await llm.listProviders()
  const results = await Promise.allSettled(providers.map(provider => llm.listModels(provider.id)))
  const models: ConfiguredModel[] = [], failures: string[] = []
  results.forEach((result, index) => {
    const provider = providers[index]!
    if (result.status === 'rejected') { failures.push(provider.id); return }
    const seen = new Set<string>()
    for (const model of result.value) {
      if (model.provider !== provider.id || !identity.safeParse(model.id).success || seen.has(model.id)) { failures.push(provider.id); continue }
      seen.add(model.id); models.push({ provider: provider.id, id: model.id, name: model.name })
    }
  })
  return { providers: providers.map(p => ({ id: p.id, name: p.name })), models, failures }
}
/** A host adapter may supply transport evidence; a UI answer cannot assert it. */
export interface DshModelCompatibility {
  inspect(binding: ModelBinding, route: ModelRoute): PromiseLike<{
    readonly protocol: ModelRoute['protocol']
    readonly goSessionHeaders: boolean
  }>
}
export async function configurationProblems(configuration: ModelConfiguration, catalog: ModelCatalogSnapshot, routes: readonly ModelRoute[], compatibility?: DshModelCompatibility): Promise<string[]> {
  return modelBindingProblems(MODEL_ROLES.map(role => ({ label: ROLE_LABELS[role], binding: configuration.roles[role] })), catalog,
    [...routes, ...(configuration.routeBindings ?? []).filter(route => !routes.some(r => r.provider === route.provider))], compatibility)
}
export async function modelBindingProblems(bindings: readonly { label: string; binding: ModelBinding }[], catalog: ModelCatalogSnapshot, routes: readonly ModelRoute[], compatibility?: DshModelCompatibility): Promise<string[]> {
  const problems: string[] = []
  for (const { label, binding } of bindings) {
    if (catalog.failures.includes(binding.provider)) { problems.push(`${label}: 接続のモデル一覧を取得できません (${binding.provider})`); continue }
    if (!catalog.models.some(m => m.provider === binding.provider && m.id === binding.model)) { problems.push(`${label}: 設定済みモデルがありません (${binding.provider} / ${binding.model})`); continue }
    const route = routes.find(r => r.provider === binding.provider)
    // Unknown routes must be classified before use, including the custom path.
    if (!route) { problems.push(`${label}: 接続先の種類・通信方式をプラグイン設定の modelRoutes に登録してください (${binding.provider})`); continue }
    let evidence: Awaited<ReturnType<DshModelCompatibility['inspect']>> | undefined
    try { evidence = await compatibility?.inspect(binding, route) } catch { /* unverified */ }
    if (binding.model === 'gpt-6-astra' && (evidence?.protocol ?? route.protocol) !== 'responses') problems.push(`${label}: AstraにはResponses接続が必要です`)
    if (route.family === 'opencode-go' && evidence?.goSessionHeaders !== true) problems.push(`${label}: OpenCode Goの親・子・補助要求のセッション情報は互換性の確認が必要です`)
  }
  return [...new Set(problems)]
}
export function templateBindings(template: ModelTemplate, provider: string, catalog: ModelCatalogSnapshot): Partial<Record<ModelRole, ModelBinding>> {
  return Object.fromEntries(MODEL_ROLES.flatMap(role => {
    const id = template.models[role].find(id => catalog.models.some(m => m.provider === provider && m.id === id))
    return id === undefined ? [] : [[role, { provider, model: id }]]
  }))
}
