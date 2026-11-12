import { ownedExplanationCalls } from '../explanation-provenance.js'
import { auxiliaryDatabase } from '../auxiliary-database.js'
import type { CaptureInitialInput } from './session-observation.js'
import { noteScopedMemory } from '../memory-sidebar.js'
import { createNativeToolSurface } from '../native-tool-surface.js'
import type { ToolExposureContext } from '../tool-exposure-diagnostics.js'
import { failureDiagnostic } from '../failure-diagnostic.js'
import type { NativeWorkerRouting } from '../native-worker-routing.js'
import { isNativeSubagent } from '../native-subagent.js'
import { MemoryRequestFence, MemorySnapshotStale, type MemoryDispatchGuard } from '../memory-request-fence.js'
import {observeCorrectionInput} from '../correction-context.js'
import {recordCorrectionObservation} from '../correction-decision.js'
import { assertMemoryOwner } from '../memory-owner.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { OnDemandIntake } from '../on-demand-intake.js'
import type { Context } from '@deepseek-ai/cordis'
import { attachmentTypesFromMessages, nativeContextTokens } from '../model-auto/policy.js'
import type { CompactionAgent } from '../semantic-compaction/contracts.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import type { ReviewAgent } from '../answer-review/contracts.js'
import { reviewMessageId } from '../answer-review/contracts.js'
import { hasRequestInput } from '../request-input.js'
import { readExecutionSelection, writeExecutionSelection, type StoredExecutionSelection } from '../execution-selection.js'
import { ExecutionSelectionPending } from '../model-selection-ui.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../lisp/coding-choice.js'
import { LISP_ASSEMBLY_SERVICE, type LispAssemblyService } from '../lisp/request-surface.js'
import { installDshModelRouting, type RoutableAgent } from '../model-routing.js'
import { assertDshModelAdmitted, type DshIntakeGateResult, type DshPreStepEvent } from '../intake-gate.js'
import { hasKnownDshToolPolicyState, type DshToolPolicyState } from '../tool-policy.js'
import { projectToolsForLean, projectToolsForMinimal, resolveToolExposureMode, projectToolsForPhase, type ToolExposureConfig, type ToolExposureMetrics } from '../tool-exposure.js'
import type { NativeModelCatalog } from '../native-model-catalog.js'
import type { DshUserQuestionAgent } from '../user-interaction.js'
import { KiokukoError } from '../../errors.js'
import { filterExplainedMemory, retiredExplanationCalls, pruneExplainedMemorySurface, currentRequestMemory, pruneDshMemorySurface, reconcileDshMemorySurface, filterRequestMemory } from '../request-memory.js'
import type { DshNativePreStepPayload } from '../composition.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { ModelAutoCoordinator } from '../model-auto/coordinator.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { SemanticCompactionCoordinator } from '../semantic-compaction/coordinator.js'
import type { DeepPlanningController } from '../../deep-thinker/controller.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { TurnRecord } from './turn-state.js'
import { onNativeEvent } from './native-events.js'
import { operationName } from './tool-host.js'
import type { DshToolDefinition } from '../tools.js'
import type { AdapterContext, NativeAgents, NativeSessions, NativeTools } from './native-events.js'

interface RoutingDependencies {
  readonly nativeWorkers: NativeWorkerRouting
  readonly demand?: OnDemandIntake | undefined
  readonly ctx: Context
  readonly native: AdapterContext
  readonly tools: NativeTools | undefined
  readonly agents: NativeAgents | undefined
  readonly sessions: NativeSessions | undefined
  readonly runtime: DshCoreRuntime
  readonly modelAuto: ModelAutoCoordinator
  readonly answerReview: AnswerReviewCoordinator
  readonly semanticCompaction: SemanticCompactionCoordinator
  readonly deepPlanning: DeepPlanningController
  readonly isGenericNativeChild: (agent: RoutableAgent) => boolean
  readonly getSkillPrompts: () => DshSkillPrompts
  readonly getToolExposureConfig: () => ToolExposureConfig
  readonly reportToolExposureFallback: (reason: string, context: ToolExposureContext) => void
  readonly reportToolExposureProjection: (mode: 'lean' | 'minimal', reason: string, metrics: ToolExposureMetrics, context: ToolExposureContext) => void
  readonly modelCatalog: NativeModelCatalog | undefined
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly setSelection: (runId: string, selection: StoredExecutionSelection) => void
  readonly hasSelection: (runId: string) => boolean
  readonly getPolicyState: (runId: string) => DshToolPolicyState | undefined
  readonly captureInitialInput: CaptureInitialInput
  readonly prepareTurn: (event: DshPreStepEvent) => Promise<DshIntakeGateResult>
  readonly mapPreStep: (payload: DshNativePreStepPayload) => Promise<DshPreStepEvent>
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly refreshMemoryOwner: (item: TurnRecord, signal: AbortSignal) => Promise<void>
}

export function createRouting({
  ctx, native, tools, agents, sessions, runtime, modelAuto, answerReview,
  semanticCompaction, deepPlanning, isGenericNativeChild, getSkillPrompts,
  getToolExposureConfig, reportToolExposureFallback, reportToolExposureProjection, modelCatalog,
  getSelection, setSelection, hasSelection,
  getPolicyState, captureInitialInput, prepareTurn, mapPreStep, currentSession,
  refreshMemoryOwner, demand, nativeWorkers,
}: RoutingDependencies) {
  const systemSkillNames = new WeakMap<object, ReadonlySet<string>>()
  const ownedModelToolDefinitions = new Map<string, { readonly execute: unknown }>()
  const selectionBlocked = new WeakSet<object>()
  const selectionDiagnostics = new WeakMap<object, ReadonlyMap<string, unknown>>()
  const registry = tools as (NativeTools & { get?(name: string, agent: object): { execute?: unknown } | undefined }) | undefined
  const markSelectionPending = (agent: object) => {
    selectionBlocked.add(agent)
    const definitions = new Map<string, unknown>()
    for (const name of ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
      'job_list', 'job_output', 'todo_write', 'lisp_status', 'coding_workflow']) {
      const execute = registry?.get?.(name, agent)?.execute
      if (typeof execute === 'function') definitions.set(name, execute)
    }
    selectionDiagnostics.set(agent, definitions)
  }
  const disposeSelectionGuard = tools?.guard((input) => {
    const execution = input as { agent?: object; name: string; arguments?: { action?: string } }
    const agent = execution.agent
    if (!agent || !selectionBlocked.has(agent)) return undefined
    const execute = selectionDiagnostics.get(agent)?.get(execution.name)
    if (execute && registry?.get?.(execution.name, agent)?.execute === execute &&
      (execution.name !== 'coding_workflow' || execution.arguments?.action === 'status')) return undefined
    return 'EXECUTION_SELECTION_PENDING: Continue permitted reading and planning. Effects remain pending until the execution route is selected.'
  })
  const manualModelChanges = new Map<string, Promise<void>>()
  const assemblyClaims = new WeakMap<object, { turn: number; messages: unknown[] }>()
  const markModelUnavailable = (agent: RoutableAgent): Promise<void> => Promise.resolve()
  const routingDisposers = new Map<object, () => void>()
  const installRouting = (agent: RoutableAgent) => {
    if (routingDisposers.has(agent) || !agent.ctx) return
    const releaseToolSurfaceRecording = semanticCompaction.deferToolSurfaceRecording(agent as unknown as CompactionAgent)
    semanticCompaction.attach(agent as unknown as CompactionAgent, async () => {
      if (isNativeSubagent(agent)) return undefined
      const item = agent.session ? currentSession(agent.session.id) : undefined
      return item ? { runId: item.runId, sessionId: item.sessionId, selection: getSelection(item.runId) ?? null,
        taskEvidence: { currentRequest: item.task,
          ...(item.prepared.intake.profile.target ? { target: item.prepared.intake.profile.target } : {}),
          ...(item.prepared.intake.profile.expected ? { successCriteria: item.prepared.intake.profile.expected } : {}),
          ...(item.prepared.intake.profile.constraints ? { constraints: item.prepared.intake.profile.constraints } : {}) } } : { sessionId: agent.session?.id }
    })
    const memoryFence = new MemoryRequestFence()
    const disposeRetry = onNativeEvent(agent.ctx, 'agent/request-error', async (event: any, next: () => Promise<any>) => {
      const action = memoryFence.retry(event)
      return action === undefined ? next() : action
    }, { prepend: true })
    const disposeMemory = onNativeEvent(agent.ctx, 'agent/request', async (event: any, next: () => Promise<any>) => {
      memoryFence.begin(event)
      const request = await next()
      if (demand?.pending(agent)) { await demand.beforeRequest(agent); return request }
      const item = agent.session ? currentSession(agent.session.id) : undefined
      const prepared = item?.turn === memoryFence.turn ? item.prepared : undefined
      if (!prepared || !agent.session) return request
      // A unavailable memory catalog degrades to no owned memory, never to a
      // stale snapshot retained by the native session's historical surface.
      const memorySession = agent.session, memoryGeneration = item?.prepareGeneration
      const currentMemorySource = () => agent.session === memorySession && currentSession(memorySession.id) === item && item?.prepareGeneration === memoryGeneration
      const assertMemorySource = () => {
        event.signal?.throwIfAborted()
        if (!currentMemorySource()) throw new KiokukoError('CONFLICT', 'memory_owner_changed')
      }
      try {
        if (!memoryFence.withoutMemory) {
          const allowed = await auxiliaryDatabase(runtime, db => currentRequestMemory(db, prepared), () => !event.signal?.aborted && currentMemorySource(), event.signal)
          assertMemorySource()
          pruneDshMemorySurface(agent.session, allowed)
          const retired = await auxiliaryDatabase(runtime, db => retiredExplanationCalls(db, agent.session!), () => !event.signal?.aborted && currentMemorySource(), event.signal)
          assertMemorySource()
          pruneExplainedMemorySurface(agent.session, retired)
        }
      } catch (error) {
        assertMemorySource()
        if (error instanceof KiokukoError && error.code === 'CONFLICT') throw error
        memoryFence.omitMemory()
        pruneDshMemorySurface(agent.session, new Map())
        pruneExplainedMemorySurface(agent.session, ownedExplanationCalls(agent.session))
      }
      return request
    }, { prepend: true })
    const disposeClaim = onNativeEvent(agent.ctx, 'agent/inbox/claimed', (event: { agent: RoutableAgent; turn: number; message: unknown }) => {
      if (event.agent !== agent) return
      const previous = assemblyClaims.get(agent)
      if (previous?.turn === event.turn) previous.messages.push(event.message)
      else assemblyClaims.set(agent, { turn: event.turn, messages: [event.message] })
    })
    let autoRoute: { runId: string; sessionId: string; binding: import('../model-configuration.js').ModelBinding } | undefined
    let minimalSurface = false
    const diagnosticContext = (error?: unknown): ToolExposureContext => {
      const session = agent.session, item = session ? currentSession(session.id) : undefined
      const position = agent as unknown as { turn?: number; step?: number }
      return { agentId: agent.id, sessionId: session?.id ?? null, runId: item?.runId ?? null, turn: item?.turn ?? null,
        nativeTurn: Number.isSafeInteger(position.turn) ? position.turn! : null, step: Number.isSafeInteger(position.step) ? position.step! : null,
        nativeSeq: (session as { seq?: number } | undefined)?.seq ?? null, prepareGeneration: item?.prepareGeneration ?? null,
        closed: item?.closed ?? null, failed: item?.failed ?? null, taskType: item?.prepared.intake.profile.taskType ?? null,
        intakeStatus: item?.prepared.intake.status ?? null, selectionStatus: item ? getSelection(item.runId)?.value.status ?? null : null,
        policyKnown: !!item && !!getPolicyState(item.runId),
        policyPhase: item ? getPolicyState(item.runId)?.phase ?? null : null, selectionMode: item ? getSelection(item.runId)?.value.mode ?? null : null,
        ...(error === undefined ? item?.failureDiagnostic ? { failure: item.failureDiagnostic } : {} : { failure: failureDiagnostic(error, 'redacted') }) }
    }
    const projectToolSurface = (assembly: import('../japanese-output-skill.js').PromptAssembly & { tools?: unknown }): any => {
      minimalSurface = false
      const exposureMode = getToolExposureConfig().mode
      if (exposureMode !== 'full') {
        let fallback: string | undefined
        const surface = (assembly as { tools?: unknown }).tools
        const runtimeTools = tools as unknown as { get?: (name: string, scope?: unknown) => unknown; schemas?: (...args: unknown[]) => unknown } | undefined
        if (!Array.isArray(surface) || surface.some(value => typeof value !== 'object' || value === null || Array.isArray(value)
          || typeof value.name !== 'string' || value.description !== undefined && typeof value.description !== 'string')
          || typeof runtimeTools?.get !== 'function' || typeof runtimeTools.schemas !== 'function') fallback = 'unsupported_runtime'
        else if (surface.some(value => typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { name?: unknown }).name === 'run_code')) fallback = 'unsupported_presentation'
        else {
          const session = agent.session
          const item = session ? currentSession(session.id) : undefined
          const selectionRecord = item ? getSelection(item.runId) : undefined
          const selection = selectionRecord?.value
          const state = item ? getPolicyState(item.runId) : undefined
          const prepared = item?.prepared
          const selectionOptional = exposureMode === 'auto' && !!prepared
            && ['chat', 'research', 'analysis', 'writing'].includes(prepared.intake.profile.taskType ?? '')
            && (prepared.intake.status === 'ready' || prepared.intake.status === 'exhausted')
          const selectionReady = selection ? selection.status === 'ready' && !selection.discussion
            && selection.mode === 'normal' : selectionOptional
          const unboundReason = !item ? 'turn_record_missing'
            : !session ? 'native_session_missing'
            : !selection && !selectionOptional ? 'selection_missing'
            : !state ? 'policy_state_missing'
            : !prepared ? 'prepared_state_missing'
            : selection && selection.status !== 'ready' ? 'selection_not_ready'
            : selection?.discussion ? 'discussion_pending'
            : selection && selection.mode !== 'normal' ? 'unsupported_selection_mode'
            : item.closed ? 'session_closed'
            : item.failed ? 'session_failed'
            : prepared.run.status !== 'active' ? 'run_not_active'
            : currentSession(item.sessionId) !== item ? 'stale_turn_record'
            : item.nativeAgent !== agent ? 'agent_identity'
            : item.nativeSession !== session ? 'session_identity'
            : agents?.get(agent.id) !== agent ? 'agent_registry'
            : sessions?.get(session.id) !== session ? 'session_registry'
            : deepPlanning.executor.isChild(agent) ? 'deep_planning_agent'
            : state.runId !== item.runId || state.workspace !== item.workspace || state.orchestrationId !== item.orchestrationId || state.dshSessionId !== item.sessionId || state.nativeTurn !== item.turn ? 'policy_binding'
            : !hasKnownDshToolPolicyState(state) ? 'unknown_policy_state'
            : 'unbound'
          if (!item || !session || !state || !prepared || !selectionReady
            || item.closed || item.failed || prepared.run.status !== 'active'
            || currentSession(item.sessionId) !== item || item.nativeAgent !== agent || item.nativeSession !== session
            || agents?.get(agent.id) !== agent || sessions?.get(session.id) !== session
            || deepPlanning.executor.isChild(agent)
            || state.runId !== item.runId || state.workspace !== item.workspace || state.orchestrationId !== item.orchestrationId
            || state.dshSessionId !== item.sessionId || state.nativeTurn !== item.turn || !hasKnownDshToolPolicyState(state)) fallback = `unbound:${unboundReason}`
          else {
            const generation = item.prepareGeneration
            const current = () => currentSession(item.sessionId) === item && !item.closed && !item.failed
              && item.nativeAgent === agent && item.nativeSession === session && item.prepared === prepared
              && item.prepareGeneration === generation && getSelection(item.runId) === selectionRecord
              && getPolicyState(item.runId) === state && agents?.get(agent.id) === agent && sessions?.get(session.id) === session
              && !deepPlanning.executor.isChild(agent)
            let effectiveMode: import('../tool-exposure.js').ResolvedToolExposureMode = exposureMode === 'auto' ? 'full' : exposureMode
            let decisionReason = 'explicit'
            if (exposureMode === 'lean' || exposureMode === 'auto') {
              const selectedBinding = autoRoute?.runId === item.runId && autoRoute.sessionId === item.sessionId
                ? autoRoute.binding
                : undefined
              const variables = (assembly as { variables?: Record<string, unknown> }).variables
              const provider = variables?.provider
              const model = variables?.model
              const assemblyBinding = typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
              if (!assemblyBinding || (selectedBinding && (assemblyBinding.provider !== selectedBinding.provider || assemblyBinding.model !== selectedBinding.model))) fallback = 'model_binding_unavailable'
              else {
                const decision = resolveToolExposureMode({ mode: exposureMode, taskType: prepared.intake.profile.taskType,
                  selectionMode: 'normal', state })
                effectiveMode = decision.mode
                decisionReason = decision.reason
                if (effectiveMode === 'full') fallback = decision.reason
              }
            }
            if (fallback === undefined) {
              const resolver = (name: string) => {
                const definition = runtimeTools.get!.call(tools, name, agent)
                return typeof definition === 'object' && definition !== null && typeof (definition as { execute?: unknown }).execute === 'function'
                  ? definition as { execute: unknown } : undefined
              }
              const projection = effectiveMode === 'minimal'
                ? projectToolsForMinimal(surface as readonly { name: string; description?: string; parameters?: unknown }[], state, ownedModelToolDefinitions, resolver)
                : effectiveMode === 'lean'
                ? projectToolsForLean(surface as readonly { name: string; description?: string; parameters?: unknown }[], state, ownedModelToolDefinitions, resolver)
                : projectToolsForPhase(surface as readonly { name: string; description?: string; parameters?: unknown }[], state, ownedModelToolDefinitions, resolver)
              if (!current()) fallback = 'unbound:assembly_binding_changed'
              else if (projection.reason === 'ownership_unknown' || projection.reason === 'unknown_state' || projection.reason === 'unsupported_schema') fallback = projection.reason
              else {
                if (projection.reason === 'projected') assembly = Object.assign({}, assembly, {
                  tools: projection.tools,
                  ...(effectiveMode === 'minimal' ? { sections: assembly.sections.map(section => section.name === 'kiokuko:soul'
                    ? { ...section, text: `${section.text}\nFor this admitted task, Kiokuko model tools are intentionally omitted. Do not request curator_check or memory_checkpoint. The host owns task completion; use the available native tools as needed. Memory is optional and may be organized only after the task ends, then saved only after the user approves the exact shown revision.` }
                    : section) } : {}),
                })
                if (effectiveMode === 'minimal' && projection.reason === 'projected') minimalSurface = true
                if (effectiveMode === 'lean' || effectiveMode === 'minimal') reportToolExposureProjection(effectiveMode, `${decisionReason}:${prepared.intake.profile.taskType}:${projection.reason}`, projection.metrics, diagnosticContext())
              }
            }
          }
        }
        if (fallback !== undefined) reportToolExposureFallback(fallback, diagnosticContext())
      }
      return assembly
    }
    const nativeToolSurface = agent.model && typeof agent.runMaintenance === 'function' ? createNativeToolSurface(agent, ownedModelToolDefinitions) : undefined
    const disposeRouting = installDshModelRouting(agent, async signal => {
      autoRoute = undefined
      nativeWorkers.clearRequest(agent)
      // An armed/native Deep request owns its ingress before ordinary intake.
      const deep = await deepPlanning.beforeAssembly(agent, signal)
      if (deep.owned) { assemblyClaims.delete(agent); return deep.model }
      if (demand && !deepPlanning.executor.isChild(agent) && !isGenericNativeChild(agent)) {
        // Maintenance runs before DSH resolves its step's immutable tool set.
        // Only prepare Lisp availability here. Source-bound interpretation
        // must wait for the real turn/start and its claimed input.
        if (!assemblyClaims.has(agent) && agent.status === 'idle' && agent.inbox && agent.session && agents?.turnBoundaryOf) {
          const messages = [...agent.inbox.nextStep, ...agent.inbox.nextTurn.slice(0, 1)]
          if (hasRequestInput(messages)) await demand.prepareNativeCapabilities({ agent, messages,
            turn: agents.turnBoundaryOf(agent.session).lastTurn + 1, step: 0, signal })
        }
        const claim = assemblyClaims.get(agent)
        if (claim && hasRequestInput(claim.messages) && await demand.capture({ agent, messages: claim.messages, turn: claim.turn, step: 0, signal }).catch(error => {
          // The claimed batch was consumed even when startup was cancelled.
          // It cannot be offered to a later native turn or maintenance pass.
          if (assemblyClaims.get(agent) === claim) assemblyClaims.delete(agent)
          throw error
        })) {
          assemblyClaims.delete(agent); return await nativeWorkers.head(agent, signal) ?? { kind: 'native' }
        }
        if (demand.pending(agent)) return await nativeWorkers.head(agent, signal) ?? { kind: 'native' }
      }
      if (isGenericNativeChild(agent)) { assemblyClaims.delete(agent); return await nativeWorkers.worker(agent, signal) ?? { kind: 'native' } }
      selectionBlocked.delete(agent)
      const claim = assemblyClaims.get(agent)
      assemblyClaims.delete(agent)
      // Inbox maintenance runs before turn/start. Without a claim it can
      // refresh availability, but must not re-prepare the previous turn with
      // the new tool view. A mismatch there would fail the next human turn.
      if (!claim && agent.status === 'idle') return await nativeWorkers.head(agent, signal)
      const current = agent.session ? currentSession(agent.session.id) : undefined
      const turn = claim?.turn ?? current?.turn
      if (turn === undefined) {
        reportToolExposureFallback('pre_step_missing_turn', diagnosticContext())
        return await nativeWorkers.head(agent, signal)
      }
      const messages = claim?.messages ?? []
      // DSH claims input before assembly. Persist it before showing any UI so
      // cancellation and restart cannot lose a prompt before the native log append.
      if (agent.session && messages.length) {
        const session = agent.session, generation = current?.prepareGeneration
        await captureInitialInput(session.id, turn, messages, { signal, agent, session,
          current: () => agents?.get(agent.id) === agent && currentSession(session.id) === current && current?.prepareGeneration === generation })
      }
      let admitted: DshIntakeGateResult | undefined
      try {
        const event = await mapPreStep({ agent, messages, turn, step: 0, signal })
        admitted = await prepareTurn(event)
      } catch (error) {
        if (error instanceof ExecutionSelectionPending) { markSelectionPending(agent); reportToolExposureFallback('pre_step_selection_pending', diagnosticContext()) }
        else if (messages.some(message => reviewMessageId(message) !== undefined)) {
          // The claimed input is an automatic reconsideration. If it is no
          // longer authorized it is simply skipped; it is not a user request,
          // so it must never surface as a native turn failure.
          reportToolExposureFallback('answer_review_continuation_rejected', diagnosticContext(error))
        } else {
          const existing = agent.session ? currentSession(agent.session.id) : undefined
          if (existing && hasSelection(existing.runId)) throw error
          const failure = error instanceof KiokukoError ? error.code.toLowerCase() : error instanceof Error ? error.name.toLowerCase() : 'unknown'
          reportToolExposureFallback(`pre_step_${failure}`, diagnosticContext(error))

          // Optional intake enrichment retains its existing degraded behavior.
        }
      }
      const item = agent.session ? currentSession(agent.session.id) : undefined
      if (!item || item.closed) return await nativeWorkers.head(agent, signal)
      const selection = getSelection(item.runId)?.value
      if (selection && selection.status !== 'ready' && !selection.discussion && item.prepared.intake.profile.taskType !== 'chat') markSelectionPending(agent)
      const reviewModel = answerReview.model(agent as ReviewAgent)
      if (reviewModel) return reviewModel
      const headModel = !selectionBlocked.has(agent) ? await nativeWorkers.head(agent, signal) : undefined
      if (headModel) return headModel
      if ((native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined)?.enabled(agent as DshUserQuestionAgent)) return { kind: 'native' }
      if (admitted && !selectionBlocked.has(agent) && (!selection || selection.mode === 'normal' && selection.status === 'ready')
        && item.nativeAgent === agent && item.nativeSession === agent.session && item.turn === turn && !item.closed
        && !isNativeSubagent(agent)) {
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
        if (!runId) return
        await modelAuto.baseline(runId, ordinaryModel)
        await runtime.withDatabase(db => {
          const stored = readExecutionSelection(db, runId)
          if (stored && !stored.value.ordinaryModel) setSelection(runId, writeExecutionSelection(db, runId, stored.revision, { ...stored.value, ordinaryModel }))
        })
      },
    }, {
      prompts: () => getSkillPrompts(),
      beforeStep: async binding => {
        minimalSurface = false
        nativeToolSurface?.prepare(schemas => projectToolSurface({ sections: [], variables: { provider: binding?.provider, model: binding?.model }, tools: schemas }).tools, answerReview.reconsidering(agent as ReviewAgent))
      },
      owner: () => agent.session ? currentSession(agent.session.id)?.runId : undefined,
      beforeRequest: async binding => {
        await nativeWorkers.assertRequest(agent, binding)
        if (!autoRoute || !binding) return
        const pendingManual = manualModelChanges.get(autoRoute.sessionId)
        if (pendingManual) await pendingManual
        await modelAuto.assertCurrent(autoRoute.runId, autoRoute.sessionId, binding)
      },
      assembled: async assembly => {
        semanticCompaction.recordRoute(agent as unknown as CompactionAgent, assembly.variables)
        const lisp = native.get(LISP_ASSEMBLY_SERVICE, false) as LispAssemblyService | undefined
        if (lisp) assembly = await lisp.project(agent, assembly)
        if (!nativeToolSurface) assembly = projectToolSurface(assembly)
        else if (minimalSurface) assembly = { ...assembly, sections: assembly.sections.map(section => section.name === 'kiokuko:soul' ? { ...section, text: `${section.text}\nFor this admitted task, Kiokuko model tools are intentionally omitted. Do not request curator_check or memory_checkpoint. The host owns task completion; use the available native tools as needed. Memory is optional and may be organized only after the task ends, then saved only after the user approves the exact shown revision.` } : section) }
        // Automatic reconsideration uses existing originals only: no repeated tool effects.
        if (answerReview.reconsidering(agent as unknown as ReviewAgent)) assembly = Object.assign({}, assembly, { tools: [] })
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
    const disposeMemoryFence = onNativeEvent(agent.ctx, 'llm/stream', (request: any, next: () => AsyncIterable<any>) => memoryFence.stream(async function validateMemory(recoverySignal?: AbortSignal): Promise<void | MemoryDispatchGuard> {
      let validateOwner = () => { request.signal?.throwIfAborted() }
      const database = async <T,>(operation: (db: import('../../db/adapter.js').SqliteDatabase) => T) => {
        const signal: AbortSignal = recoverySignal ?? request.signal
        try { return await auxiliaryDatabase(runtime, db => { validateOwner(); return operation(db) }, () => !signal.aborted, signal) }
        catch (error) {
          request.signal?.throwIfAborted()
          if (error instanceof KiokukoError && error.code === 'CONFLICT') throw error
          validateOwner()
          memoryFence.omitMemory()
          pruneDshMemorySurface(agent.session!, new Map())
          pruneExplainedMemorySurface(agent.session!, ownedExplanationCalls(agent.session))
          throw new MemorySnapshotStale()
        }
      }
      const conversationGuard = await demand?.fence(agent, request, memoryFence.withoutMemory, recoverySignal)
      const item = agent.session ? currentSession(agent.session.id) : undefined
      if (!demand?.pending(agent) && item && item.prepared.memoryOwner?.kind === 'execution' && !item.closed && item.turn === memoryFence.turn && request.sessionId === agent.session?.id && request.purpose !== 'compaction') {
        const session = agent.session, turn = item.turn, generation = item.prepareGeneration
        const assertCurrent = () => {
          recoverySignal?.throwIfAborted()
          if (request.signal instanceof AbortSignal) request.signal.throwIfAborted()
          if (agent.session !== session || currentSession(item.sessionId) !== item || item.closed || item.turn !== turn || item.prepareGeneration !== generation)
            throw new KiokukoError('CONFLICT', 'memory_owner_changed')
        }
        let allowed: ReadonlyMap<string,string> = new Map()
        if (item.nativeAgent !== agent || item.nativeSession !== agent.session || item.prepared.memoryOwner?.kind !== 'execution') throw new KiokukoError('CONFLICT', 'memory_owner_changed')
        assertMemoryOwner(item.prepared.memoryOwner, { agentId: agent.id, sessionId: item.sessionId, turn: memoryFence.turn, requestDigest: canonicalContentHash(item.task), runId: item.runId }, 'execution')
        validateOwner = assertCurrent
        assertCurrent()
        if (memoryFence.withoutMemory) {
          if (filterRequestMemory(request.messages, new Map()).length !== request.messages.length
            || JSON.stringify(filterExplainedMemory(request.messages, ownedExplanationCalls(session))) !== JSON.stringify(request.messages)) throw new MemorySnapshotStale()
          return {check: assertCurrent, rebuild: validateMemory}
        }
        const readMemory = await database(db => () => currentRequestMemory(db, item.prepared))
        allowed = readMemory()
        assertCurrent()
        if (memoryFence.withoutMemory) allowed = new Map()
        if(item.prepared.corrections){
          const receipt=observeCorrectionInput(item.prepared.corrections,allowed,request.messages)
          item.prepared={...item.prepared,corrections:receipt}
          try {await database(db=>recordCorrectionObservation(db,receipt))}catch {if(request.signal instanceof AbortSignal)request.signal.throwIfAborted()}
        }
        const readRetired=await database(db=>()=>retiredExplanationCalls(db,session!))
        const retired=readRetired()
        assertCurrent()
        if (JSON.stringify(filterExplainedMemory(request.messages,retired))!==JSON.stringify(request.messages)) {
          pruneExplainedMemorySurface(agent.session!,retired)
          if (item.memoryRebuildAttempts === 0) {
            await refreshMemoryOwner(item, recoverySignal ?? (request.signal instanceof AbortSignal ? request.signal : new AbortController().signal))
            item.memoryRebuildAttempts++
            const refreshed = await database(db => currentRequestMemory(db, item.prepared))
            assertCurrent()
            reconcileDshMemorySurface(agent.session!, refreshed)
          }
          throw new MemorySnapshotStale()
        }
        if (filterRequestMemory(request.messages, allowed).length !== request.messages.length) {
          pruneDshMemorySurface(agent.session!, allowed)
          if (item.memoryRebuildAttempts === 0) {
            await refreshMemoryOwner(item, recoverySignal ?? (request.signal instanceof AbortSignal ? request.signal : new AbortController().signal))
            item.memoryRebuildAttempts++
            const refreshed = await database(db => currentRequestMemory(db, item.prepared))
            assertCurrent()
            reconcileDshMemorySurface(agent.session!, refreshed)
          }
          throw new MemorySnapshotStale()
        }
        return { check: () => {
          assertCurrent()
          const latest = memoryFence.withoutMemory ? new Map<string, string>() : readMemory()
          if (filterRequestMemory(request.messages, latest).length !== request.messages.length
            || JSON.stringify(filterExplainedMemory(request.messages, readRetired())) !== JSON.stringify(request.messages)) throw new MemorySnapshotStale()
          noteScopedMemory(request, latest, item.prepared.context?.items ?? [])
        }, rebuild: validateMemory }
      }
      return conversationGuard
    }, next, async () => {
      if (request.signal instanceof AbortSignal) request.signal.throwIfAborted()
      if (request.sessionId !== agent.session?.id) throw new KiokukoError('CONFLICT', 'memory_owner_changed')
      pruneDshMemorySurface(agent.session!, new Map())
    }, request.signal instanceof AbortSignal ? request.signal : undefined))
    routingDisposers.set(agent, () => { nativeToolSurface?.dispose(); releaseToolSurfaceRecording(); disposeRouting(); disposeMemory(); disposeMemoryFence(); disposeRetry(); disposeClaim() })
  }
  const routingCreatedDisposer = onNativeEvent(ctx, 'agent/created', (event: { agent: RoutableAgent }) => {
    installRouting(event.agent)
  })
  for (const agent of agents?.list?.() ?? []) installRouting(agent)
  return {
    install: installRouting,
    markModelUnavailable,
    isSelectionBlocked: (agent: object): boolean => selectionBlocked.has(agent),
    markSelectionPending,
    systemSkillsFor: (agent: object): ReadonlySet<string> | undefined => systemSkillNames.get(agent),
    modelToolDefinitionsChanged: (definitions: readonly DshToolDefinition[]): void => {
      ownedModelToolDefinitions.clear()
      for (const definition of definitions) if (operationName(definition.name)) ownedModelToolDefinitions.set(definition.name, { execute: definition.execute })
    },
    recordManualChange: (sessionId: string, pending: Promise<void>): void => { manualModelChanges.set(sessionId, pending) },
    dispose: (): void => {
      routingCreatedDisposer()
      disposeSelectionGuard?.()
      for (const dispose of routingDisposers.values()) dispose()
      routingDisposers.clear()
    },
  }
}
