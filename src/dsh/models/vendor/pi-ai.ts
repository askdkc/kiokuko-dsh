/**
 * The pi-ai instance owned by the installed dsh-llm-pi-ai adapter.
 *
 * Loading a second catalog from dsh-auth and handing its Provider objects to
 * the adapter crosses package instances and is neither type- nor runtime-safe.
 * Resolve the adapter's own dependency instead, and derive every public type
 * from the adapter contract so this package owns no pi-ai version.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

// This module handles constructible catalog providers.
export type PiAiProvider = NonNullable<ResolvedPiAiProviderProfile['piProvider']>

type PiAiAuth = PiAiAdapterOptions['auth']
export type PiAiAuthContext = PiAiAuth['authContext']
export type PiAiCredentialStore = PiAiAuth['credentials']
export type PiAiCredential = NonNullable<Awaited<ReturnType<PiAiCredentialStore['read']>>>
export type PiAiCredentialInfo = Awaited<ReturnType<PiAiCredentialStore['list']>>[number]

type PiAiOAuth = NonNullable<PiAiProvider['auth']['oauth']>
export type PiAiAuthInteraction = Parameters<PiAiOAuth['login']>[0]
export type PiAiAuthPrompt = Parameters<PiAiAuthInteraction['prompt']>[0]
export type PiAiAuthEvent = Parameters<PiAiAuthInteraction['notify']>[0]

interface ProviderCatalogModule {
  builtinProviders(): readonly PiAiProvider[]
}

/** Locate the first pi-ai catalog Node would resolve from dsh-llm-pi-ai. */
function adapterCatalogUrl(): string {
  const adapterManifest = import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')
  const require = createRequire(adapterManifest)
  for (const root of require.resolve.paths('@earendil-works/pi-ai') ?? []) {
    const catalog = join(root, '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js')
    if (existsSync(catalog)) return pathToFileURL(catalog).href
  }
  throw new Error('dsh-auth: dsh-llm-pi-ai has no resolvable pi-ai provider catalog')
}

const catalog = await import(adapterCatalogUrl()) as ProviderCatalogModule

/** Fresh Provider objects from the exact pi-ai module used by dsh-llm-pi-ai. */
export const adapterBuiltinProviders = catalog.builtinProviders
