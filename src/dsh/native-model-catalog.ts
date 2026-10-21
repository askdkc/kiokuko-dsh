import { ownedModelRoute, ownedModelsForDisplay } from './models/metadata.js'
import type { ConfiguredProvider, DshModelCatalog, ModelRoute } from './model-configuration.js'

interface ProviderDirectoryEntry { provider: string; settingsNs: string; settingsPath: readonly string[]; declared?: boolean }
interface NativeCatalog extends DshModelCatalog {
  listConfigurableProviders?(): readonly ProviderDirectoryEntry[]
  discoverModels?(settingsNs: string, request: { provider: string }): PromiseLike<readonly { id: string; name?: string }[]>
}
interface NativeSettings { describe(options: { redactSecrets: true }): readonly { ns: string; value: unknown }[] }
export interface NativeModelCatalog extends DshModelCatalog {}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const families: Readonly<Record<string, ModelRoute['family']>> = {
  openai: 'openai', 'openai-codex': 'openai', deepseek: 'deepseek', 'deepseek-official': 'deepseek',
  'opencode-go': 'opencode-go', opencode: 'opencode-zen', 'opencode-zen': 'opencode-zen',
  openrouter: 'openrouter', ollama: 'ollama',
}
function providerProfile(entry: ProviderDirectoryEntry, descriptions: readonly { ns: string; value: unknown }[]) {
  let profile: unknown = descriptions.find(item => item.ns === entry.settingsNs)?.value
  for (const key of entry.settingsPath) profile = object(profile)?.[key]
  return object(profile)
}

/** Read only connection metadata; never copy credentials, headers or whole profiles. */
function providerRoute(provider: string, entry: ProviderDirectoryEntry | undefined, descriptions: readonly { ns: string; value: unknown }[]): ModelRoute | undefined {
  if (!entry) return undefined
  if (entry.settingsNs === 'llm-deepseek' && provider === 'deepseek-official') return { provider, family: 'deepseek', connection: 'api', protocol: 'chat-completions' }
  if (entry.settingsNs === 'llm-deepseek-account' && provider === 'deepseek-account') return { provider, family: 'deepseek', connection: 'api', protocol: 'messages' }
  if (entry.settingsNs !== 'llm-pi-ai') return undefined
  const config = providerProfile(entry, descriptions)
  let endpoint: URL | undefined
  try { if (typeof config?.baseURL === 'string') endpoint = new URL(config.baseURL) } catch { /* DSH validates malformed endpoints at dispatch. */ }
  const host = endpoint?.hostname
  const isPath = (path: string) => endpoint?.pathname === path || endpoint?.pathname.startsWith(`${path}/`)
  const family = host === 'opencode.ai' && isPath('/zen/go') ? 'opencode-go'
    : host === 'opencode.ai' && isPath('/zen') ? 'opencode-zen'
    : host === 'openrouter.ai' ? 'openrouter'
    : host === 'api.deepseek.com' ? 'deepseek' : host === 'api.openai.com' ? 'openai'
    : entry.declared === false ? families[provider] ?? 'other' : 'other'
  const local = family === 'ollama' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  const protocol = config?.api === 'openai-responses' ? 'responses' : config?.api === 'openai-completions' ? 'chat-completions'
    : config?.api === 'anthropic-messages' ? 'messages' : 'unknown'
  return { provider, family, connection: local ? 'local' : 'api', protocol }
}

/** Keep live catalogs and call validation bound to their native DSH service. */
export function nativeModelCatalog(llm: NativeCatalog | undefined, settings?: NativeSettings): NativeModelCatalog | undefined {
  if (!llm) return undefined
  const configurable = () => llm.listConfigurableProviders?.() ?? []
  const describe = () => settings?.describe({ redactSecrets: true }) ?? []
  return {
    async listProviders() {
      const providers = await llm.listProviders()
      const directory = configurable()
      let descriptions: readonly { ns: string; value: unknown }[] = []
      if (directory.some(entry => entry.settingsNs === 'llm-pi-ai') && settings) {
        try { descriptions = describe() } catch { /* Optional metadata must not prevent model discovery. */ }
      }
      return providers.map((provider): ConfiguredProvider => {
        const route = ownedModelRoute(llm, provider.id) ?? providerRoute(provider.id, directory.find(entry => entry.provider === provider.id), descriptions)
        return { ...provider, ...(route ? { route } : {}) }
      })
    },
    listModels: provider => llm.listModels(provider),
    async listModelsForDisplay(provider) {
      const owned = ownedModelsForDisplay(llm, provider)
      if (owned) return owned
      if (llm.listModelsForDisplay) return llm.listModelsForDisplay(provider)
      const entry = configurable().find(entry => entry.provider === provider)
      // Configured IDs are candidates; read only named non-secret fields.
      let configured: { provider: string; id: string; name: string }[] = []
      if (entry && settings) {
        try {
          const profile = providerProfile(entry, describe())
          const declared = Array.isArray(profile?.models) ? profile.models : []
          configured = declared.flatMap(model => {
            const row = object(model)
            return typeof row?.id === 'string' ? [{ provider, id: row.id, name: typeof row.name === 'string' ? row.name : row.id }] : []
          })
          if (configured.length) return configured
          if (!configured.length) configured = Object.keys(object(profile?.modelOverrides) ?? {}).map(id => ({ provider, id, name: id }))
        } catch { /* Missing optional settings leave the provider unverified. */ }
      }
      // The installed pi-ai discovery answers from its immutable catalog when
      // only provider is supplied. Without baseURL it fails before credentials
      // or network access; never retry through native listModels or an endpoint.
      if (entry?.settingsNs === 'llm-pi-ai' && llm.discoverModels) {
        try {
          const known = (await llm.discoverModels(entry.settingsNs, { provider })).map(model => ({ provider, id: model.id, name: model.name ?? model.id }))
          return [...known, ...configured.filter(model => !known.some(existing => existing.id === model.id))]
        }
        catch { /* Retain explicit selection without an authenticated fallback. */ }
      }
      return { models: configured, complete: false }
    },
    ...(llm.resolveModelInfo ? { resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => llm.resolveModelInfo!(provider, model, signal) } : {}),
    ...(llm.resolveCallConfig ? { resolveCallConfig: (binding: Parameters<NonNullable<DshModelCatalog['resolveCallConfig']>>[0], signal?: AbortSignal) => llm.resolveCallConfig!(binding, signal) } : {}),
  }
}
