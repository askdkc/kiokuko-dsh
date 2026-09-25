import type { ConfiguredProvider, DshModelCatalog, ModelRoute } from './model-configuration.js'

interface ProviderDirectoryEntry { provider: string; settingsNs: string; settingsPath: readonly string[]; declared?: boolean }
interface NativeCatalog extends DshModelCatalog { listConfigurableProviders?(): readonly ProviderDirectoryEntry[] }
interface NativeSettings { describe(options: { redactSecrets: true }): readonly { ns: string; value: unknown }[] }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const families: Readonly<Record<string, ModelRoute['family']>> = {
  openai: 'openai', 'openai-codex': 'openai', deepseek: 'deepseek', 'deepseek-official': 'deepseek',
  'opencode-go': 'opencode-go', opencode: 'opencode-zen', 'opencode-zen': 'opencode-zen',
  openrouter: 'openrouter', orcarouter: 'orcarouter', ollama: 'ollama',
}

/** Read only connection metadata; never copy credentials, headers or whole profiles. */
function providerRoute(provider: string, entry: ProviderDirectoryEntry | undefined, descriptions: readonly { ns: string; value: unknown }[]): ModelRoute | undefined {
  if (!entry) return undefined
  if (entry.settingsNs === 'llm-deepseek' && provider === 'deepseek-official') return { provider, family: 'deepseek', connection: 'api', protocol: 'chat-completions' }
  if (entry.settingsNs !== 'llm-pi-ai') return undefined
  let profile: unknown = descriptions.find(item => item.ns === entry.settingsNs)?.value
  for (const key of entry.settingsPath) profile = object(profile)?.[key]
  const config = object(profile)
  let endpoint: URL | undefined
  try { if (typeof config?.baseURL === 'string') endpoint = new URL(config.baseURL) } catch { /* DSH validates malformed endpoints at dispatch. */ }
  const host = endpoint?.hostname
  const isPath = (path: string) => endpoint?.pathname === path || endpoint?.pathname.startsWith(`${path}/`)
  const family = host === 'opencode.ai' && isPath('/zen/go') ? 'opencode-go'
    : host === 'opencode.ai' && isPath('/zen') ? 'opencode-zen'
    : host === 'openrouter.ai' ? 'openrouter' : host === 'api.orcarouter.ai' ? 'orcarouter'
    : host === 'api.deepseek.com' ? 'deepseek' : host === 'api.openai.com' ? 'openai'
    : entry.declared === false ? families[provider] ?? 'other' : 'other'
  const local = family === 'ollama' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  const protocol = config?.api === 'openai-responses' ? 'responses' : config?.api === 'openai-completions' ? 'chat-completions'
    : config?.api === 'anthropic-messages' ? 'messages' : 'unknown'
  return { provider, family, connection: local ? 'local' : 'api', protocol }
}

/** Keep live catalogs and call validation bound to their native DSH service. */
export function nativeModelCatalog(llm: NativeCatalog | undefined, settings?: NativeSettings): DshModelCatalog | undefined {
  if (!llm) return undefined
  return {
    async listProviders() {
      const providers = await llm.listProviders()
      const directory = llm.listConfigurableProviders?.() ?? []
      let descriptions: readonly { ns: string; value: unknown }[] = []
      if (directory.some(entry => entry.settingsNs === 'llm-pi-ai') && settings) {
        try { descriptions = settings.describe({ redactSecrets: true }) } catch { /* Optional metadata must not prevent model discovery. */ }
      }
      return providers.map((provider): ConfiguredProvider => {
        const route = providerRoute(provider.id, directory.find(entry => entry.provider === provider.id), descriptions)
        return { ...provider, ...(route ? { route } : {}) }
      })
    },
    listModels: provider => llm.listModels(provider),
    ...(llm.resolveModelInfo ? { resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => llm.resolveModelInfo!(provider, model, signal) } : {}),
    ...(llm.resolveCallConfig ? { resolveCallConfig: (binding: Parameters<NonNullable<DshModelCatalog['resolveCallConfig']>>[0], signal?: AbortSignal) => llm.resolveCallConfig!(binding, signal) } : {}),
  }
}
