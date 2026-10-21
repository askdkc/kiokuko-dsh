import { z } from 'zod'
import { ModelBindingSchema, modelBindingProblems, modelRoutesForCatalog, readModelCatalog,
  type DshModelCatalog, type DshModelCompatibility, type ModelBinding, type ModelCatalogSnapshot,
  type ModelConfiguration, type ModelRoute } from './model-configuration.js'

export const HEAD_WORKER_PRESET = 'gpt-6.1-sol-deepseek-v4.1-flash' as const
export const HEAD_WORKER_LABEL = 'GPT-6.1-Sol ヘッド / DeepSeek V4.1 Flash サブエージェント'
const workerIds = ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'] as const
export const HeadWorkerConfigurationSchema = z.object({
  preset: z.literal(HEAD_WORKER_PRESET),
  head: ModelBindingSchema.refine(b => b.model === 'gpt-6.1-sol', 'Select the exact GPT-6.1-Sol model'),
  worker: ModelBindingSchema.refine(b => workerIds.some(id => id === b.model), 'Select the exact DeepSeek V4.1 Flash model'),
}).strict()
export type HeadWorkerConfiguration = z.infer<typeof HeadWorkerConfigurationSchema>

/** Provider validation may contain private response text; pair UI diagnostics are locally generated. */
function safeCatalog(catalog: ModelCatalogSnapshot): ModelCatalogSnapshot {
  return { ...catalog, ...(catalog.resolveCallConfig ? { resolveCallConfig: async (binding: ModelBinding) => {
    try { return await catalog.resolveCallConfig!(binding) }
    catch { throw new Error('モデル接続を検証できません。認証・接続設定を確認してください。') }
  } } : {}) }
}

/** IDs are provider-owned. A name or an alias from a different route is never evidence. */
function workerForRoute(binding: ModelBinding, routes: readonly ModelRoute[]): boolean {
  const family = routes.find(r => r.provider === binding.provider)?.family
  return family === 'deepseek' ? binding.model === 'deepseek-flash'
    : family === 'opencode-go' || family === 'opencode-zen' ? binding.model === 'deepseek-v4.1-flash'
      : family === 'openrouter' ? binding.model === 'deepseek/deepseek-v4.1-flash' : false
}
export async function headWorkerCandidates(catalog: ModelCatalogSnapshot, declared: readonly ModelRoute[] = [], compatibility?: DshModelCompatibility): Promise<{
  heads: ModelBinding[]; workers: ModelBinding[]; problems: string[]
}> {
  catalog = safeCatalog(catalog)
  const routes = modelRoutesForCatalog(catalog, declared)
  const heads: ModelBinding[] = [], workers: ModelBinding[] = [], problems: string[] = []
  for (const model of catalog.models) {
    const binding = { provider: model.provider, model: model.id }
    const head = model.id === 'gpt-6.1-sol'
    const worker = workerForRoute(binding, routes)
    if (!head && !worker) continue
    const failures = await modelBindingProblems([{ label: head ? 'ヘッド' : 'サブエージェント', binding }], catalog, routes, compatibility)
    if (failures.length) { problems.push(...failures); continue }
    ;(head ? heads : workers).push(binding)
  }
  if (!heads.length) problems.push('GPT-6.1-Sol の利用可能な接続・モデルがありません。Kiokuko Models で接続を確認してください。')
  if (!workers.length) problems.push('DeepSeek V4.1 Flash の利用可能な接続・モデルがありません。Kiokuko Models で接続を確認してください。')
  return { heads, workers, problems: [...new Set(problems)] }
}
/** Re-read the live catalog immediately before selection/dispatch; never generate a model request here. */
export async function validateHeadWorker(configuration: HeadWorkerConfiguration, llm: DshModelCatalog, declared: readonly ModelRoute[] = [], compatibility?: DshModelCompatibility): Promise<string[]> {
  const parsed = HeadWorkerConfigurationSchema.safeParse(configuration)
  if (!parsed.success) return ['ヘッドとサブエージェントのモデル構成が不正です。選び直してください。']
  const catalog = safeCatalog(await readModelCatalog(llm, [parsed.data.head.provider, parsed.data.worker.provider])), routes = modelRoutesForCatalog(catalog, declared)
  const problems = await modelBindingProblems([{ label: 'ヘッド', binding: parsed.data.head }, { label: 'サブエージェント', binding: parsed.data.worker }], catalog, routes, compatibility)
  if (!workerForRoute(parsed.data.worker, routes)) problems.push('DeepSeek V4.1 Flash の接続とモデルIDが一致しません。接続を選び直してください。')
  return [...new Set(problems)]
}
export function headWorkerEnnoConfiguration(configuration: HeadWorkerConfiguration): ModelConfiguration {
  const pair = HeadWorkerConfigurationSchema.parse(configuration)
  return { roles: { ideal: { ...pair.head }, zenki: { ...pair.head }, goki: { ...pair.head }, worker: { ...pair.worker }, check: { ...pair.head } },
    template: { id: HEAD_WORKER_PRESET, version: 1 }, custom: false, maxConcurrentChildren: 4 }
}
