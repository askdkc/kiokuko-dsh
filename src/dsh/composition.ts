import type { Context } from '@deepseek-ai/cordis'
import { DshEnnoController, type DshTurnStoppingAgent, type DshTurnStoppingContext } from './enno-controller.js'
import { DshIntakeGate, type DshPreStepDecision, type DshPreStepEvent, type DshPreStepContext } from './intake-gate.js'
import { mountDshDurabilityBarriers, mountDshIdleLifecycle, mountDshSessionBridge, type DshIdleLifecycleContext, type DshRunLifecycle, type DshSessionBridge, type DshSessionBridgeContext, type DshSessionRunResolver } from './session-bridge.js'
import { mountDshToolPolicy, type DshToolPolicy } from './tool-policy.js'
import { mountDshModelTools, type DshToolHost, type DshToolRegistrationContext } from './tools.js'
import { DshPonytailModes, mountDshPonytailCommand, type DshPonytailCommandContext } from './commands.js'
import { mountStandardSkillProvider, type DshSkillContext } from './standard-skill-provider.js'
import { mountSoulPrompt } from './prompt-policy.js'
import type { DshUserQuestions } from './user-interaction.js'
import type { DshRuntime } from './runtime.js'

/** The optional, explicit host adapter supplied by a dsh profile. */
export const KIOKUKO_DSH_HOST_SERVICE = 'kiokukoDsh'

export interface DshNativePreStepPayload {
  readonly agent: { readonly id: string }
  readonly messages: readonly unknown[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export interface DshNativeTurnStoppingPayload {
  readonly agent: {
    readonly id: string
    readonly steer: (message: unknown) => void
    readonly cancel?: (reason: unknown) => void
  }
  readonly turn: number
  readonly signal: AbortSignal
}

export interface DshCompositionHost {
  readonly skills?: DshSkillContext['skills']
  readonly systemPrompt?: Parameters<typeof mountSoulPrompt>[0]['systemPrompt']
  readonly runtime?: DshRuntime
  readonly userQuestions?: DshUserQuestions
  readonly commands?: DshPonytailCommandContext['commands']
  readonly ponytailModes?: DshPonytailModes
  readonly tools?: {
    register: DshToolHostRegistration
    guard: (guard: (execution: any) => string | undefined) => () => void
  }
  readonly toolHost?: DshToolHost
  readonly toolPolicy?: DshToolPolicy
  readonly intakeGate?: DshIntakeGate
  readonly mapPreStep?: (payload: DshNativePreStepPayload) => DshPreStepEvent
  readonly bridge?: DshSessionBridge
  readonly resolveSessionRunId?: DshSessionRunResolver
  readonly ennoController?: DshEnnoController
  readonly lifecycle?: DshRunLifecycle
  readonly resolveIdleClose?: (agentId: string) => { readonly runId: string; readonly status: 'completed' | 'failed' | 'cancelled' } | undefined
}

type DshToolHostRegistration = DshToolRegistrationContext['tools']['register']

/** Native registration is structurally compatible with dsh-tools' ToolRuntime. */
function toolRegistration(host: DshCompositionHost): { register: (definition: any) => () => void } | undefined {
  return host.tools === undefined ? undefined : { register: host.tools.register }
}

function mountRuntime(ctx: Context, runtime: DshRuntime): () => void {
  let closed = false
  ctx.effect(() => {
    const started = runtime.start()
    return async () => {
      if (closed) return
      closed = true
      await started.catch(() => undefined)
      await runtime.close()
    }
  }, 'kiokuko-dsh runtime')
  return () => { if (!closed) void runtime.close() }
}

function mountNativeIntakeGate(
  ctx: { on(name: 'agent/pre-step', listener: (payload: DshNativePreStepPayload, next: () => Promise<DshPreStepDecision>) => Promise<DshPreStepDecision>, options?: { readonly prepend?: boolean }): () => void },
  gate: DshIntakeGate,
  mapPreStep: (payload: DshNativePreStepPayload) => DshPreStepEvent,
): () => void {
  return ctx.on('agent/pre-step', (payload: DshNativePreStepPayload, next) => gate.preStep(mapPreStep(payload), next as () => Promise<DshPreStepDecision>), { prepend: true })
}

function mountNativeEnnoController(ctx: DshTurnStoppingContext, controller: DshEnnoController): () => void {
  return (ctx as unknown as { on(name: 'agent/turn-stopping', listener: (payload: DshNativeTurnStoppingPayload) => Promise<void>, options?: { readonly prepend?: boolean }): () => void }).on('agent/turn-stopping', async (payload: DshNativeTurnStoppingPayload) => {
    const agent: DshTurnStoppingAgent = {
      id: payload.agent.id,
      steer: (message) => payload.agent.steer({
        id: `kiokuko-dsh:${payload.agent.id}:${payload.turn}`,
        role: 'user',
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' },
      }),
      ...(payload.agent.cancel === undefined ? {} : { cancel: (reason: string) => payload.agent.cancel!(reason) }),
    }
    await controller.handle({ agent, turn: payload.turn, signal: payload.signal })
  }, { prepend: true })
}

/**
 * Mount every seam for which the profile supplied a real host adapter. The
 * adapter is deliberately explicit: a generic Cordis context cannot invent a
 * repository/run binding or an intake task projection safely.
 */
export function mountDshComposition(ctx: Context, host: DshCompositionHost): () => void {
  const disposers: Array<() => unknown> = []
  if (host.runtime !== undefined) disposers.push(mountRuntime(ctx, host.runtime))
  if (host.skills !== undefined) disposers.push(mountStandardSkillProvider({ skills: host.skills }))
  if (host.systemPrompt !== undefined) {
    const disposer = mountSoulPrompt({ systemPrompt: host.systemPrompt, effect: ctx.effect } as never)
    if (typeof disposer === 'function') disposers.push(() => disposer())
  }
  if (host.commands !== undefined) disposers.push(mountDshPonytailCommand({ commands: host.commands }, host.ponytailModes ?? new DshPonytailModes()))
  const registration = toolRegistration(host)
  if ((registration === undefined) !== (host.toolHost === undefined)) {
    if (host.toolPolicy === undefined) throw new Error('kiokuko-dsh requires a tool policy whenever native tools are mounted')
    if (registration === undefined || host.toolHost === undefined) throw new Error('kiokuko-dsh native tool host is incomplete')
  }
  if (registration !== undefined && host.toolHost !== undefined) {
    if (host.toolPolicy === undefined) throw new Error('kiokuko-dsh requires a monotonic tool policy')
    const tools = host.tools
    if (tools === undefined) throw new Error('kiokuko-dsh native tool registry is incomplete')
    disposers.push(mountDshToolPolicy({
      tools: { guard: tools.guard },
      on: (name, listener, options) => ctx.on(name as never, listener as never, options),
    }, host.toolPolicy))
    disposers.push(mountDshModelTools({ tools: registration }, host.toolHost))
  }
  if (host.intakeGate !== undefined) {
    if (host.mapPreStep === undefined) throw new Error('kiokuko-dsh intake gate requires a native task projection')
    disposers.push(mountNativeIntakeGate(ctx as unknown as Parameters<typeof mountNativeIntakeGate>[0], host.intakeGate, host.mapPreStep))
  }
  if (host.bridge !== undefined) {
    if (host.resolveSessionRunId === undefined) throw new Error('kiokuko-dsh session bridge requires a run resolver')
    disposers.push(mountDshSessionBridge(ctx as unknown as DshSessionBridgeContext, host.bridge, host.resolveSessionRunId))
    disposers.push(mountDshDurabilityBarriers(ctx as never, host.bridge))
  }
  if (host.ennoController !== undefined) disposers.push(mountNativeEnnoController(ctx as unknown as DshTurnStoppingContext, host.ennoController))
  if (host.lifecycle !== undefined) {
    if (host.resolveIdleClose === undefined) throw new Error('kiokuko-dsh idle lifecycle requires a close resolver')
    disposers.push(mountDshIdleLifecycle(ctx as unknown as DshIdleLifecycleContext, host.lifecycle, host.resolveIdleClose))
  }
  return () => { for (const dispose of disposers.reverse()) void dispose() }
}
