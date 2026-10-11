import { canonicalContentHash } from '../../serialization/validate.js'
import type { DshModelCatalog, ModelBinding } from '../model-configuration.js'
import { DEFAULT_MODEL_AUTO_ROUTES, type ModelAutoConfiguration, type ModelAutoRouteId } from './contracts.js'

export interface ModelAutoCandidates {
  readonly routes: readonly { id: ModelAutoRouteId; binding: ModelBinding }[]
  readonly digest: string
  readonly reason?: 'candidate_unavailable' | 'candidate_insufficient'
}

/** The live adapter owns both model capabilities and effort validation. */
export async function modelAutoCandidates(catalog: DshModelCatalog | undefined, config: ModelAutoConfiguration,
  attachmentTypes: readonly string[], signal: AbortSignal, requiredContextTokens?: number): Promise<ModelAutoCandidates> {
  if (!catalog?.resolveCallConfig || !catalog.resolveModelInfo || !Number.isSafeInteger(requiredContextTokens) || requiredContextTokens! < 0)
    return { routes: [], digest: '', reason: 'candidate_unavailable' }
  try {
    const providers = await catalog.listProviders()
    const eligible = providers.filter(p => p.route
      ? p.route.family === 'openai' && p.route.connection === 'codex' && p.route.protocol === 'responses'
      : p.id === 'openai-codex') // The native adapter validates its legacy canonical route.
    if (!eligible.length) return { routes: [], digest: '', reason: 'candidate_unavailable' }
    const catalogs = await Promise.allSettled(eligible.map(p => catalog.listModels(p.id)))
    const listed = catalogs.flatMap(result => result.status === 'fulfilled' ? [...result.value] : [])
    signal.throwIfAborted()
    const routes: { id: ModelAutoRouteId; binding: ModelBinding }[] = []
    for (const route of config.routes ?? DEFAULT_MODEL_AUTO_ROUTES) {
      // Explicit bindings never substitute providers. Preset labels may use any
      // admitted subscription route, including an owned route beside an empty native one.
      const candidates = config.routes ? [route.binding] : eligible.map(p => ({ ...route.binding, provider: p.id }))
      for (const binding of candidates) {
        if (!eligible.some(p => p.id === binding.provider) || !listed.some(model => model.provider === binding.provider && model.id === binding.model)) continue
        try {
          const info = await catalog.resolveModelInfo(binding.provider, binding.model, signal)
          if (info.provider !== binding.provider || info.id !== binding.model || !info.context?.contextWindow
            || info.context.contextWindow < requiredContextTokens! + 16_384
            || !info.reasoning?.efforts.some(effort => effort.id === binding.reasoningEffort)) continue
          if (attachmentTypes.includes('image') && !info.inputModalities?.includes('image')) continue
          if (attachmentTypes.some(type => type !== 'image' && type !== 'text')) continue
          const resolved = await catalog.resolveCallConfig(binding, signal)
          if (resolved.provider !== binding.provider || resolved.model !== binding.model || resolved.reasoningEffort !== binding.reasoningEffort) continue
          routes.push({ id: route.id, binding: { ...binding } })
          break
        } catch (error) { if (signal.aborted) throw error }
      }
    }
    const unique = routes.filter((route, index) => routes.findIndex(other => JSON.stringify(other.binding) === JSON.stringify(route.binding)) === index)
    return { routes: unique, digest: canonicalContentHash({ policy: config.preset, routes: unique }),
      ...(unique.length < 2 ? { reason: 'candidate_insufficient' as const } : {}) }
  } catch (error) {
    if (signal.aborted) throw error
    return { routes: [], digest: '', reason: 'candidate_unavailable' }
  }
}
