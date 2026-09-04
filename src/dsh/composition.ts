import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DshEnnoController, type DshTurnStoppingAgent, type DshTurnStoppingContext } from './enno-controller.js'
import { DshIntakeGate, type DshPreStepDecision, type DshPreStepEvent, type DshPreStepContext } from './intake-gate.js'
import { mountDshIdleLifecycle, mountDshSessionLifecycle, type DshCloseIntent, type DshIdleLifecycleContext, type DshNativeSession, type DshRunLifecycle, type DshSessionLifecycleContext } from './session-bridge.js'
import { mountDshToolPolicy, type DshToolPolicy } from './tool-policy.js'
import { mountDshModelTools, type DshToolHost, type DshToolRegistrationContext } from './tools.js'
import { DshPonytailModes, mountDshPonytailCommand, type DshPonytailCommandContext } from './commands.js'
import { mountStandardSkillProvider, type DshSkillContext } from './standard-skill-provider.js'
import { mountSoulPrompt } from './prompt-policy.js'
import type { DshUserQuestions } from './user-interaction.js'
import type { DshRuntime } from './runtime.js'
import type { DshMemoryFinalizer } from './session-memory-finalizer.js'

/** The optional, explicit host adapter supplied by a dsh profile. */
export const KIOKUKO_DSH_HOST_SERVICE = 'kiokukoDsh'

export interface DshNativePreStepPayload {
  readonly agent: {
    readonly id: string
    readonly session?: DshNativeSession
    readonly sessionId?: string
  }
  readonly messages: readonly unknown[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export interface DshNativeTurnStoppingPayload {
  readonly agent: {
    readonly id: string
    readonly session?: { readonly id: string }
    readonly sessionId?: string
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
  readonly runtimeOwner?: 'composition' | 'host'
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
  readonly mapPreStep?: (payload: DshNativePreStepPayload) => DshPreStepEvent | PromiseLike<DshPreStepEvent>
  /** Read-only exact active run binding; never used to mirror session events. */
  readonly resolveSessionRunId?: (session: { readonly id: string }) => string | undefined
  readonly memoryFinalizer?: Pick<DshMemoryFinalizer, 'start' | 'dispose' | 'whenIdle'>
  readonly memoryFinalizerOwner?: 'composition' | 'host'
  readonly ennoController?: DshEnnoController
  readonly lifecycle?: DshRunLifecycle
  readonly lifecycleOwner?: 'composition' | 'host'
  readonly resolveIdleClose?: (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object) => DshCloseIntent | PromiseLike<DshCloseIntent | undefined> | undefined
  readonly resolveSessionClose?: (sessionId: string, nativeSession: object) => DshCloseIntent | PromiseLike<DshCloseIntent | undefined> | undefined
}

type DshToolHostRegistration = DshToolRegistrationContext['tools']['register']

/** Native registration is structurally compatible with dsh-tools' ToolRuntime. */
function toolRegistration(host: DshCompositionHost): { register: (definition: any) => () => void } | undefined {
  return host.tools === undefined ? undefined : { register: host.tools.register }
}

type DshDisposer = () => unknown

export interface DshCompositionHandle {
  /** Stop all event, command, tool, and session ingress synchronously. */
  readonly stopIngress: () => void
  /** Finish resource teardown after ingress has been stopped. */
  readonly dispose: () => Promise<void>
}

async function mountRuntime(runtime: DshRuntime): Promise<DshDisposer> {
  let closed = false
  await runtime.start()
  return async () => {
    if (closed) return
    closed = true
    await runtime.close()
  }
}

function mountNativeIntakeGate(
  ctx: { on(name: 'agent/pre-step', listener: (payload: DshNativePreStepPayload, next: () => Promise<DshPreStepDecision>) => Promise<DshPreStepDecision>, options?: { readonly prepend?: boolean }): () => void },
  gate: DshIntakeGate,
  mapPreStep: (payload: DshNativePreStepPayload) => DshPreStepEvent | PromiseLike<DshPreStepEvent>,
): () => void {
  return ctx.on('agent/pre-step', async (payload: DshNativePreStepPayload, next) => gate.preStep(await mapPreStep(payload), next as () => Promise<DshPreStepDecision>), { prepend: true })
}

function mountNativeEnnoController(ctx: DshTurnStoppingContext, controller: DshEnnoController): () => void {
  return (ctx as unknown as { on(name: 'agent/turn-stopping', listener: (payload: DshNativeTurnStoppingPayload) => Promise<void>, options?: { readonly prepend?: boolean }): () => void }).on('agent/turn-stopping', async (payload: DshNativeTurnStoppingPayload) => {
    const agent: DshTurnStoppingAgent = {
      id: payload.agent.id,
      nativeAgent: payload.agent,
      ...(payload.agent.session?.id === undefined && payload.agent.sessionId === undefined ? {} : { sessionId: payload.agent.session?.id ?? payload.agent.sessionId }),
      ...(payload.agent.session === undefined ? {} : { nativeSession: payload.agent.session as object }),
      steer: (message) => payload.agent.steer({
        id: randomUUID(),
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
export async function mountDshComposition(ctx: Context, host: DshCompositionHost): Promise<DshCompositionHandle> {
  const ingressDisposers: DshDisposer[] = []
  const cleanupDisposers: DshDisposer[] = []
  const setupResourceDisposers: DshDisposer[] = []
  const stopErrors: unknown[] = []
  let ingressStopped = false
  let disposePromise: Promise<void> | undefined

  const stopIngress = (): void => {
    if (ingressStopped) return
    ingressStopped = true
    for (const dispose of ingressDisposers.reverse()) {
      try { dispose() } catch (error) { stopErrors.push(error) }
    }
  }

  const runCleanup = async (): Promise<void> => {
    const failures = [...stopErrors]
    for (const dispose of cleanupDisposers.reverse()) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh composition disposal failed')
  }

  const runSetupCleanup = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const dispose of setupResourceDisposers.reverse()) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh composition setup cleanup failed')
  }

  try {
    if (host.runtime !== undefined) {
      const disposer = await mountRuntime(host.runtime)
      setupResourceDisposers.push(disposer)
      if (host.runtimeOwner !== 'host') cleanupDisposers.push(disposer)
    }
    if (host.memoryFinalizer !== undefined) {
      await host.memoryFinalizer.start()
      const closeFinalizer = async () => host.memoryFinalizer!.dispose()
      setupResourceDisposers.push(closeFinalizer)
      if (host.memoryFinalizerOwner !== 'host') cleanupDisposers.push(closeFinalizer)
    }
    if (host.skills !== undefined) {
      const disposer = mountStandardSkillProvider({ skills: host.skills })
      setupResourceDisposers.push(disposer)
      cleanupDisposers.push(disposer)
    }
    if (host.systemPrompt !== undefined) {
      const disposer = mountSoulPrompt({ systemPrompt: host.systemPrompt, effect: ctx.effect } as never)
      if (typeof disposer === 'function') {
        const cleanup = () => disposer()
        setupResourceDisposers.push(cleanup)
        cleanupDisposers.push(cleanup)
      }
      await disposer
    }
    if (host.commands !== undefined) ingressDisposers.push(mountDshPonytailCommand({ commands: host.commands }, host.ponytailModes ?? new DshPonytailModes()))
    const registration = toolRegistration(host)
    if ((registration === undefined) !== (host.toolHost === undefined)) {
      if (host.toolPolicy === undefined) throw new Error('kiokuko-dsh requires a tool policy whenever native tools are mounted')
      if (registration === undefined || host.toolHost === undefined) throw new Error('kiokuko-dsh native tool host is incomplete')
    }
    if (registration !== undefined && host.toolHost !== undefined) {
      if (host.toolPolicy === undefined) throw new Error('kiokuko-dsh requires a monotonic tool policy')
      const tools = host.tools
      if (tools === undefined) throw new Error('kiokuko-dsh native tool registry is incomplete')
      ingressDisposers.push(mountDshToolPolicy({
        tools: { guard: tools.guard },
        on: (name, listener, options) => ctx.on(name as never, listener as never, options),
      }, host.toolPolicy))
      ingressDisposers.push(mountDshModelTools({ tools: registration }, host.toolHost))
    }
    if (host.intakeGate !== undefined) {
      if (host.mapPreStep === undefined) throw new Error('kiokuko-dsh intake gate requires a native task projection')
      ingressDisposers.push(mountNativeIntakeGate(ctx as unknown as Parameters<typeof mountNativeIntakeGate>[0], host.intakeGate, host.mapPreStep))
    }
    if (host.ennoController !== undefined) ingressDisposers.push(mountNativeEnnoController(ctx as unknown as DshTurnStoppingContext, host.ennoController))
    if (host.lifecycle !== undefined) {
      if (host.resolveIdleClose === undefined) throw new Error('kiokuko-dsh idle lifecycle requires a close resolver')
      const nativeSessions = (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get('sessions', false) as {
        flush?: (session: unknown) => PromiseLike<unknown>
      } | undefined
      if (nativeSessions?.flush === undefined) throw new Error('kiokuko-dsh lifecycle requires the native DSH session flush service')
      ingressDisposers.push(mountDshIdleLifecycle(
        ctx as unknown as DshIdleLifecycleContext,
        host.lifecycle,
        host.resolveIdleClose,
        async (session) => { await nativeSessions.flush!(session) },
      ))
      if (host.resolveSessionClose !== undefined) {
        ingressDisposers.push(mountDshSessionLifecycle(
          ctx as unknown as DshSessionLifecycleContext,
          host.lifecycle,
          host.resolveSessionClose,
          async (session) => { await nativeSessions.flush!(session) },
        ))
      }
      if (host.lifecycleOwner !== 'host') cleanupDisposers.push(() => host.lifecycle!.dispose())
    }
  } catch (error) {
    stopIngress()
    try { await runSetupCleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'kiokuko-dsh composition setup failed') }
    throw error
  }

  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    stopIngress()
    disposePromise = runCleanup()
    return disposePromise
  }
  return { stopIngress, dispose } as DshCompositionHandle
}
