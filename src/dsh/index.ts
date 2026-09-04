import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as DshConfig } from './config.js'
import type { DshRuntime } from './runtime.js'
import { KIOKUKO_DSH_HOST_SERVICE, mountDshComposition, type DshCompositionHost } from './composition.js'
import { createDshHostAdapter } from './host-adapter.js'

/** Public Cordis plugin name mounted by the dsh bundle patch. */
export const name = 'kiokuko-dsh'

/** This bootstrap plugin has no service prerequisites. */
export const inject = [] as const

export { Config }
export type { DshConfig }
export { DshRuntime } from './runtime.js'
export type * from './agent-state.js'
export type * from './runtime.js'
export * from './capability-catalog.js'
export type { DshResumeDecision } from './continuation.js'
export * from './intake-profile-resolver.js'
export * from './intake-gate.js'
export * from './user-interaction.js'
export * from './message-sources.js'
export * from './context-injection.js'
export * from './directive-projection.js'
export * from './tools.js'
export * from './tool-policy.js'
export * from './composition.js'
export * from './host-adapter.js'
export * from './session-memory-finalizer.js'
export * from './session-log-mirror.js'
export * from './session-log-export.js'
export * from './session-log-surface.js'
export * from './turn-process.js'
export * from './boundary-worker.js'
export * from './input-claim.js'
export * from './prompt-cache.js'

/** Mount a runtime as a Cordis-owned effect; unload always drains it. */
export function mountDshRuntime(ctx: Context, runtime: DshRuntime): ReturnType<Context['effect']> {
  return ctx.effect(async () => {
    await runtime.start()
    return async () => {
      await runtime.close()
    }
  }, 'kiokuko-dsh runtime')
}

/**
 * Start the dsh integration boundary. A profile may provide the explicit
 * `kiokukoDsh` host adapter when it owns runtime/run resolution. The basic
 * services are also discovered directly so a normal Cordis composition gets
 * the bundled provider and SOUL prompt without a second plugin.
 */
export async function apply(ctx: Context, config: DshConfig): Promise<void> {
  if (!config.enabled) return

  console.info('[kiokuko-dsh] plugin loaded')
  await ctx.effect(async () => {
    const host = ctx.get(KIOKUKO_DSH_HOST_SERVICE, false) as DshCompositionHost | undefined
    if (host !== undefined) {
      const composition = await mountDshComposition(ctx, host)
      const disposeExport = host.sessionExport === undefined
        ? undefined
        : (await import('./session-log-surface.js')).mountDshSessionExportSurface(ctx, host.sessionExport)
      return async () => {
        composition.stopIngress()
        await disposeExport?.()
        await composition.dispose()
      }
    }
    const runtimeServices = [ctx.get('tools', false), ctx.get('sessions', false), ctx.get('agents', false)]
    // A deliberately minimal composition may expose only the prompt/Skill
    // plane. A partially installed runtime plane is different: mounting it as
    // prompt-only would silently drop run/session/tool safety boundaries.
    if (runtimeServices.every((service) => service === undefined)) {
      const composition = await mountDshComposition(ctx, {
        ...(ctx.get('skills', false) === undefined ? {} : { skills: ctx.get('skills', false) as DshCompositionHost['skills'] }),
        ...(ctx.get('systemPrompt', false) === undefined ? {} : { systemPrompt: ctx.get('systemPrompt', false) as DshCompositionHost['systemPrompt'] }),
      } as DshCompositionHost)
      return () => composition.dispose()
    }
    if (runtimeServices.some((service) => service === undefined)) {
      throw new Error('kiokuko-dsh native tools, sessions, and agents must be provided together')
    }
    const adapter = createDshHostAdapter(ctx)
    const composition = await mountDshComposition(ctx, adapter.host)
    const disposeExport = adapter.host.sessionExport === undefined
      ? undefined
      : (await import('./session-log-surface.js')).mountDshSessionExportSurface(ctx, adapter.host.sessionExport)
    return async () => {
      composition.stopIngress()
      const failures: unknown[] = []
      try { await disposeExport?.() } catch (error) { failures.push(error) }
      try { await adapter.dispose() } catch (error) { failures.push(error) }
      try { await composition.dispose() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh unload failed')
    }
  }, 'kiokuko-dsh composition')
}
