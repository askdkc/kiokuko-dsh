import { SemanticCompactionCoordinator } from './semantic-compaction/coordinator.js'
import { realpathSync } from 'node:fs'
import { createDecisionService } from './decisions/host.js'
import { startupRecoveryMessage } from './startup-recovery.js'
import { mountDshOrcaCommand } from './orca-command-surface.js'
import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as DshConfig } from './config.js'
import type { DshRuntime } from './runtime.js'
import { KIOKUKO_DSH_HOST_SERVICE, mountDshComposition, type DshCompositionHost } from './composition.js'
import { createDshHostAdapter } from './host-adapter.js'
import { ModelHandoff } from './model-handoff.js'
import { setupDshOnLoad } from './setup.js'
import { DshSkillPrompts } from './skill-prompts.js'
export { DshSkillPrompts } from './skill-prompts.js'
export * from './skill-prompt-contracts.js'
export { compileSkillBundle, compileSkillResource } from './skill-compiler.js'

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
export * from './tool-exposure.js'
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
export * from './efficiency.js'
export * from './finalization-request.js'

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
  try { await startDshPlugin(ctx, config) } catch (error) {
    console.error('[kiokuko-dsh] [crit] Plugin startup failed:', error instanceof Error ? error.message : String(error))
    console.error(startupRecoveryMessage(process.argv, ctx.baseUrl))
    throw error
  }
}

async function startDshPlugin(ctx: Context, config: DshConfig): Promise<void> {
  const resolvedConfig = Config.parse(config)
  if (!resolvedConfig.enabled) return
  const skillPrompts = new DshSkillPrompts(resolvedConfig.skillPrompts)

  console.info('[kiokuko-dsh] [info] plugin loaded')
  await ctx.effect(async () => {
    await setupDshOnLoad()
    let host = ctx.get(KIOKUKO_DSH_HOST_SERVICE, false) as DshCompositionHost | undefined
    if (host !== undefined) {
      if (resolvedConfig.modelAutoMode.mode !== 'off' && !host.modelAuto)
        throw new Error('The explicit Kiokuko host does not support modelAutoMode')
      if (host.runtime && !host.decisions) {
        const decisions = createDecisionService(ctx, host.runtime, resolvedConfig.typedDecisions, resolvedConfig.memoryReuse, resolvedConfig.semanticCompaction)
        host.intakeGate?.configureDecisions(decisions)
        host = { ...host, decisions }
      }
      if (resolvedConfig.answerReview.mode === 'auto') host.decisions?.reportAnswerReview({ ...resolvedConfig.answerReview, state: 'skipped', reason: 'native_capability_unavailable' })
      if (host.decisions && !host.semanticCompaction) host = { ...host, semanticCompaction: new SemanticCompactionCoordinator(ctx as any, host.decisions, realpathSync(process.cwd()), resolvedConfig.observationPack) }
      const modelHandoff = host.decisions ? new ModelHandoff(ctx as any, host.decisions, realpathSync(process.cwd()), resolvedConfig.modelHandoff) : undefined
      if (host.configureEnnoMemory) host.configureEnnoMemory(resolvedConfig.ennoMemory)
      else if (resolvedConfig.ennoMemory.mode !== 'off') throw new Error('The explicit Kiokuko host does not support ennoMemory')
      host.intakeGate?.configureMemory(resolvedConfig.akinatorMemory)
      host.memoryEvolution?.configure(resolvedConfig.memoryEvolution)
      host.autoGlobalization?.configure(resolvedConfig.autoGlobalization.enabled)
      await host.memoryReview?.configure(resolvedConfig.memoryReview)
      if (host.configureEfficiency !== undefined) host.configureEfficiency({ observe: resolvedConfig.efficiency.observe, inputMode: resolvedConfig.finalization.inputMode })
      else if (resolvedConfig.efficiency.observe || resolvedConfig.finalization.inputMode !== 'prefix_reuse') {
        throw new Error('The explicit Kiokuko host does not support efficiency/finalization configuration')
      }
      if (host.configureToolExposure !== undefined) host.configureToolExposure(resolvedConfig.toolExposure)
      else if (resolvedConfig.toolExposure.mode !== 'full' && (host.tools !== undefined || host.toolHost !== undefined)) console.warn('[kiokuko-dsh] [warn] toolExposure left the explicit host surface unchanged: unsupported_runtime')
      let composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
      let disposeOrcaCommand: (() => void) | undefined
      let disposeExport: (() => Promise<void>) | undefined
      let shutdown: Promise<void> | undefined
      const shutdownHost = host
      const cleanup = () => shutdown ??= (async () => {
        composition?.stopIngress()
        modelHandoff?.stop()
        disposeOrcaCommand?.()
        const failures: unknown[] = []
        try { await shutdownHost.orca?.shutdown() } catch (error) { failures.push(error) }
        try { await disposeExport?.() } catch (error) { failures.push(error) }
        try { await modelHandoff?.drain() } catch (error) { failures.push(error) }
        try { await composition?.dispose() } catch (error) { failures.push(error) }
        if (failures.length) throw new AggregateError(failures, 'kiokuko-dsh explicit host unload failed')
      })()
      try {
        composition = await mountDshComposition(ctx, host, resolvedConfig.lisp, skillPrompts)
        disposeOrcaCommand = host.commands === undefined ? undefined : mountDshOrcaCommand({ commands: host.commands }, resolvedConfig.orca.enabled, host.orca)
        disposeExport = host.sessionExport === undefined ? undefined
          : (await import('./session-log-surface.js')).mountDshSessionExportSurface(ctx, host.sessionExport)
        return cleanup
      } catch (error) { await cleanup(); throw error }
    }
    const runtimeServices = [ctx.get('tools', false), ctx.get('sessions', false), ctx.get('agents', false)]
    // A deliberately minimal composition may expose only the prompt/Skill
    // plane. A partially installed runtime plane is different: mounting it as
    // prompt-only would silently drop run/session/tool safety boundaries.
    if (runtimeServices.every((service) => service === undefined)) {
      const composition = await mountDshComposition(ctx, {
        ...(ctx.get('skills', false) === undefined ? {} : { skills: ctx.get('skills', false) as DshCompositionHost['skills'] }),
        ...(ctx.get('systemPrompt', false) === undefined ? {} : { systemPrompt: ctx.get('systemPrompt', false) as DshCompositionHost['systemPrompt'] }),
      } as DshCompositionHost, resolvedConfig.lisp, skillPrompts)
      const commands = ctx.get('commands', false) as DshCompositionHost['commands']
      const disposeCommand = commands === undefined ? undefined : mountDshOrcaCommand({ commands }, resolvedConfig.orca.enabled)
      return () => { disposeCommand?.(); return composition.dispose() }
    }
    if (runtimeServices.some((service) => service === undefined)) {
      throw new Error('kiokuko-dsh native tools, sessions, and agents must be provided together')
    }
    const adapter = createDshHostAdapter(ctx, { answerReview: resolvedConfig.answerReview, typedDecisions: resolvedConfig.typedDecisions, memoryReuse: resolvedConfig.memoryReuse, semanticCompaction: resolvedConfig.semanticCompaction, modelHandoff: resolvedConfig.modelHandoff, modelAutoMode: resolvedConfig.modelAutoMode, observationPack: resolvedConfig.observationPack, skillPrompts, deepPlanning: resolvedConfig.deepPlanning, orca: resolvedConfig.orca, toolExposure: resolvedConfig.toolExposure, modelRoutes: resolvedConfig.modelRoutes, diffReview: resolvedConfig.diffReview,
      ennoMemory: resolvedConfig.ennoMemory, akinatorMemory: resolvedConfig.akinatorMemory, efficiency: resolvedConfig.efficiency, continuity: resolvedConfig.continuity, finalization: resolvedConfig.finalization, memoryEvolution: resolvedConfig.memoryEvolution, autoGlobalization: resolvedConfig.autoGlobalization, memoryReview: resolvedConfig.memoryReview })
    let composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
    let disposeOrcaCommand: (() => void) | undefined
    let disposeExport: (() => Promise<void>) | undefined
    let shutdown: Promise<void> | undefined
    const cleanup = () => shutdown ??= (async () => {
      composition?.stopIngress()
      disposeOrcaCommand?.()
      const failures: unknown[] = []
      try { await composition?.drainLisp() } catch (error) { failures.push(error) }
      try { await disposeExport?.() } catch (error) { failures.push(error) }
      try { await adapter.dispose() } catch (error) { failures.push(error) }
      try { await composition?.dispose() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh unload failed')
    })()
    try {
      composition = await mountDshComposition(ctx, adapter.host, resolvedConfig.lisp, skillPrompts)
      disposeOrcaCommand = adapter.host.commands === undefined ? undefined : mountDshOrcaCommand({ commands: adapter.host.commands }, resolvedConfig.orca.enabled, adapter.host.orca)
      disposeExport = adapter.host.sessionExport === undefined ? undefined
        : (await import('./session-log-surface.js')).mountDshSessionExportSurface(ctx, adapter.host.sessionExport)
      return cleanup
    } catch (error) { await cleanup(); throw error }
  }, 'kiokuko-dsh composition')
}

export type * from './orca-types.js'
export { DshOrcaRecorder } from './orca-recorder.js'
export { DshOrcaStore } from './orca-store.js'

export * from '../memory/evolution/contracts.js'

export { DecisionService } from './decisions/service.js'
export type { DecisionProvider, DecisionBatch, DecisionBatchResult, DecisionCapabilities } from './decisions/contracts.js'
