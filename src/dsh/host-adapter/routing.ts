import type { Context } from '@deepseek-ai/cordis'
import { attachmentTypesFromMessages, nativeContextTokens } from '../model-auto/policy.js'
import type { CompactionAgent } from '../semantic-compaction/contracts.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import type { ReviewAgent } from '../answer-review/contracts.js'
import { readExecutionSelection, writeExecutionSelection, type StoredExecutionSelection } from '../execution-selection.js'
import { ExecutionSelectionPending } from '../model-selection-ui.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../lisp/coding-choice.js'
import { LISP_ASSEMBLY_SERVICE, type LispAssemblyService } from '../lisp/request-surface.js'
import { installDshModelRouting, modelRoleForState, isModelAvailabilityFailure, type RoutableAgent } from '../model-routing.js'
import { assertDshModelAdmitted, type DshIntakeGateResult, type DshPreStepEvent } from '../intake-gate.js'
import { hasKnownDshToolPolicyState, type DshToolPolicyState } from '../tool-policy.js'
import { projectToolsForPhase, type ToolExposureConfig } from '../tool-exposure.js'
import type { DshUserQuestionAgent } from '../user-interaction.js'
import { KiokukoError } from '../../errors.js'
import { currentRequestMemory, pruneDshMemorySurface, filterRequestMemory } from '../request-memory.js'
import { createMemoryReviewPresentation } from '../memory-review-presentation.js'
import type { DshNativePreStepPayload } from '../composition.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { ModelAutoCoordinator } from '../model-auto/coordinator.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { SemanticCompactionCoordinator } from '../semantic-compaction/coordinator.js'
import type { DshEnnoDelegation } from '../enno-delegation.js'
import type { DeepPlanningController } from '../../deep-thinker/controller.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { EnnoOdunoState } from '../../enno-oduno/types.js'
import type { TurnRecord } from './turn-state.js'
import { onNativeEvent } from './native-events.js'
import { operationName } from './tool-host.js'
import type { DshToolDefinition } from '../tools.js'
import type { AdapterContext, NativeAgents, NativeSessions, NativeTools } from './native-events.js'

interface RoutingDependencies {
  readonly ctx: Context
  readonly native: AdapterContext
  readonly tools: NativeTools | undefined
  readonly agents: NativeAgents | undefined
  readonly sessions: NativeSessions | undefined
  readonly runtime: DshCoreRuntime
  readonly modelAuto: ModelAutoCoordinator
  readonly answerReview: AnswerReviewCoordinator
  readonly semanticCompaction: SemanticCompactionCoordinator
  readonly delegation: DshEnnoDelegation
  readonly deepPlanning: DeepPlanningController
  readonly getSkillPrompts: () => DshSkillPrompts
  readonly getToolExposureConfig: () => ToolExposureConfig
  readonly reportToolExposureFallback: (reason: string) => void
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly setSelection: (runId: string, selection: StoredExecutionSelection) => void
  readonly hasSelection: (runId: string) => boolean
  readonly getPolicyState: (runId: string) => DshToolPolicyState | undefined
  readonly captureInitialInput: (sessionId: string, turn: number, messages: readonly unknown[]) => Promise<void>
  readonly prepareTurn: (event: DshPreStepEvent) => Promise<DshIntakeGateResult>
  readonly mapPreStep: (payload: DshNativePreStepPayload) => Promise<DshPreStepEvent>
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly readStateForRun: (item: TurnRecord) => Promise<EnnoOdunoState>
}

export function createRouting({
  ctx, native, tools, agents, sessions, runtime, modelAuto, answerReview,
  semanticCompaction, delegation, deepPlanning, getSkillPrompts,
  getToolExposureConfig, reportToolExposureFallback,
  getSelection, setSelection, hasSelection,
  getPolicyState, captureInitialInput, prepareTurn, mapPreStep, currentSession,
  readStateForRun,
}: RoutingDependencies) {
  const systemSkillNames = new WeakMap<object, ReadonlySet<string>>()
  const ownedModelToolDefinitions = new Map<string, { readonly execute: unknown }>()
  const selectionFailures = new Map<string, Promise<void>>()
  const selectionBlocked = new WeakSet<object>()
  const manualModelChanges = new Map<string, Promise<void>>()
  const assemblyClaims = new WeakMap<object, { turn: number; messages: unknown[] }>()
  const markModelUnavailable = (agent: RoutableAgent): Promise<void> => {
    const owner = delegation.parent(agent) ?? agent
    const item = owner.session ? currentSession(owner.session.id) : undefined
    if (!item || getSelection(item.runId)?.value.mode !== 'enno' || !modelRoleForState(item.prepared.ennoOduno)) return Promise.resolve()
    const existing = selectionFailures.get(item.runId)
    if (existing) return existing
    const current = getSelection(item.runId)!
    const value = { ...current.value, status: 'reselect' as const, problem: '選択したモデルで認証・利用上限・モデル利用可否のエラーが発生しました。完了済みの作業を保持しています。次の要求に使う構成を選び直してください。' }
    setSelection(item.runId, { ...current, value })
    const pending = runtime.withDatabase(db => {
      const stored = readExecutionSelection(db, item.runId)
      if (!stored) throw new KiokukoError('INTEGRITY_ERROR', 'Model selection disappeared')
      setSelection(item.runId, writeExecutionSelection(db, item.runId, stored.revision, { ...stored.value, status: 'reselect', problem: value.problem }))
    }).finally(() => selectionFailures.delete(item.runId))
    selectionFailures.set(item.runId, pending)
    return pending
  }
  const routingDisposers = new Map<object, () => void>()
  const installRouting = (agent: RoutableAgent) => {
    if (routingDisposers.has(agent) || !agent.ctx) return
    const releaseToolSurfaceRecording = semanticCompaction.deferToolSurfaceRecording(agent as unknown as CompactionAgent)
    semanticCompaction.attach(agent as unknown as CompactionAgent, async () => {
      const childModel = await delegation.restoreOrPersist(agent)
      if (childModel) {
        const authority = await delegation.authorityFingerprint(agent)
        return { child: delegation.observationBinding(agent), childSessionId: agent.session?.id, model: childModel, authority }
      }
      const header = (agent as unknown as CompactionAgent).session?.header
      if (header?.parentSession || header?.origin === 'subagent' || header?.delegationDepth) return undefined
      const item = agent.session ? currentSession(agent.session.id) : undefined
      return item ? { runId: item.runId, sessionId: item.sessionId, selection: getSelection(item.runId) ?? null,
        state: await readStateForRun(item) } : { sessionId: agent.session?.id }
    })
    const disposeMemory = onNativeEvent(agent.ctx, 'agent/request', async (_event: unknown, next: () => Promise<any>) => {
      const request = await next()
      if (delegation.isChild(agent)) return request
      const prepared = agent.session ? currentSession(agent.session.id)?.prepared : undefined
      if (!prepared || !agent.session) return request
      // A unavailable memory catalog degrades to no owned memory, never to a
      // stale snapshot retained by the native session's historical surface.
      let allowed: ReadonlyMap<string, string> = new Map()
      try { allowed = await runtime.withDatabase(db => currentRequestMemory(db, prepared)) } catch { /* no memory is safer than stale memory */ }
      pruneDshMemorySurface(agent.session, allowed)
      return request
    }, { prepend: true })
    const disposeClaim = onNativeEvent(agent.ctx, 'agent/inbox/claimed', (event: { agent: RoutableAgent; turn: number; message: unknown }) => {
      if (event.agent !== agent) return
      const previous = assemblyClaims.get(agent)
      if (previous?.turn === event.turn) previous.messages.push(event.message)
      else assemblyClaims.set(agent, { turn: event.turn, messages: [event.message] })
    })
    const memoryReviewPresentation = createMemoryReviewPresentation(agent, runtime)
    const disposeMemoryReviewIdle = agent.ctx.on('agent/status', (event: { agent: RoutableAgent; status: string }) => {
      if (event.agent === agent && event.status === 'idle') memoryReviewPresentation.dispose()
    })
    let autoRoute: { runId: string; sessionId: string; binding: import('../model-configuration.js').ModelBinding } | undefined
    const disposeRouting = installDshModelRouting(agent, async signal => {
      autoRoute = undefined
      const deep = await deepPlanning.beforeAssembly(agent, signal)
      if (deep.owned) { memoryReviewPresentation.dispose(); assemblyClaims.delete(agent); return deep.model }
      const childModel = await delegation.restoreOrPersist(agent)
      if (childModel) { memoryReviewPresentation.dispose(); await delegation.assertCurrent(agent); return childModel }
      selectionBlocked.delete(agent)
      const claim = assemblyClaims.get(agent)
      assemblyClaims.delete(agent)
      const current = agent.session ? currentSession(agent.session.id) : undefined
      if (current) await selectionFailures.get(current.runId)
      const turn = claim?.turn ?? current?.turn
      if (turn === undefined) {
        reportToolExposureFallback('pre_step_missing_turn')
        return undefined
      }
      const messages = claim?.messages ?? []
      // DSH claims input before assembly. Persist it before showing any UI so
      // cancellation and restart cannot lose a prompt before the native log append.
      if (agent.session && messages.length) {
        await captureInitialInput(agent.session.id, turn, messages)
      }
      let admitted: DshIntakeGateResult | undefined
      try {
        const event = await mapPreStep({ agent, messages, turn, step: 0, signal })
        admitted = await prepareTurn(event)
      } catch (error) {
        if (error instanceof ExecutionSelectionPending) { selectionBlocked.add(agent); reportToolExposureFallback('pre_step_selection_pending') }
        else {
          const existing = agent.session ? currentSession(agent.session.id) : undefined
          if (existing && hasSelection(existing.runId)) throw error
          const failure = error instanceof KiokukoError ? error.code.toLowerCase() : error instanceof Error ? error.name.toLowerCase() : 'unknown'
          reportToolExposureFallback(`pre_step_${failure}`)

          // Optional intake enrichment retains its existing degraded behavior.
        }
      }
      const item = agent.session ? currentSession(agent.session.id) : undefined
      await memoryReviewPresentation.sync(item && !item.closed && item.nativeAgent === agent && item.nativeSession === agent.session
        ? item.runId : undefined)
      if (!item || item.closed) return undefined
      const selection = getSelection(item.runId)?.value
      if (selection && selection.status !== 'ready' && !selection.discussion && item.prepared.intake.profile.taskType !== 'chat') selectionBlocked.add(agent)
      const role = modelRoleForState(item.prepared.ennoOduno)
      const reviewModel = answerReview.model(agent as ReviewAgent)
      if (reviewModel) return reviewModel
      if (selection?.mode === 'enno' && selection.status === 'ready' && role) return selection.configuration?.roles[role]
      if ((native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined)?.enabled(agent as DshUserQuestionAgent)) return { kind: 'native' }
      if (admitted && !role && !selectionBlocked.has(agent) && (!selection || selection.mode === 'normal' && selection.status === 'ready')
        && item.nativeAgent === agent && item.nativeSession === agent.session && item.turn === turn && !item.closed
        && !(agent as ReviewAgent).session.header?.parentSession && (agent as ReviewAgent).session.header?.origin !== 'subagent' && !(agent as ReviewAgent).session.header?.delegationDepth) {
        assertDshModelAdmitted(admitted)
        const pendingManual = manualModelChanges.get(item.sessionId)
        if (pendingManual) await pendingManual
        const decision = await modelAuto.resolve({ runId: item.runId, sessionId: item.sessionId,
          requestId: dshTurnRequestId({ dshSessionId: item.sessionId, turn: item.turn }), turn: item.turn,
          task: item.task, ...(item.prepared.intake.profile.taskType ? { taskType: item.prepared.intake.profile.taskType } : {}),
          attachmentTypes: attachmentTypesFromMessages(messages), measureContext: () => nativeContextTokens(native, agent.session), admitted: true, signal })
        if (decision.kind === 'apply') { autoRoute = { runId: item.runId, sessionId: item.sessionId, binding: decision.binding }; return decision.binding }
        return { kind: 'native' }
      }
      return undefined
    }, {
      load: () => {
        const runId = agent.session ? currentSession(agent.session.id)?.runId : undefined
        return runId ? getSelection(runId)?.value.ordinaryModel : undefined
      },
      save: async ordinaryModel => {
        const runId = agent.session ? currentSession(agent.session.id)?.runId : undefined
        if (!runId || delegation.isChild(agent)) return
        await modelAuto.baseline(runId, ordinaryModel)
        await runtime.withDatabase(db => {
          const stored = readExecutionSelection(db, runId)
          if (stored && !stored.value.ordinaryModel) setSelection(runId, writeExecutionSelection(db, runId, stored.revision, { ...stored.value, ordinaryModel }))
        })
      },
    }, {
      prompts: () => getSkillPrompts(),
      owner: () => agent.session ? currentSession(agent.session.id)?.runId : undefined,
      beforeRequest: async binding => {
        if (!autoRoute || !binding) return
        const pendingManual = manualModelChanges.get(autoRoute.sessionId)
        if (pendingManual) await pendingManual
        await modelAuto.assertCurrent(autoRoute.runId, autoRoute.sessionId, binding)
      },
      assembled: async assembly => {
        semanticCompaction.recordRoute(agent as unknown as CompactionAgent, assembly.variables)
        const lisp = native.get(LISP_ASSEMBLY_SERVICE, false) as LispAssemblyService | undefined
        if (lisp) assembly = lisp.project(agent, assembly)
        if (getToolExposureConfig().mode === 'phase') {
          let fallback: string | undefined
          const surface = (assembly as { tools?: unknown }).tools
          const runtimeTools = tools as unknown as { get?: (name: string, scope?: unknown) => unknown; schemas?: (...args: unknown[]) => unknown } | undefined
          if (!Array.isArray(surface) || typeof runtimeTools?.get !== 'function' || typeof runtimeTools.schemas !== 'function') fallback = 'unsupported_runtime'
          else if (surface.some(value => typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { name?: unknown }).name === 'run_code')) fallback = 'unsupported_presentation'
          else {
            const session = agent.session
            const item = session ? currentSession(session.id) : undefined
            const selectionRecord = item ? getSelection(item.runId) : undefined
            const selection = selectionRecord?.value
            const state = item ? getPolicyState(item.runId) : undefined
            const prepared = item?.prepared
            const unboundReason = !item ? 'turn_record_missing'
              : !session ? 'native_session_missing'
              : !selectionRecord || !selection ? 'selection_missing'
              : !state ? 'policy_state_missing'
              : !prepared ? 'prepared_state_missing'
              : selection.status !== 'ready' ? 'selection_not_ready'
              : selection.discussion ? 'discussion_pending'
              : selection.mode !== 'normal' && selection.mode !== 'enno' ? 'unsupported_selection_mode'
              : item.closed ? 'session_closed'
              : item.failed ? 'session_failed'
              : prepared.run.status !== 'active' ? 'run_not_active'
              : currentSession(item.sessionId) !== item ? 'stale_turn_record'
              : item.nativeAgent !== agent ? 'agent_identity'
              : item.nativeSession !== session ? 'session_identity'
              : agents?.get(agent.id) !== agent ? 'agent_registry'
              : sessions?.get(session.id) !== session ? 'session_registry'
              : delegation.isChild(agent) ? 'delegated_agent'
              : deepPlanning.executor.isChild(agent) ? 'deep_planning_agent'
              : state.runId !== item.runId || state.workspace !== item.workspace || state.orchestrationId !== item.orchestrationId || state.dshSessionId !== item.sessionId || state.nativeTurn !== item.turn ? 'policy_binding'
              : !hasKnownDshToolPolicyState(state) ? 'unknown_policy_state'
              : 'unbound'
            if (!item || !session || !selectionRecord || !selection || !state || !prepared
              || selection.status !== 'ready' || selection.discussion || (selection.mode !== 'normal' && selection.mode !== 'enno')
              || item.closed || item.failed || prepared.run.status !== 'active'
              || currentSession(item.sessionId) !== item || item.nativeAgent !== agent || item.nativeSession !== session
              || agents?.get(agent.id) !== agent || sessions?.get(session.id) !== session
              || delegation.isChild(agent) || deepPlanning.executor.isChild(agent)
              || state.runId !== item.runId || state.workspace !== item.workspace || state.orchestrationId !== item.orchestrationId
              || state.dshSessionId !== item.sessionId || state.nativeTurn !== item.turn || !hasKnownDshToolPolicyState(state)) fallback = `unbound:${unboundReason}`
            else {
              const generation = item.prepareGeneration
              const current = () => currentSession(item.sessionId) === item && !item.closed && !item.failed
                && item.nativeAgent === agent && item.nativeSession === session && item.prepared === prepared
                && item.prepareGeneration === generation && getSelection(item.runId) === selectionRecord
                && getPolicyState(item.runId) === state && agents?.get(agent.id) === agent && sessions?.get(session.id) === session
                && !delegation.isChild(agent) && !deepPlanning.executor.isChild(agent)
              const projection = projectToolsForPhase(surface as readonly { name: string }[], state, ownedModelToolDefinitions, name => {
                const definition = runtimeTools.get!.call(tools, name, agent)
                return typeof definition === 'object' && definition !== null && typeof (definition as { execute?: unknown }).execute === 'function'
                  ? definition as { execute: unknown } : undefined
              })
              if (!current()) fallback = 'unbound:assembly_binding_changed'
              else if (projection.reason === 'ownership_unknown' || projection.reason === 'unknown_state') fallback = projection.reason
              else if (projection.reason === 'projected') assembly = Object.assign({}, assembly, { tools: projection.tools })
            }
          }
          if (fallback !== undefined) reportToolExposureFallback(fallback)
        }
        semanticCompaction.recordTools(agent as unknown as CompactionAgent, (assembly as { tools?: unknown }).tools)
        const delivered = new Set<string>()
        for (const [name, sectionName] of [['kiokuko-soul','kiokuko:soul'], ['natural-japanese-output','kiokuko:natural-japanese-output'], ['kiokuko-lisp','kiokuko:lisp']]) {
          const section = assembly.sections.find(section => section.name === sectionName)
          if (!section) continue
          const text = section.text.replace(/\{\{([^{}]+)\}\}/gu, (_match, variable: string) => assembly.variables[variable] ?? '')
          if (text.includes(await getSkillPrompts().require(name!))) delivered.add(name!)
        }
        systemSkillNames.set(agent, delivered)
        return assembly
      },
    })
    const disposeMemoryFence = onNativeEvent(agent.ctx, 'llm/stream', (request: any, next: () => AsyncIterable<any>) => (async function* () {
      const item = agent.session ? currentSession(agent.session.id) : undefined
      if (item && !item.closed && !delegation.isChild(agent) && request.sessionId === agent.session?.id && request.purpose !== 'compaction') {
        let allowed: ReadonlyMap<string,string> = new Map()
        try { allowed = await runtime.withDatabase(db => currentRequestMemory(db, item.prepared)) } catch { /* fail closed for owned memory */ }
        if (filterRequestMemory(request.messages, allowed).length !== request.messages.length) {
          pruneDshMemorySurface(agent.session!, allowed)
          throw new KiokukoError('CONFLICT', 'Memory changed after native request assembly; rebuild the request')
        }
      }
      yield* next()
    })())
    routingDisposers.set(agent, () => { disposeMemoryReviewIdle(); memoryReviewPresentation.dispose(); releaseToolSurfaceRecording(); disposeRouting(); disposeMemory(); disposeMemoryFence(); disposeClaim() })
  }
  const routingCreatedDisposer = onNativeEvent(ctx, 'agent/created', (event: { agent: RoutableAgent }) => {
    delegation.created(event.agent)
    installRouting(event.agent)
  })
  const modelErrorDisposer = onNativeEvent(ctx, 'agent/request-error', async (event: { agent: RoutableAgent; failure: unknown }, next: () => Promise<unknown>) => {
    if (!isModelAvailabilityFailure(event.failure)) return next()
    const owner = delegation.parent(event.agent) ?? event.agent
    const item = owner.session ? currentSession(owner.session.id) : undefined
    if (!item || getSelection(item.runId)?.value.mode !== 'enno' || !modelRoleForState(item.prepared.ennoOduno)) return next()
    await markModelUnavailable(event.agent)
    return undefined // No native automatic retry or provider substitution.
  }, { prepend: true })
  for (const agent of agents?.list?.() ?? []) installRouting(agent)
  return {
    install: installRouting,
    markModelUnavailable,
    isSelectionBlocked: (agent: object): boolean => selectionBlocked.has(agent),
    systemSkillsFor: (agent: object): ReadonlySet<string> | undefined => systemSkillNames.get(agent),
    modelToolDefinitionsChanged: (definitions: readonly DshToolDefinition[]): void => {
      ownedModelToolDefinitions.clear()
      for (const definition of definitions) if (operationName(definition.name)) ownedModelToolDefinitions.set(definition.name, { execute: definition.execute })
    },
    recordManualChange: (sessionId: string, pending: Promise<void>): void => { manualModelChanges.set(sessionId, pending) },
    dispose: (): void => {
      routingCreatedDisposer()
      modelErrorDisposer()
      for (const dispose of routingDisposers.values()) dispose()
      routingDisposers.clear()
    },
  }
}
