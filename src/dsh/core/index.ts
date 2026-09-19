import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { coreSkills } from '../modules/resources.js'
import { synchronizeConfiguredSkills } from './deployment.js'
import { CoreConfig, mountCore, type CoreModuleHost } from './host.js'
import { DshModules, type ModuleRegistration } from './modules.js'
export { CoreConfig as Config, mountCore } from './host.js'
export type { CoreModuleHost } from './host.js'
export * from './modules.js'
export * from './skills.js'
export * from './deployment.js'
export { DshCoreRuntime } from '../core-runtime.js'
export { CoreTasks } from './tasks.js'
export const name = 'kiokuko-dsh'
export const inject = ['skills', 'systemPrompt', 'tools', 'sessions', 'agents'] as const
export function createConfiguredPlugin(registrations: readonly ModuleRegistration<CoreModuleHost>[]) {
  const Config = CoreConfig.extend({ modules: z.record(z.string(), z.unknown()).optional() })
  const required = [...new Set([...inject, ...registrations.flatMap(entry => entry.module.requires)])]
  return { name, inject: required, Config, async apply(ctx: Context, input: z.input<typeof Config>): Promise<void> {
    const { modules: settings = {}, ...config } = Config.parse(input)
    if (!config.enabled) return
    for (const capability of required) if (!ctx.get(capability, false)) throw new Error(`Missing native service: ${capability}`)
    for (const id of Object.keys(settings)) if (!registrations.some(entry => entry.module.id === id)) throw new Error(`Unconfigured module: ${id}`)
    const selected = registrations.map(entry => Object.hasOwn(settings, entry.module.id) ? { ...entry, configuration: settings[entry.module.id] } : entry)
    const all = [{ module: coreSkills }, ...selected]
    const capabilities = [...new Set(all.flatMap(entry => entry.module.requires))].filter(capability => ctx.get(capability, false))
    const validated = new DshModules(all, capabilities)
    await synchronizeConfiguredSkills(validated.resources())
    await ctx.effect(async () => { const handle = await mountCore(ctx, config, selected); return handle.dispose }, 'kiokuko core')
  } }
}
export async function apply(ctx: Context, config: CoreConfig): Promise<void> {
  await createConfiguredPlugin([]).apply(ctx, config)
}
