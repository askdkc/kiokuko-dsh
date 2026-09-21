import type { SemanticCompactionCoordinator } from './semantic-compaction/coordinator.js'
import { mountDecisionCommand } from './decisions/host.js'
import type { DecisionService } from './decisions/service.js'
import { formatEvolutionStatus } from '../memory/evolution/status.js'
import type { mountLispSurface } from './lisp/surface.js'
import { mountTypeSafeCommand, typeSafeCredentials } from './typesafe/command.js'
import { ExecutionSelectionPending } from './model-selection-ui.js'
import type { LispConfiguration } from './lisp/contracts.js'
import { mountDeepReportSurface } from '../deep-thinker/report-surface.js'
import { mountDshNoticeSurface } from './session-notice-surface.js'
import { mountSessionHistoryCompatibility, type SessionHistoryCheck } from './session-history-compatibility.js'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DshSkillPrompts } from './skill-prompts.js'
import { DshEnnoController, type DshTurnStoppingAgent, type DshTurnStoppingContext } from './enno-controller.js'
import { DshIntakeGate, type DshPreStepDecision, type DshPreStepEvent, type DshPreStepContext } from './intake-gate.js'
import { mountDshIdleLifecycle, mountDshSessionLifecycle, type DshCloseIntent, type DshIdleLifecycleContext, type DshNativeSession, type DshRunLifecycle, type DshSessionLifecycleContext } from './session-bridge.js'
import { mountDshToolPolicy, type DshToolPolicy } from './tool-policy.js'
import { mountDshModelTools, type DshToolHost, type DshToolRegistrationContext } from './tools.js'
import { DshPonytailModes, mountDshPonytailCommand, type DshPonytailCommandContext } from './commands.js'
import { mountStandardSkillProvider, type DshSkillContext } from './standard-skill-provider.js'
import { mountSoulPrompt } from './prompt-policy.js'
import type { DshUserQuestions } from './user-interaction.js'
import type { DshCoreRuntime as DshRuntime } from './core-runtime.js'
import type { DshMemoryFinalizer } from './session-memory-finalizer.js'
import type { DshMirrorCheckpoint } from './session-log-mirror.js'
import type { DshBoundaryWorker } from './boundary-worker.js'
import type { DshSessionLogExportService } from './session-log-export.js'

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
  readonly decisions?: DecisionService
  readonly semanticCompaction?: SemanticCompactionCoordinator
  readonly skillPrompts?: DshSkillPrompts
  readonly configureSkillPrompts?: (prompts: DshSkillPrompts) => void
  readonly configureEnnoMemory?: (config: import('./config.js').EnnoMemoryConfig) => void
  readonly deepPlanning?: import('../deep-thinker/controller.js').DeepPlanningController
  readonly memoryReview?: { start?:()=>Promise<void>; configure:(config:import('../memory/review/contracts.js').ReviewConfig)=>Promise<void>; command:(session:DshNativeSession,raw:string)=>Promise<Record<string,unknown>> }
  readonly memoryEvolution?: { configure: (config: import('../memory/evolution/contracts.js').EvolutionConfig) => void; status: (sessionId: string) => Promise<Record<string, unknown>> }
  readonly efficiency?: import('./efficiency.js').DshEfficiencyObserver | undefined
  readonly configureEfficiency?: (config: { observe: boolean; inputMode: import('./efficiency.js').FinalizationInputMode }) => void
  readonly orca?: import('./orca-types.js').DshOrcaHostServices
  readonly skills?: DshSkillContext['skills']
  readonly systemPrompt?: Parameters<typeof mountSoulPrompt>[0]['systemPrompt']
  readonly runtime?: DshRuntime
  readonly runtimeOwner?: 'composition' | 'host' | 'external'
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
  readonly sessionMirror?: { readonly start: () => Promise<void>; readonly close: () => Promise<void> }
  readonly sessionMirrorOwner?: 'composition' | 'host'
  readonly sessionExport?: DshSessionLogExportService
  readonly checkpointSessionMirror?: (session: DshNativeSession) => PromiseLike<DshMirrorCheckpoint>
  readonly ennoController?: DshEnnoController
  readonly boundaryWorker?: Pick<DshBoundaryWorker, 'kick' | 'dispose' | 'whenIdle'>
  readonly boundaryWorkerOwner?: 'composition' | 'host'
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
  readonly drainLisp: () => Promise<void>
  /** Startup validation of all persisted session IDs, also run after plugin reload/update. */
  readonly historyCheck: Promise<SessionHistoryCheck>
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
  worker?: Pick<DshBoundaryWorker, 'kick'>,
  deep?: import('../deep-thinker/controller.js').DeepPlanningController,
): () => void {
  return ctx.on('agent/pre-step', async (payload: DshNativePreStepPayload, next) => {
    if (deep?.executor.isChild(payload.agent)) return next()
    if (await deep?.preStep(payload)) {
      void deep!.kick(payload.agent).catch(() => {})
      return { kind: 'reject', reason: 'Deep owns and has preserved this input.' }
    }
    let mapped: DshPreStepEvent
    try { mapped = await mapPreStep(payload) } catch (error) {
      if (error instanceof ExecutionSelectionPending) return { kind: 'reject' }
      // Mapping is optional host preparation. In particular, an earlier
      // degraded first step must not break the next native tool/model step.
      return next()
    }
    const decision = await gate.preStep(mapped, next as () => Promise<DshPreStepDecision>)
    // CapturingGate has now applied human-input precedence and stale-outbox
    // supersession. Only after that point may recovery work be kicked.
    worker?.kick(payload.agent.session?.id ?? payload.agent.sessionId, payload.agent)
    return decision
  }, { prepend: true })
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

function mountNativeBoundaryKick(
  ctx: { on(name: string, listener: (payload: DshNativeTurnStoppingPayload) => void, options?: { readonly prepend?: boolean }): () => void },
  worker: Pick<DshBoundaryWorker, 'kick'>,
): readonly (() => void)[] {
  const kick = (payload: DshNativeTurnStoppingPayload): void => {
    // No validation, LLM call, context construction, or delivery is allowed
    // inside the native turn-stopping callback. The durable worker owns it.
    worker.kick(payload.agent.session?.id ?? payload.agent.sessionId, payload.agent)
  }
  return [
    ctx.on('agent/turn-stopping', kick, { prepend: true }),
    ctx.on('agent/idle', kick),
  ]
}

/**
 * Mount every seam for which the profile supplied a real host adapter. The
 * adapter is deliberately explicit: a generic Cordis context cannot invent a
 * repository/run binding or an intake task projection safely.
 */
export async function mountDshComposition(ctx: Context, host: DshCompositionHost, lisp?: LispConfiguration, prompts = host.skillPrompts ?? new DshSkillPrompts(), options: { typeSafeCommand?: boolean } = {}): Promise<DshCompositionHandle> {
  if (host.configureSkillPrompts) host.configureSkillPrompts(prompts)
  else if (prompts.mode === 'compiled' && (host.intakeGate || host.toolHost || host.deepPlanning)) {
    throw new Error('The explicit Kiokuko runtime host must implement configureSkillPrompts for compiled delivery')
  }
  let lispSurface: Awaited<ReturnType<typeof mountLispSurface>> | undefined
  let lispDrain: Promise<void> | undefined
  const drainLisp = () => lispDrain ??= lispSurface?.dispose() ?? Promise.resolve()
  const ingressDisposers: DshDisposer[] = []
  const cleanupDisposers: DshDisposer[] = []
  const setupResourceDisposers: DshDisposer[] = []
  const stopErrors: unknown[] = []
  let ingressStopped = false
  let disposePromise: Promise<void> | undefined
  let historyCheck: Promise<SessionHistoryCheck>

  const stopIngress = (): void => {
    if (ingressStopped) return
    ingressStopped = true
    host.semanticCompaction?.stop()
    for (const dispose of ingressDisposers.reverse()) {
      try { dispose() } catch (error) { stopErrors.push(error) }
    }
  }

  const runCleanup = async (): Promise<void> => {
    await host.semanticCompaction?.drain()
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
    await host.decisions?.initialize()
    if (host.commands && host.decisions && options.typeSafeCommand !== false) ingressDisposers.push(mountDecisionCommand(host.commands, host.decisions))
    if (host.commands && options.typeSafeCommand !== false) ingressDisposers.push(mountTypeSafeCommand(host.commands, typeSafeCredentials(ctx), () => host.decisions?.invalidateReadiness()))
    const historyCompatibility = mountSessionHistoryCompatibility(ctx)
    historyCheck = historyCompatibility.ready
    ingressDisposers.push(historyCompatibility.stop)
    setupResourceDisposers.push(historyCompatibility.dispose)
    cleanupDisposers.push(historyCompatibility.dispose)
    if (host.deepPlanning && host.commands) ingressDisposers.push(host.commands.register(host.deepPlanning.command()))
    if (host.deepPlanning) ingressDisposers.push(mountDeepReportSurface(ctx, host.deepPlanning))
    if (host.deepPlanning) ingressDisposers.push(mountDshNoticeSurface(ctx, host.deepPlanning))
    if (host.runtime !== undefined) {
      const disposer = await mountRuntime(host.runtime)
      if (host.runtimeOwner !== 'external') setupResourceDisposers.push(disposer)
      if (!host.runtimeOwner || host.runtimeOwner === 'composition') cleanupDisposers.push(disposer)
      if (lisp && (lisp.enabled || await host.runtime.withDatabase(db => Boolean(db.prepare('SELECT session_id FROM dsh_lisp_sessions WHERE enabled=1 LIMIT 1').get())))) {
        const { mountLispSurface } = await import('./lisp/surface.js')
        lispSurface = await mountLispSurface(ctx, host.runtime, lisp, prompts, host.decisions, host.semanticCompaction)
        ingressDisposers.push(() => lispSurface?.stop())
        cleanupDisposers.push(drainLisp)
        setupResourceDisposers.push(drainLisp)
      }
    }
    else if (lisp?.enabled) throw new Error('Lisp requires the DSH runtime')
    if (host.sessionMirror !== undefined) {
      await host.sessionMirror.start()
      const closeMirror = async () => host.sessionMirror!.close()
      setupResourceDisposers.push(closeMirror)
      if (host.sessionMirrorOwner !== 'host') cleanupDisposers.push(closeMirror)
    }
    await host.memoryReview?.start?.()
    if (host.memoryFinalizer !== undefined) {
      await host.memoryFinalizer.start()
      const closeFinalizer = async () => host.memoryFinalizer!.dispose()
      setupResourceDisposers.push(closeFinalizer)
      if (host.memoryFinalizerOwner !== 'host') cleanupDisposers.push(closeFinalizer)
    }
    if(host.memoryReview&&host.commands){
      ingressDisposers.push(host.commands.register({name:'kioku-memory-review',description:'Automatic memory review: status [--json], run, retry <job-id>, retry-finalizer <run-id>, exclude session',
        handler:async invocation=>{
          const session=invocation.agent?.session
          if(!session)return {kind:'error',text:'このセッションで /kioku-memory-review status を実行してください。'}
          try{
            const result=await host.memoryReview!.command(session,invocation.rawInput)
            return {kind:'success',text:invocation.rawInput.includes('--json')?JSON.stringify(result):formatMemoryReviewStatus(result)}
          }catch(error){const code=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'review_unavailable';return {kind:'error',text:`自動メモリ操作を実行できません（${code}）。/kioku-memory-review status --json で状態を確認してください。`}}
        }}))
    }
    if (host.memoryEvolution && host.commands) {
      ingressDisposers.push(host.commands.register({ name: 'kioku-evolution', description: 'Memory evolution status for this project',
        handler: async invocation => {
          const sessionId = invocation.agent?.session?.id ?? invocation.agent?.sessionId
          if (!sessionId || !['', 'status', 'status --json'].includes(invocation.rawInput.trim())) return { kind: 'error', text: 'Use /kioku-evolution status [--json] in the current session.' }
          try {
            const status = await host.memoryEvolution!.status(sessionId)
            return { kind: 'success', text: invocation.rawInput.includes('--json') ? JSON.stringify(status) :
              formatEvolutionStatus(status) }
          } catch { return { kind: 'error', text: 'このセッションの記憶学習状態を取得できません。' } }
        },
      }))
    }
    if (host.boundaryWorker !== undefined) {
      host.boundaryWorker.kick()
      const closeBoundaryWorker = async () => host.boundaryWorker!.dispose()
      setupResourceDisposers.push(closeBoundaryWorker)
      if (host.boundaryWorkerOwner !== 'host') cleanupDisposers.push(closeBoundaryWorker)
    }
    if (host.skills !== undefined) {
      const disposer = mountStandardSkillProvider({ skills: host.skills }, prompts)
      setupResourceDisposers.push(disposer)
      cleanupDisposers.push(disposer)
    }
    if (host.systemPrompt !== undefined) {
      const disposer = mountSoulPrompt({ systemPrompt: host.systemPrompt, effect: ctx.effect } as never, prompts)
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
      ingressDisposers.push(mountNativeIntakeGate(ctx as unknown as Parameters<typeof mountNativeIntakeGate>[0], host.intakeGate, host.mapPreStep, host.boundaryWorker, host.deepPlanning))
    }
    if (host.boundaryWorker !== undefined && host.ennoController !== undefined) {
      throw new Error('kiokuko-dsh must not mount both the durable boundary worker and the legacy turn-stopping controller')
    }
    if (host.boundaryWorker !== undefined) {
      ingressDisposers.push(...mountNativeBoundaryKick(ctx as unknown as Parameters<typeof mountNativeBoundaryKick>[0], host.boundaryWorker))
    } else if (host.ennoController !== undefined) {
      ingressDisposers.push(mountNativeEnnoController(ctx as unknown as DshTurnStoppingContext, host.ennoController))
    }
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
        async (session) => {
          await nativeSessions.flush!(session)
          try { await host.checkpointSessionMirror?.(session) } catch { /* cache is non-vetoing */ }
        },
      ))
      if (host.resolveSessionClose !== undefined) {
        ingressDisposers.push(mountDshSessionLifecycle(
          ctx as unknown as DshSessionLifecycleContext,
          host.lifecycle,
          host.resolveSessionClose,
          async (session) => {
            await nativeSessions.flush!(session)
            try { await host.checkpointSessionMirror?.(session) } catch { /* cache is non-vetoing */ }
          },
        ))
      }
      if (host.lifecycleOwner !== 'host') cleanupDisposers.push(() => host.lifecycle!.dispose())
    }
  } catch (error) {
    stopIngress()
    const setupFailures = [error]
    try { await host.orca?.shutdown() } catch (cleanupError) { setupFailures.push(cleanupError) }
    try { await runSetupCleanup() } catch (cleanupError) { setupFailures.push(cleanupError) }
    if (setupFailures.length > 1) throw new AggregateError(setupFailures, 'kiokuko-dsh composition setup failed')
    throw error
  }

  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    stopIngress()
    disposePromise = runCleanup()
    return disposePromise
  }
  return { stopIngress, dispose, historyCheck, drainLisp } as DshCompositionHandle
}

function formatMemoryReviewStatus(value:Record<string,unknown>):string {
  if(value.message)return String(value.message)
  if(value.jobId)return `レビューを予約しました: ${value.jobId}（${value.state}）。/kioku-memory-review status で結果を確認できます。`
  if(!value.states)return `自動メモリ: ${value.state??'unknown'}`
  const jobs=value.jobs as {id:string;state:string;reason:string|null;retryAvailable:boolean}[]
  return [`自動メモリ: ${value.effectiveMode} / 本日の呼び出し ${value.dailyCalls}、残り ${value.remaining}`,
    `会話の保存方針: ${(value.capture as {mode:string}).mode}`,
    ...jobs.slice(0,10).map(j=>`${j.id}: ${j.state}${j.reason?` (${j.reason})`:''}${j.retryAvailable?`\n再評価: /kioku-memory-review retry ${j.id}`:''}`),
    '詳細: /kioku-memory-review status --json', '保存除外: /kioku-memory-review exclude session'].join('\n')
}
