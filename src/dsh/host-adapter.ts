import { nativeExecutionOwnership } from './native-execution-ownership.js'
import { NativeTaskAuthority } from './native-task-authority.js'
import { readOwnedIdentity } from './owned-read-owner.js'
import type { RoutableAgent } from './model-routing.js'
import { NativeWorkerRouting } from './native-worker-routing.js'
import { validateHeadWorker } from './head-worker-configuration.js'
import { getHeadWorkerSessionSelection, clearHeadWorkerForSession, updateHeadWorkerEffortForSession } from './models/session-selection.js'
import { answerSkillContext, type AnswerSkillRegistry } from './answer-skills.js'
import { DshAnswerContext } from './answer-context.js'
import { IntakeModeConfig } from './intake-mode.js'
import { OnDemandIntake, type IntakeMode } from './on-demand-intake.js'
import { LISP_ASSEMBLY_SERVICE } from './lisp-service-key.js'
import type { LispAssemblyService } from './lisp/request-surface.js'
import { DshTaskWorkflow, TASK_STATE_EVENT, TASK_WORKFLOW_SERVICE } from './task-state-host.js'
import { mountOwnedExecution } from './owned-execution.js'
import { mountPlanTransition } from './plan-transition.js'
import { classifyTaskForIntake } from './decisions/workflows.js'
import { classifyRequestIntent, requestIntentMessageRefs, type RequestIntentDecision } from './decisions/request-intent.js'
import { authorizeTaskLease } from './task-state.js'
import { dshTurnRequestId } from './intake-profile-resolver.js'
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js'
import { MemoryIndexReasoningConfig } from '../memory/index-reasoning/contracts.js'
import { ObservationPackConfig } from './observation-pack/policy.js'
import { createTurnState, policyState, type TurnRecord } from './host-adapter/turn-state.js'
import { createRouting } from './host-adapter/routing.js'
import { createAdmission } from './host-adapter/admission.js'
import { createSessionObservation } from './host-adapter/session-observation.js'
import { createContextMessages } from './host-adapter/context.js'
import { createToolHost } from './host-adapter/tool-host.js'
import { createBoundaries } from './host-adapter/boundaries.js'
import { isNativeSubagent } from './native-subagent.js'
import { createLifecycle } from './host-adapter/lifecycle.js'
import { mountHostMemoryApplication } from './host-adapter/memory-application-host.js'
import { mountTaskCompletion } from './task-completion-host.js'
import { mountCodingWorkflow } from './coding-workflow/host.js'
import { readCodingWorkflow } from './coding-workflow/store.js'
import { stableLispCapabilities } from './lisp-service-key.js'
import { createEfficiencyHost } from './host-adapter/efficiency-host.js'
import { createMemoryReviewHost } from './host-adapter/memory-review-host.js'
import { createEnnoMemoryHost } from './host-adapter/enno-memory-host.js'
import { createSessionAccess } from './host-adapter/session-access.js'
import { createEvolutionHost } from './host-adapter/evolution-host.js'
import { onNativeEvent, onNativeServiceEvent } from './host-adapter/native-events.js'
import type { NativeSkills, NativeTools, NativeCommands, NativeSessions, NativeAgent, NativeAgents, NativeAttachments, AdapterContext } from './host-adapter/native-events.js'
import { isKiokukoDshSource, KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'


import { SemanticCompactionCoordinator } from './semantic-compaction/coordinator.js'
import { ModelHandoff, ModelHandoffConfig } from './model-handoff.js'
import { DshLifecycleMemory } from './lifecycle-memory.js'
import { ModelAutoConfig } from './model-auto/contracts.js'
import { ModelAutoCoordinator } from './model-auto/coordinator.js'
import { ModelAutoStore } from './model-auto/store.js'

import { SemanticCompactionConfig } from './semantic-compaction/contracts.js'
import { MemoryReuseConfig } from '../memory/reuse.js'



import { createDecisionService } from './decisions/host.js'
import { TypedDecisionsConfig } from './decisions/config.js'
import type { DecisionService } from './decisions/service.js'




import { AnswerReviewCoordinator } from './answer-review/coordinator.js'
import { AnswerReviewConfig } from './answer-review/contracts.js'
import { AutoMemoryReviewCoordinator, type ReviewNativeSession } from './auto-memory-review.js'
import { MemoryReviewConfig } from '../memory/review/contracts.js'
import { MemoryRetrievalConfig } from '../memory/retrieval-contracts.js'



import { DshEnnoMemoryRefresh } from './enno-memory-refresh.js'
import { EnnoMemoryConfig } from './config.js'
import { CompletionConfig } from './task-completion.js'

import { saveSessionNotice } from './plugin-records.js'
import { MemoryEvolutionConfig, type EvolutionConfig } from '../memory/evolution/contracts.js'
import { evolutionStatus } from '../memory/evolution/store.js'
import { AgenticReplayConfig, EfficiencyConfig, FinalizationConfig, AkinatorMemoryConfig, ContinuityConfig } from './config.js'

import { readExecutionSelection, writeExecutionSelection, type StoredExecutionSelection } from './execution-selection.js'

import { LISP_CODING_SERVICE, type LispCodingService } from './lisp/coding-choice.js'


import { DshSkillPrompts } from './skill-prompts.js'

import type { ModelRoute, DshModelCatalog, DshModelCompatibility } from './model-configuration.js'
import { nativeModelCatalog } from './native-model-catalog.js'

import { DshEnnoDelegation, type DshSpawnBackend } from './enno-delegation.js'
import { createDshAgenticReplayHost } from './agenticreplay-host.js'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

import { Context } from '@deepseek-ai/cordis'
import { KIOKUKO_DSH_HOST_SERVICE, type DshCompositionHost } from './composition.js'
import { DshRuntime } from './runtime.js'
import type { DshCoreRuntime } from './core-runtime.js'

import { type DshCapabilityReadContext } from './intake-gate.js'





import { DshToolPolicy } from './tool-policy.js'
import { ToolExposureConfig, type ToolExposureMetrics } from './tool-exposure.js'
import { DiffReviewConfig } from './config.js'
import { DiffReviewController } from '../diff-review/controller.js'

import { DshMemoryFinalizer, type DshLlm, type DshSessionEventSource, type DshSessionQuery } from './session-memory-finalizer.js'

import { type DshAdvisoryCall } from './advisory-runner.js'
import { DshPonytailModes } from './commands.js'
import { createDshConfirmationAnswerer, type DshUserQuestions } from './user-interaction.js'
import { createDshCapabilityCatalog, type DshCapabilityCatalog } from './capability-catalog.js'
import { STANDARD_SKILL_MANIFESTS } from './standard-skills.js'
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'




import { stateForSnapshot } from '../enno-oduno/service.js'
import { readEnnoSnapshot } from '../enno-oduno/store.js'


import { DeepPlanningController } from '../deep-thinker/controller.js'



import { type EnnoNextAction, type EnnoOdunoState } from '../enno-oduno/types.js'


import { DshSessionLogMirror, type DshMirrorEventSession } from './session-log-mirror.js'
import { readHistoricalDshSession } from './session-history-lookup.js'

import { DshSessionLogExportService } from './session-log-export.js'


import { DshExecutionSupport } from './execution-support.js'


function sessionEventSource(value: object | undefined): DshSessionEventSource {
  const source = value as Partial<DshSessionEventSource> | undefined
  if (typeof source?.snapshotEvents !== 'function') {
    throw new KiokukoError('INTEGRITY_ERROR', 'The exact native DSH session event source is unavailable')
  }
  return source as DshSessionEventSource
}

export interface DshAdvisoryHost {
  readonly verifyReadOnly: (call: DshAdvisoryCall) => boolean | PromiseLike<boolean>
  readonly execute: (call: DshAdvisoryCall) => Promise<unknown>
}

export interface DshHostAdapterOptions {
  readonly intakeMode?: IntakeMode
  readonly completion?: import('zod').z.input<typeof CompletionConfig>
  readonly answerReview?: import('zod').z.input<typeof AnswerReviewConfig>
  readonly decisions?: DecisionService
  readonly semanticCompactionCoordinator?: SemanticCompactionCoordinator
  readonly observationPack?: import('zod').z.input<typeof ObservationPackConfig>
  readonly semanticCompaction?: import('zod').z.input<typeof SemanticCompactionConfig>
  readonly modelHandoff?: import('zod').z.input<typeof ModelHandoffConfig>
  readonly modelAutoMode?: import('zod').z.input<typeof ModelAutoConfig>
  readonly typedDecisions?: import('zod').z.input<typeof TypedDecisionsConfig>
  readonly memoryReuse?: import('zod').z.input<typeof MemoryReuseConfig>
  readonly memoryRetrieval?: import('zod').z.input<typeof MemoryRetrievalConfig>
  /** An enclosing composition owns and closes this shared runtime. */
  readonly runtime?: DshCoreRuntime
  readonly skillPrompts?: DshSkillPrompts
  readonly deepPlanning?: unknown
  readonly akinatorMemory?: import('zod').z.input<typeof AkinatorMemoryConfig>
  readonly efficiency?: import('zod').z.input<typeof EfficiencyConfig>
  readonly ennoMemory?: import('zod').z.input<typeof EnnoMemoryConfig>
  readonly continuity?: import('zod').z.input<typeof ContinuityConfig>
  readonly memoryIndexReasoning?: import('zod').z.input<typeof MemoryIndexReasoningConfig>
  readonly memoryEvolution?: import('zod').z.input<typeof MemoryEvolutionConfig>
  readonly autoGlobalization?: { enabled?: boolean }
  readonly memoryReview?: import('zod').z.input<typeof MemoryReviewConfig>
  readonly finalization?: import('zod').z.input<typeof FinalizationConfig>
  readonly modelRoutes?: readonly ModelRoute[]
  readonly modelCompatibility?: DshModelCompatibility
  readonly agenticReplay?: import('zod').z.input<typeof AgenticReplayConfig>
  readonly toolExposure?: import('zod').z.input<typeof ToolExposureConfig>
  readonly diffReview?: import('zod').z.input<typeof DiffReviewConfig>
  readonly databasePath?: string
  readonly migrationsDirectory?: string
  readonly repositoryRoot?: string
  readonly now?: () => string
  /** Test/custom host override; the normal DSH bundle injects sessionQuery. */
  readonly sessionQuery?: DshSessionQuery
  /** Test/custom host override; the normal DSH bundle injects llm. */
  readonly llm?: DshLlm
  readonly sessionCachePath?: string
  /** Optional host-owned isolated, read-only advisory execution surface. */
  readonly advisory?: DshAdvisoryHost
}

export interface DshHostAdapter {
  readonly host: DshCompositionHost
  readonly dispose: () => Promise<void>
}

function textFromMessages(messages: readonly unknown[], fallback?: string): string {
  const userTexts: string[] = []
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (message.role !== undefined && message.role !== 'user') continue
    const source = message.source
    const sourceKind = typeof source === 'object' && source !== null && !Array.isArray(source)
      ? (source as Record<string, unknown>).kind
      : undefined
    // File/session context and other host instructions may intentionally use
    // the user role so the model sees them. They are still not the human's
    // request and must not influence intake classification or task identity.
    // Only messages carrying explicit user provenance are the human's task.
    if (sourceKind !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
      const text = (block as Record<string, unknown>).text
      if (typeof text !== 'string' || text.length === 0) continue
      userTexts.push(text)
    }
  }
  const task = userTexts.join('\n').trim()
  if (task.length === 0) {
    if (fallback !== undefined && fallback.trim().length > 0) return fallback
    throw new Error('dsh pre-step did not contain a user task')
  }
  return task
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isHumanMessage(value: unknown): boolean {
  const message = objectRecord(value)
  const source = objectRecord(message?.source)
  return source?.kind === 'user'
}

const CONTINUATION_ID = /^[0-9a-f]{64}$/u

export function pluginContinuationId(value: unknown): string | undefined {
  const message = objectRecord(value)
  const source = objectRecord(message?.source)
  if (!isKiokukoDshSource(source)) return undefined
  const messageId = message?.id
  if (source.form === 'instructions' && typeof messageId === 'string' && CONTINUATION_ID.test(messageId)) {
    return messageId
  }
  if ((source.form !== 'continuation' && source.form !== 'loop-recovery' && source.form !== 'instructions')
    || typeof source.deliveryId !== 'string' || !CONTINUATION_ID.test(source.deliveryId)) return undefined
  return source.deliveryId
}

function isLoopRecoveryMessage(value: unknown): boolean {
  const source = objectRecord(objectRecord(value)?.source)
  return isKiokukoDshSource(source) && source?.form === 'loop-recovery'
}

export function recoveryMessage(continuationId: string, answer: string): unknown {
  return Object.freeze({
    id: continuationId,
    role: 'user',
    content: [{
      type: 'text',
      text: `The user reviewed the stopped Kiokuko loop and supplied this recovery instruction:\n\n${answer}`,
    }],
    source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'instructions' },
  })
}

function boundedMessageText(value: unknown): string | undefined {
  const content = objectRecord(value)?.content
  if (!Array.isArray(content)) return undefined
  const block = content.map(objectRecord).find((candidate) => candidate?.type === 'text' && typeof candidate.text === 'string')
  return typeof block?.text === 'string' ? block.text.slice(0, 2_000) : undefined
}

function boundedUtf8Text(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let result = ''
  let bytes = 0
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8')
    if (bytes + size > maximumBytes) break
    result += point
    bytes += size
  }
  return result
}

export function eventContinuationId(data: unknown): string | undefined {
  const direct = pluginContinuationId(data)
  if (direct !== undefined) return direct
  const record = objectRecord(data)
  return pluginContinuationId(record?.message)
}

export function continuationMessage(continuationId: string, nextAction: EnnoNextAction): unknown {
  const work = nextAction === 'execute_work_unit'
    ? 'The current WorkUnit is not accepted unless the latest Enno result says so. Correct or report only that WorkUnit.'
    : `Continue only the current Kiokuko phase for nextAction=${nextAction}. Do not skip ahead.`
  return Object.freeze({
    id: continuationId,
    role: 'user',
    content: [{ type: 'text', text: work }],
    source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'instructions' },
  })
}

async function capabilityCatalog(
  skills: NativeSkills | undefined,
  tools: NativeTools | undefined,
  context: DshCapabilityReadContext,
): Promise<DshCapabilityCatalog> {
  if (skills?.snapshot === undefined || tools?.schemas === undefined) {
    throw new Error('kiokuko-dsh requires native Skill and tool snapshots')
  }
  const scope = context.nativeAgent ?? context.agent
  const skillSnapshot = await skills.snapshot({ scope, cwd: context.cwd, signal: context.signal })
  if (skillSnapshot.complete !== true) throw new Error('kiokuko-dsh native Skill snapshot is incomplete')
  // A Skill visible to a user but not model-invocable is not a capability
  // that can satisfy the model's required route. Treat it as unavailable by
  // excluding it before the mandatory-catalog check below.
  const nativeSkills = skillSnapshot.skills.filter((skill) => skill.invocation?.modelInvocable !== false)
  const nativeTools = stableLispCapabilities(await tools.schemas(scope), scope)
  const mandatoryOrder = new Map<string, number>()
  STANDARD_SKILL_MANIFESTS.forEach((manifest, index) => mandatoryOrder.set(manifest.name, index))
  const skillDescriptors = nativeSkills
    .map((skill) => ({ kind: 'skill' as const, name: skill.name, ...(skill.description === undefined ? {} : { description: skill.description }) }))
    .sort((left, right) => {
      const leftMandatory = mandatoryOrder.has(left.name)
      const rightMandatory = mandatoryOrder.has(right.name)
      if (leftMandatory !== rightMandatory) return leftMandatory ? -1 : 1
      if (leftMandatory && rightMandatory) return mandatoryOrder.get(left.name)! - mandatoryOrder.get(right.name)!
      return compareCanonicalStrings(left.name, right.name)
    })
  const toolDescriptors = nativeTools
    .map((tool) => ({ kind: 'tool' as const, name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) }))
    .sort((left, right) => compareCanonicalStrings(left.name, right.name))
  return createDshCapabilityCatalog({ skills: skillDescriptors, tools: toolDescriptors })
}

export function createDshHostAdapter(ctx: Context, options: DshHostAdapterOptions = {}): DshHostAdapter {
  let skillPrompts = options.skillPrompts ?? new DshSkillPrompts()
  const akinatorMemoryConfig = AkinatorMemoryConfig.parse(options.akinatorMemory ?? {})
  let toolExposureConfig = ToolExposureConfig.parse(options.toolExposure ?? {})
  const reportedToolExposureFallbacks = new Set<string>()
  const reportedToolExposureProjections = new Set<string>()
  const reportToolExposureFallback = (fallback: string): void => {
    fallback = `${toolExposureConfig.mode}:${fallback}`
    if (toolExposureConfig.mode === 'full' || reportedToolExposureFallbacks.has(fallback)) return
    reportedToolExposureFallbacks.add(fallback)
    console.warn(`[kiokuko-dsh] [warn] toolExposure left the native surface unchanged: ${fallback}`)
  }
  const reportToolExposureProjection = (mode: 'lean' | 'minimal', reason: string, metrics: ToolExposureMetrics): void => {
    if (toolExposureConfig.mode !== 'lean' && toolExposureConfig.mode !== 'auto') return
    const diagnostic = { requestedMode: toolExposureConfig.mode, mode, reason, ...metrics }
    const key = JSON.stringify(diagnostic)
    if (reportedToolExposureProjections.has(key)) return
    reportedToolExposureProjections.add(key)
    console.info(`[kiokuko-dsh] toolExposure projection ${key}`)
  }
  const efficiencyConfig = EfficiencyConfig.parse(options.efficiency ?? {})
  const continuityConfig = ContinuityConfig.parse(options.continuity ?? {})
  const evolutionConfig = MemoryEvolutionConfig.parse(options.memoryEvolution ?? {})
  const finalizationConfig = FinalizationConfig.parse(options.finalization ?? {})
  const memoryRetrievalConfig = MemoryRetrievalConfig.parse(options.memoryRetrieval ?? {})
  const native = ctx as unknown as AdapterContext
  const skills = native.get('skills', false) as NativeSkills | undefined
  const systemPrompt = native.get('systemPrompt', false) as
    (NonNullable<DshCompositionHost['systemPrompt']> & NonNullable<Parameters<DshExecutionSupport['mount']>[0]['systemPrompt']>) | undefined
  const tools = native.get('tools', false) as NativeTools | undefined
  const commands = native.get('commands', false) as NativeCommands | undefined
  const userQuestions = native.get('userQuestions', false) as DshUserQuestions | undefined
  const sessions = native.get('sessions', false) as NativeSessions | undefined
  const agents = native.get('agents', false) as NativeAgents | undefined
  const attachments = native.get('attachments', false) as NativeAttachments | undefined
  const sessionQuery = options.sessionQuery ?? native.get('sessionQuery', false) as DshSessionQuery | undefined
  const llm = options.llm ?? native.get('llm', false) as DshLlm | undefined
  const reviewConfig = DiffReviewConfig.parse(options.diffReview ?? {})
  const completionMode = CompletionConfig.parse(options.completion ?? {}).mode
  const advisory = options.advisory ?? native.get('dshAdvisory', false) as DshAdvisoryHost | undefined
  const modelCatalog = nativeModelCatalog(native.get('llm', false) as DshModelCatalog | undefined,
    native.get('settings', false) as { describe(options: { redactSecrets: true }): readonly { ns: string; value: unknown }[] } | undefined)
  const modelCompatibility = options.modelCompatibility ?? native.get('dshModelCompatibility', false) as DshModelCompatibility | undefined
  const selections = new Map<string, StoredExecutionSelection>()
  const root = realpathSync(options.repositoryRoot ?? process.cwd())
  const runtime = options.runtime ?? new DshRuntime({
    repositoryRoot: root,
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    migrationsDirectory: options.migrationsDirectory ?? fileURLToPath(new URL('../../migrations/', import.meta.url)),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 30_000, batchSize: 16 },
    autoRegisterRepository: true,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const diffReview = reviewConfig.enabled ? new DiffReviewController({
    runtime,
    ...(sessions ? { sessions: sessions as any } : {}),
    ...(native.get('sessionPersistence', false) ? { persistence: native.get('sessionPersistence', false) as any } : {}),
    ...(native.get('subprocess', false) ? { subprocess: native.get('subprocess', false) as any } : {}),
    ...(native.get('workspaceChanges', false) ? { workspaceChanges: native.get('workspaceChanges', false) as any } : {}),
    ...(llm ? { llm } : {}),
    ...(modelCatalog ? { catalog: modelCatalog } : {}),
  }, reviewConfig) : undefined
  const decisions = options.decisions ?? createDecisionService(ctx, runtime, TypedDecisionsConfig.parse(options.typedDecisions ?? {}), MemoryReuseConfig.parse(options.memoryReuse ?? {}), SemanticCompactionConfig.parse(options.semanticCompaction ?? {}), root)
  const modelAutoConfig = ModelAutoConfig.parse(options.modelAutoMode ?? {})
  const modelAuto = new ModelAutoCoordinator(new ModelAutoStore(runtime, modelAutoConfig.mode, canonicalContentHash(modelAutoConfig)), decisions, modelCatalog, modelAutoConfig)
  const answerReview = new AnswerReviewCoordinator(runtime, decisions, AnswerReviewConfig.parse(options.answerReview ?? {}))
  const semanticCompaction = options.semanticCompactionCoordinator ?? new SemanticCompactionCoordinator(ctx as any, decisions, root, options.observationPack)
  const modelHandoff = new ModelHandoff(ctx as any, decisions, root, options.modelHandoff)
  const lifecycleMemory = new DshLifecycleMemory(ctx as any, runtime, root)
  const delegation = new DshEnnoDelegation(runtime, native.get('subagents', false) as DshSpawnBackend | undefined)
  const deepPlanning = new DeepPlanningController({ runtime, decisions, ctx: ctx as any, backend: native.get('subagents', false) as DshSpawnBackend | undefined,
    sessions, agents, catalog: modelCatalog, questions: userQuestions, routes: options.modelRoutes ?? [], compatibility: modelCompatibility, sessionQuery, config: options.deepPlanning,
    capabilities: async (agent, signal) => {
      const catalog = await capabilityCatalog(skills, tools, { cwd: root, signal, agent, nativeAgent: agent })
      return [...catalog.skills, ...catalog.tools]
    },
  })
  const isGenericNativeChild = (agent: { session?: { header?: { parentSession?: string; origin?: string; delegationDepth?: number } } }): boolean =>
    isNativeSubagent(agent) && !delegation.isChild(agent) && !deepPlanning.executor.isChild(agent)
  const childGuardDisposer = tools?.guard((value) => {
    const execution = value as { agent?: object; name?: string; arguments?: unknown }
    return execution.agent ? delegation.toolDenial(execution.agent, execution.name ?? '', execution.arguments) : undefined
  })
  const childExecutionDisposer = onNativeEvent(ctx, 'tools/execute', async (execution: { agent?: object; name: string; arguments: unknown }, next: () => Promise<unknown>) => {
    if (execution.agent && delegation.isChild(execution.agent)) {
      await delegation.assertCurrent(execution.agent)
      const denial = delegation.toolDenial(execution.agent, execution.name, execution.arguments)
      if (denial) throw new KiokukoError('CONFLICT', denial)
    }
    return next()
  }, { prepend: true })
  const sessionCachePath = options.sessionCachePath
    ?? (options.databasePath === undefined ? undefined : `${options.databasePath}.session-cache`)
  const sessionMirror = new DshSessionLogMirror({
    runtime,
    ...(sessionCachePath === undefined ? {} : { databasePath: sessionCachePath }),
    ...(attachments === undefined ? {} : { readAttachment: attachments.readImage.bind(attachments) }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const { finalizationQuery, sessionExport } = createSessionAccess({ native, sessions, sessionQuery, sessionMirror })
  const policy = new DshToolPolicy({ phase: 'intake', runId: 'pending', workspace: 'pending', orchestrationId: 'pending', revision: 1, routeEpoch: 0 })
  const modes = new DshPonytailModes()
  const turnState = createTurnState(modes, policy, runId => selections.get(runId))
  const currentSession = turnState.currentSession
  const currentForAgentEvent = turnState.currentForAgentEvent
  const executionSupport = new DshExecutionSupport(runtime, { continuity: continuityConfig,
    observe: value => efficiencyHost.efficiency?.recordContinuity(value) })
  executionSupport.mount({ on: (name, listener, options) => onNativeServiceEvent(ctx, name, listener, options),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(tools === undefined ? {} : { tools: { guard: tools.guard.bind(tools) } }) })
  const ennoMemory = new DshEnnoMemoryRefresh(runtime, EnnoMemoryConfig.parse(options.ennoMemory ?? {}),
    value => efficiencyHost.efficiency?.recordEnnoMemory(value))
  const { refreshEnnoMemory } = createEnnoMemoryHost({
    ennoMemory, runtime, executionSupport, delegation, getSelection: runId => selections.get(runId),
    turnState, currentSession, capabilityCatalog, skills, tools,
    assertTurnStoppingCatalog: (expected, actual) => gate.assertTurnStoppingCatalog(expected, actual),
    isHumanMessage,
  })
  const executionBinding = turnState.executionBinding
  const memoryFinalizer = new DshMemoryFinalizer({
    onDeepFinalized: sessionId => deepPlanning.deliver(sessionId),
    memoryEvolution: evolutionConfig,
    memoryIndexReasoning: MemoryIndexReasoningConfig.parse(options.memoryIndexReasoning ?? {}),
    autoGlobalizationEnabled: options.autoGlobalization?.enabled ?? true,
    runtime,
    sessionQuery: finalizationQuery,
    onFinalized: (sessionId) => sessionMirror.markFinalized(sessionId),
    ...(llm === undefined ? {} : { llm }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const autoReview = new AutoMemoryReviewCoordinator({ runtime, mirror:sessionMirror,
    config:MemoryReviewConfig.parse(options.memoryReview??{}), ...(llm?{llm}:{}),
    onCapturePolicy:async(sessionId,mode)=>{
      const item=currentSession(sessionId);if(!item)return
      await runtime.withDatabase(db=>saveSessionNotice(db,{id:`capture-notice:${item.runId}:${mode}`,runId:item.runId,sessionId,rootPath:item.cwd,kind:'status',anchorSeq:0,
        text:mode==='held'?'保存拒否の可能性を検出したため、この会話の自動メモリ生成を保留しました。/kioku-memory-review exclude session で除外を確定できます。再開する場合は履歴を継承しない新しい会話を開始してください。':'この会話の自動メモリ生成を除外しました。保存済み記憶と会話ログは残ります。'}))
    },
    onChanged:async(job,result)=>{await runtime.withDatabase(db=>saveSessionNotice(db,{id:`review-notice:${job.id}`,runId:job.run_id,sessionId:job.session_id,rootPath:root,kind:'status',text:`記憶を更新しました（追加${result.added}件、更新${result.updated}件）`,anchorSeq:job.end_seq}))},
    ...(sessions?.flush?{flush:session=>sessions.flush!(session)}:{}),...(options.now?{now:options.now}:{}) })
  const reviewBinding = (item:TurnRecord,session:object) => ({workspace:item.workspace,runId:item.runId,session:session as ReviewNativeSession,startSeq:0})
  deepPlanning.attachFinalizer(() => memoryFinalizer.kick())
  const confirmationAnswerer = userQuestions === undefined ? undefined : createDshConfirmationAnswerer(userQuestions)
  const observation = createSessionObservation(runtime)
  const captureInitialInput = observation.captureInitialInput
  let retireSupersededRun: ((item: TurnRecord, status: 'completed' | 'failed' | 'cancelled') => Promise<void>) | undefined

  const admission = createAdmission({
    native, skills, tools, userQuestions, sessions, agents, deepPlanning, modelCatalog, modelCompatibility,
    modelRoutes: options.modelRoutes, now: options.now, runtime, decisions, answerReview,
    delegation, executionSupport, ennoMemory, memoryFinalizer, autoReview, sessionMirror,
    akinatorMemoryConfig, memoryRetrievalConfig, completionMode, turnState,
    getSelection: runId => selections.get(runId), setSelection: (runId, value) => { selections.set(runId, value) },
    refreshEnnoMemory, executionBinding, captureInitialInput,
    contextMessages: (event, pending) => contextMessages(event, pending),
    resolveIdleClose: (agentId, sessionId, nativeSession, nativeAgent) => resolveIdleClose(agentId, sessionId, nativeSession, nativeAgent),
    retireSupersededRun: (item, status) => {
      if (retireSupersededRun === undefined) throw new Error('kiokuko-dsh run lifecycle is unavailable')
      return retireSupersededRun(item, status)
    },
    cancelBoundarySession: sessionId => boundaryWorker.cancelSession(sessionId),
    isSelectionBlocked: agent => routing.isSelectionBlocked(agent),
    closeTurn: input => runLifecycle.closeTurn(input),
    readStateForRun: item => runtime.withDatabase(db => stateForRun(db, item)),
    capabilityCatalog, sessionEventSource, objectRecord, isHumanMessage,
    textFromMessages, pluginContinuationId, isLoopRecoveryMessage,
  })
  const gate = admission.gate
  const mapPreStep = admission.mapPreStep
  const detachedDemandSessions = new Set<string>()
  // Archive/session-query adapters own no live execution ingress. A partial live
  // tool/agent plane is not that read-only case and must not silently downgrade.
  const conversationFirst = IntakeModeConfig.parse(options.intakeMode) === 'on-demand'
  const hasExecutionIngress = tools !== undefined || agents !== undefined
  const hasDemandTools = typeof objectRecord(tools)?.get === 'function' && typeof tools?.guard === 'function' && typeof tools?.register === 'function'
  if (conversationFirst && hasExecutionIngress && (!hasDemandTools || !agents || !sessions)) {
    throw new Error('Conversation-first execution requires native tools, agents and sessions; read-only history adapters must not expose a partial execution plane')
  }
  const answerCwd = (agent: import('./on-demand-intake.js').DemandAgent): string => {
    const session = agent.session as { id: string; header?: { cwd?: string } } | undefined
    if (!session || agents?.get(agent.id) !== agent || sessions?.get(session.id) !== session
      || typeof session.header?.cwd !== 'string' || !session.header.cwd) throw new Error('On-demand native identity mismatch')
    return realpathSync(session.header.cwd)
  }
  const demand = hasDemandTools && agents && sessions ? new OnDemandIntake({
    ...(userQuestions ? { questions: userQuestions } : {}),
    answerContext: new DshAnswerContext(runtime, { root, cwd: answerCwd, projectOnly: false, memoryRetrieval: memoryRetrievalConfig,
      instructions: (input, task, taskType) => answerSkillContext(input, task, taskType, { skills: skills as AnswerSkillRegistry, prompts: skillPrompts, decisions, cwd: answerCwd(input.agent) }),
    }),
    prepareNativeCoding: async (input, task, requestIntentContext) => {
      const lisp = native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined
      const sessionId = input.agent.session?.id
      if (!lisp?.prepareNative || !sessionId) return
      const requestIntent = requestIntentContext
        ? await classifyRequestIntent(decisions, dshTurnRequestId({ dshSessionId: sessionId, turn: input.turn }), requestIntentContext, input.signal)
        : undefined
      await lisp.prepareNative({ agent: input.agent, turn: input.turn, task, taskType: null, signal: input.signal,
        ...(requestIntent ? { requestIntent } : {}) })
    },
    nativeOwnership: async input => {
      const agent = input.agent as NativeAgent
      answerCwd(agent)
      const session = agent.session
      if (!session?.header) throw new Error('Native ownership requires the current session header')
      const header = session.header as { parentSession?: unknown; isSeeded?: unknown }
      if (header.parentSession || header.isSeeded) return 'owned'
      const jobs = native.get('jobs', false) as { list(sessionId: string): Array<{ status: string }> } | undefined
      if (jobs && jobs.list(session.id).some(job => !['completed', 'killed', 'failed'].includes(job.status))) return 'owned'
      const current = currentSession(session.id)
      const ownership = await runtime.withDatabase(db => nativeExecutionOwnership(db, session.id, current?.runId))
      input.signal.throwIfAborted()
      // Retire only the exact completed in-memory projection proven above.
      // Durable history remains intact; no memory lookup or save is involved.
      if (ownership === 'unowned' && current && currentSession(session.id) === current) turnState.releaseRun(current.runId, current.authority)
      return ownership
    },
    nativeChild: agent => agents?.get(agent.id) === agent && sessions?.get(agent.session?.id ?? '') === agent.session && isNativeSubagent(agent as NativeAgent),
    validate: async input => {
      const agent = input.agent, session = agent.session as { id: string; header?: { cwd?: string } } | undefined
      answerCwd(agent)
      await captureInitialInput(session!.id, input.turn, input.messages)
    },
    advance: async input => {
      policy.beginTurn(input.agent.session!.id, input.turn)
    },
    resumeConfirmation: async input => runtime.withDatabase(async db => {
      const sessionId = input.agent.session!.id
      if (detachedDemandSessions.has(sessionId)) return false
      const current = currentSession(sessionId)
      if (current !== undefined) {
        if (current.nativeAgent !== input.agent || current.nativeSession !== input.agent.session
          || current.turn > input.turn) {
          if (process.env.KIOKUKO_INTENT_DEBUG === '1') console.error('confirmation resume current mismatch', {
            turn: input.turn, currentTurn: current.turn, agent: current.nativeAgent === input.agent,
            session: current.nativeSession === input.agent.session,
          })
          return false
        }
      }
      const project = await resolveProjectWorkspaceReadOnly(db, answerCwd(input.agent), { allowDirectory: true })
      if (!project) return false
      const candidates = db.prepare(`SELECT lr.run_id AS runId
        FROM ledger_runs AS lr
        JOIN enno_contracts AS ec ON ec.run_id = lr.run_id
        WHERE lr.workspace = ? AND lr.dsh_session_id = ? AND lr.status = 'active'
          AND ec.repository_root = ? AND ec.status = 'needs_confirmation'
        ORDER BY lr.created_at, lr.run_id LIMIT 2`)
        .all<{ runId: string }>(project.workspace, sessionId, project.repositoryRoot)
      if (process.env.KIOKUKO_INTENT_DEBUG === '1') console.error('confirmation resume candidates', candidates.length)
      return candidates.length === 1 && (current === undefined || current.runId === candidates[0]!.runId)
    }),
    replay: async input => runtime.withDatabase(db => {
      const sessionId = input.agent.session!.id
      if (detachedDemandSessions.has(sessionId)) return false
      const current = currentSession(sessionId)
      // Matching persisted text is a cold continuation, not a replay of a
      // currently admitted native turn. Leave it on the interpretation path.
      if (!current || current.turn !== input.turn || current.nativeAgent !== input.agent
        || current.nativeSession !== input.agent.session || agents?.get(input.agent.id) !== input.agent
        || sessions?.get(sessionId) !== input.agent.session || current.closed || current.failed
        || !current.authority || current.prepared.run.status !== 'active'
        || !['ready', 'exhausted'].includes(current.prepared.intake.status)
        || current.prepared.nextAction !== 'proceed' || selections.get(current.runId)?.value.discussion) return false
      const human = input.messages.filter(isHumanMessage)
      if (!human.length) return false
      const task = textFromMessages(human)
      const references = current.requestIntentContext?.messageRefs
      if (current.task !== task || !references
        || canonicalContentHash(requestIntentMessageRefs(human, task)) !== canonicalContentHash(references)) return false
      try { authorizeTaskLease(db, current.authority) } catch { return false }
      return true
    }),
    existing: async (input, requestIntent?: RequestIntentDecision) => runtime.withDatabase(async db => {
      if (detachedDemandSessions.has(input.agent.session!.id)) return false
      const current = currentSession(input.agent.session!.id)
      // A retired native identity is not live execution authority. Keep its durable
      // owner intact, but let a reopened session answer before attempting recovery.
      // A queued human request is not a continuation grant from a stale normal
      // turn. Preserve its owner, but infer the new request before any effects.
      const text = input.messages.filter(isHumanMessage).flatMap((message: any) => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n')
      const keepsCurrentScope = requestIntent?.relation !== 'new'
      const resumeCoding = keepsCurrentScope && current && readCodingWorkflow(db, current.runId)
      if (current && current.turn < input.turn && input.messages.some(isHumanMessage) && !current.prepared.ennoOduno.applicable && !resumeCoding) return false
      if (current) return !current.closed && !current.failed && current.nativeAgent === input.agent && current.nativeSession === input.agent.session
      const project = await resolveProjectWorkspaceReadOnly(db, answerCwd(input.agent), { allowDirectory: true })
      if (!project) return false
      // The full adapter owns ledger runs, not the modular core ownership table.
      // Recovery still goes through admission's exact workspace/session checks.
      return Boolean(db.prepare(`SELECT 1 FROM ledger_runs lr
        LEFT JOIN enno_contracts ec ON ec.run_id=lr.run_id
        LEFT JOIN dsh_coding_workflows cw ON cw.run_id=lr.run_id
        WHERE lr.workspace=? AND lr.dsh_session_id=? AND lr.status='active'
          AND ((ec.repository_root=? AND ec.status NOT IN ('completed','cancelled','blocked'))
            OR (?=1 AND json_extract(cw.snapshot_json,'$.state') NOT IN ('completed','cancelled','superseded'))) LIMIT 1`)
        .get(project.workspace, input.agent.session!.id, project.repositoryRoot, requestIntent?.relation === 'new' ? 0 : 1))
    }),
    classify: (input, task) => classifyTaskForIntake(decisions, dshTurnRequestId({ dshSessionId: input.agent.session!.id, turn: input.turn }), task, undefined, input.signal),
    interpret: input => admission.interpret({ agent: input.agent as NativeAgent, messages: input.messages, turn: input.turn, step: input.step, signal: input.signal } as any),
    prepare: async (input, taskType, requestIntent) => {
      const event = await admission.mapPreStep(input, taskType, requestIntent)
      const result = await gate.prepareRequestedWork(event)
      if (result.admitted) detachedDemandSessions.delete(input.agent.session!.id)
      return result.admitted && result.prepared.intake.profile.taskType !== 'chat'
    },
    ready: (agent, turn) => {
      if (agents?.get(agent.id) !== agent || sessions?.get(agent.session?.id ?? '') !== agent.session) return false
      const current = agent.session && currentSession(agent.session.id)
      return !!current && current.nativeAgent === agent && current.nativeSession === agent.session && (turn === undefined || current.turn === turn)
        && !current.closed && !current.failed && current.prepared.run.status === 'active'
        && ['ready', 'exhausted'].includes(current.prepared.intake.status) && current.prepared.nextAction === 'proceed'
        && !selections.get(current.runId)?.value.discussion
    },
  }, { onlyWhenDeferred: !conversationFirst }) : undefined
  if(demand)lifecycleMemory.connectIntake(demand)
  const taskWorkflow = demand && agents && sessions && skills?.snapshot && tools?.schemas
    ? new DshTaskWorkflow({ runtime, demand, agents, sessions, skills: { snapshot: options => skills.snapshot!(options) },
      tools: { schemas: agent => tools.schemas!(agent) }, lisp: () => native.get(LISP_ASSEMBLY_SERVICE, false) as LispAssemblyService | undefined,
      checkpointSource: async agent => { await sessions.flush?.(agent.session); try { await sessionMirror.checkpointAfterNativeFlush(agent.session as DshMirrorEventSession) } catch { /* Optional mirror cannot veto native completion or Stop. */ } },
      kickFinalizer: () => memoryFinalizer.kick(), emit: task => { (ctx as any).emit(TASK_STATE_EVENT, task) } }) : undefined
  const demandEnd = demand ? onNativeEvent(ctx, 'session/event', (session, event) => {
    if (event.type === 'turn/end') demand.finish(session, (event.data as any)?.turn)
    if (event.type === 'request/context' && !currentSession(session.id)) {
      const answer = demand.answerOwner(session)
      if (answer) {
        const header = [...(answer.agent.session?.snapshotEvents?.() ?? [])].reverse().find(e => e.type === 'request/header')?.data as any
        void memoryFinalizer.admitConversationIndex(answer.workspace, session.id, { ...header?.header?.config, contextWindow: (event.data as any)?.contextWindow },
          () => agents?.get(answer.agent.id) === answer.agent && sessions?.get(session.id) === session
            && demand.answerOwner(session)?.workspace === answer.workspace).catch(() => {})
      }
    }
  }) : undefined
  const demandDisposed = demand ? onNativeEvent(ctx, 'agent/disposed', ({ agent }) => {
    demand.retire(agent)
    const item = agent.session && currentSession(agent.session.id)
    if (item?.nativeAgent !== agent || item.nativeSession !== agent.session) return
    // Drop only dead in-memory bindings. Durable ownership and obligations remain
    // untouched; a reopened session may answer but cannot borrow the old grant.
    detachedDemandSessions.add(item.sessionId)
    gate.clearTurn(item.sessionId, item.turn)
    executionSupport.clear(item.sessionId)
    turnState.releaseRun(item.runId)
  }) : undefined

  const discussionGuardDisposer = tools?.guard((value) => {
    const agent = (value as { agent?: NativeAgent }).agent
    if (!agent?.session) return undefined
    const lispCoding = native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined
    if (lispCoding?.discussing(agent)) return 'Lispモードの選択への自由入力に回答中です。ツールを使わず、ユーザーの発言に回答してください。'
    const item = currentSession(agent.session.id)
    if (item?.nativeAgent === agent && item.nativeSession === agent.session && selections.get(item.runId)?.value.discussion) {
      return '自由入力への回答中です。実行方式は未確定です。ツールを使わず、ユーザーの発言に回答してください。'
    }
    return undefined
  })
  const pairChanges = new Map<string, Promise<void>>()
  const pairLlm = native.get('llm', false) as object | undefined
  const ownsPairRoot = (agent: RoutableAgent): boolean => {
    if (!agent.session || isNativeSubagent(agent) || agents?.get(agent.id) !== agent || sessions?.get(agent.session.id) !== agent.session) return false
    try { return typeof agent.session.header?.cwd === 'string' && realpathSync(agent.session.header.cwd) === root } catch { return false }
  }
  const nativeWorkers = new NativeWorkerRouting({
    runtime, backend: native.get('subagents', false) as any, agents, sessions,
    resolveOwner: async (agent, signal) => {
      if (!ownsPairRoot(agent)) return undefined
      await pairChanges.get(agent.session!.id)
      signal.throwIfAborted()
      const item = currentSession(agent.session!.id)
      if (item && !item.closed) {
        const stored = await runtime.withDatabase(db => readExecutionSelection(db, item.runId))
        if (stored?.value.headWorker) {
          if (item.nativeAgent !== agent || item.nativeSession !== agent.session || item.failed) throw new KiokukoError('CONFLICT', 'Head/worker execution owner changed')
          if (stored.value.status !== 'ready' || stored.value.discussion) throw new KiokukoError('CONFLICT', 'Head/worker selection is not ready')
          return { id: `run:${item.runId}`, sessionId: item.sessionId, selectionId: String(stored.revision), pair: stored.value.headWorker }
        }
        // An existing approved Enno or Deep configuration owns its own roles.
        if (stored?.value.mode === 'enno' || stored?.value.mode === 'deep-thinker') return undefined
      }
      if (!pairLlm) return undefined
      const saved = await getHeadWorkerSessionSelection(pairLlm, agent.session!.id)
      return saved.configuration ? { id: `session:${agent.session!.id}`, sessionId: agent.session!.id, selectionId: String(saved.revision), pair: saved.configuration } : undefined
    },
    validate: async (pair, signal) => {
      if (!modelCatalog) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Head/worker model catalog is unavailable')
      signal.throwIfAborted()
      const problems = await validateHeadWorker(pair, modelCatalog, options.modelRoutes ?? [], modelCompatibility)
      signal.throwIfAborted()
      if (problems.length) throw new KiokukoError('CONFLICT', problems.join('\n'))
    },
  })
  const nativeWorkerToolDisposer = onNativeEvent(ctx, 'tools/execute', async (execution, next) => {
    if (execution.agent && isGenericNativeChild(execution.agent as RoutableAgent)) await nativeWorkers.assertCurrent(execution.agent as RoutableAgent)
    return next()
  }, { prepend: true })
  const freezePair = (agent: RoutableAgent): void => {
    if (!pairLlm || !ownsPairRoot(agent)) return
    const pending = getHeadWorkerSessionSelection(pairLlm, agent.session!.id).then(() => {})
    pairChanges.set(agent.session!.id, pending)
    void pending.catch(() => {})
  }
  const freezePairDisposer = onNativeEvent(ctx, 'agent/created', ({ agent }) => freezePair(agent))
  for (const agent of agents?.list?.() ?? []) freezePair(agent)
  const clearRunPair = async (sessionId: string, isCurrent: () => boolean = () => true): Promise<void> => {
    const session = sessions?.get(sessionId)
    const agent = agents?.list?.().find(candidate => candidate.session === session)
    if (!agent || !ownsPairRoot(agent)) return
    const item = currentSession(sessionId)
    if (item && !item.closed && item.nativeAgent === agent && item.nativeSession === session) await runtime.withDatabase(db => {
      if (!isCurrent()) return
      const stored = readExecutionSelection(db, item.runId)
      if (stored?.value.mode === 'normal' && stored.value.headWorker) {
        const { headWorker: _pair, ...value } = stored.value
        selections.set(item.runId, writeExecutionSelection(db, item.runId, stored.revision, value))
      }
    })
  }
  const pairSettingsDisposer = onNativeServiceEvent(ctx, 'kiokuko/head-worker-selected', (sessionId: string) => {
    // The settings commit and normal-run override removal are one dispatch fence.
    const pending: Promise<void> = Promise.resolve().then(() => clearRunPair(sessionId, () => pairChanges.get(sessionId) === pending))
    pairChanges.set(sessionId, pending)
    void pending.catch(() => {})
    return pending
  })
  const pairSelectionDisposer = onNativeEvent(ctx, 'session/event', (session, event) => {
    if (event.type !== 'model/selection' || sessions?.get(session.id) !== session || !pairLlm) return
    const agent = agents?.list?.().find(candidate => candidate.session === session)
    if (!agent || !ownsPairRoot(agent)) return
    const previous = pairChanges.get(session.id)
    const pending: Promise<void> = Promise.resolve(previous).catch(() => {}).then(async () => {
      const isCurrent = () => pairChanges.get(session.id) === pending
      if (!isCurrent()) return
      const item = currentSession(session.id)
      const stored = item && !item.closed ? await runtime.withDatabase(db => readExecutionSelection(db, item.runId)) : undefined
      if (!isCurrent()) return
      const configured = stored?.value.headWorker ?? (await getHeadWorkerSessionSelection(pairLlm, session.id)).configuration
      if (!isCurrent()) return
      const selected = event.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
      // Native pickers may publish an idempotent re-selection of the same head.
      if (configured && selected?.provider === configured.head.provider && selected.model === configured.head.model) {
        if (typeof selected.reasoningEffort === 'string' && selected.reasoningEffort && selected.reasoningEffort !== configured.head.reasoningEffort) {
          const pair = { ...configured, head: { ...configured.head, reasoningEffort: selected.reasoningEffort } }
          if (stored?.value.mode === 'normal' && stored.value.headWorker && item) {
            if (!modelCatalog) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Head/worker model catalog is unavailable')
            const problems = await validateHeadWorker(pair, modelCatalog, options.modelRoutes ?? [], modelCompatibility)
            if (problems.length) throw new KiokukoError('CONFLICT', problems.join('\n'))
            await runtime.withDatabase(db => {
              if (!isCurrent()) return
              selections.set(item.runId, writeExecutionSelection(db, item.runId, stored.revision, { ...stored.value, headWorker: pair }))
            })
          }
          const saved = await getHeadWorkerSessionSelection(pairLlm, session.id)
          if (!isCurrent()) return
          if (saved.configuration?.head.provider === selected.provider && saved.configuration.head.model === selected.model)
            await updateHeadWorkerEffortForSession(pairLlm, session.id, selected.reasoningEffort, isCurrent)
        }
        return
      }
      await clearHeadWorkerForSession(pairLlm, session.id, isCurrent)
      await clearRunPair(session.id, isCurrent)
    })
    pairChanges.set(session.id, pending)
    void pending.catch(() => {})
  })
  const routing = createRouting({
    ctx, native, tools, agents, sessions, runtime, modelAuto, answerReview, semanticCompaction, delegation, deepPlanning, isGenericNativeChild, demand, nativeWorkers,
    getSkillPrompts: () => skillPrompts,
    getToolExposureConfig: () => toolExposureConfig, reportToolExposureFallback, reportToolExposureProjection, modelCatalog,
    getSelection: runId => selections.get(runId), setSelection: (runId, value) => { selections.set(runId, value) },
    hasSelection: runId => selections.has(runId), getPolicyState: runId => turnState.policyState(runId),
    captureInitialInput, prepareTurn: event => gate.prepare(event), mapPreStep, currentSession,
    readStateForRun: item => runtime.withDatabase(db => stateForRun(db, item)),
    refreshMemoryOwner: admission.refreshMemoryOwner,
  })
  const contextMessages = createContextMessages({
    ctx, runtime, deepPlanning, executionSupport, continuityMode: continuityConfig.mode,
    getSkillPrompts: () => skillPrompts, systemSkillsFor: routing.systemSkillsFor,
    getSelection: runId => selections.get(runId), currentForAgentEvent, advisoryEvidenceFor: (item, state) => toolHostModule.advisoryEvidenceFor(item, state),
    executionBinding, sessionEventSource,
  })
  const toolHostModule = createToolHost({
    runtime, turnState, currentSession, currentForAgentEvent, skills, tools,
    sessions, agents, gate, decisions, delegation, llm, modelCatalog,
    executionSupport, executionBinding, policy, advisory, capabilityCatalog, objectRecord,
  })
  const { toolHost, advisoryRunner, assertTurnBoundary, submitAdvisory } = toolHostModule
  const advisoryEvidenceFor = toolHostModule.advisoryEvidenceFor
  const boundaries = createBoundaries({
    isGenericNativeChild,
    ctx, runtime, now: options.now, agents, sessions, skills, tools, userQuestions, gate,
    delegation, executionSupport, answerReview, sessionMirror, currentSession, currentForAgentEvent,
    stateForRun, systemSkillsFor: routing.systemSkillsFor, getSkillPrompts: () => skillPrompts,
    refreshEnnoMemory, confirmationAnswerer, assertTurnBoundary, advisoryRunner, submitAdvisory,
    advisoryEvidenceFor, applyPolicy: turnState.applyPolicy, capabilityCatalog,
    closeTurn: input => runLifecycle.closeTurn(input), sessionEventSource,
    boundedUtf8Text, boundedMessageText, recoveryMessage, continuationMessage,
  })
  const { boundaryWorker, ennoController, deliverCompletionReport, boundarySessionStartDisposer } = boundaries
  const applicationDisposer = mountHostMemoryApplication({
    ctx, runtime, tools, commands, skills, agents, sessions, delegation, currentSession,
    turnState, gate, capabilityCatalog, memoryRetrievalConfig, demand,
  })
  const codingDisposer = tools ? mountCodingWorkflow({ tools: tools as any,
    on: (name, listener, options) => onNativeServiceEvent(ctx, name, listener, options) }, {
    runtime, ...(userQuestions ? { questions: userQuestions } : {}),
    lisp: () => native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined,
    preparationOnly: execution => demand?.preparationOnly(execution) === true,
    nativeCommand: execution => demand?.nativeCommand(execution) === true,
    nativeLisp: execution => demand?.nativeLisp(execution) === true,
    resolve(execution) {
      const agent = execution.agent as NativeAgent | undefined, session = agent?.session
      if (!agent || !session || agents?.get(agent.id) !== agent || sessions?.get(session.id) !== session) return undefined
      const child = delegation.observationBinding(agent)
      const item = currentSession(child?.parentSessionId ?? session.id)
      if (!item || item.closed || child && child.runId !== item.runId || !child && (item.nativeAgent !== agent || item.nativeSession !== session)) return undefined
      return { runId: item.runId, sessionId: item.sessionId, repositoryRoot: item.repositoryRoot, agent, task: item.task,
        requestIntent: item.requestIntent, requestIntentContext: item.requestIntentContext }
    },
  }) : undefined
  const completionDisposer = tools ? mountTaskCompletion({ tools: tools as any,
    on: (name, listener, options) => onNativeServiceEvent(ctx, name, listener, options) }, {
    runtime,
    resolve(execution) {
      const agent = execution.agent as NativeAgent | undefined
      const session = agent?.session
      const item = session ? currentSession(session.id) : undefined
      if (!agent || !session || agents?.get(agent.id) !== agent || sessions?.get(session.id) !== session
        || !item || item.closed || item.nativeAgent !== agent || item.nativeSession !== session
        || delegation.isChild(agent) || isGenericNativeChild(agent)) return undefined
      return { runId: item.runId, sessionId: item.sessionId, repositoryRoot: item.repositoryRoot, agent }
    },
    async approve() { return true },
  }) : undefined
  const resolveParentOwned = (execution:any) => {
      const agent=execution.agent as NativeAgent|undefined,session=agent?.session
      if(!agent||!session||agents?.get(agent.id)!==agent||sessions?.get(session.id)!==session||isGenericNativeChild(agent))return undefined
      const child=delegation.observationBinding(agent)
      const item=currentSession(child?.parentSessionId??session.id)
      if(!item||item.closed||child&&child.runId!==item.runId||!child&&(item.nativeAgent!==agent||item.nativeSession!==session))return undefined
      if(child&&delegation.toolDenial(agent,execution.name,execution.arguments))return undefined
      return {runId:item.runId,sessionId:session.id,workflowSessionId:item.sessionId,workspace:item.workspace,repositoryRoot:item.repositoryRoot,generation:executionBinding(item).generation,agent,
        requestIntent:item.requestIntent,requestIntentContext:item.requestIntentContext}
  }
  const nativeTaskAuthority = new NativeTaskAuthority({runtime,repositoryRoot:root,backend:native.get('subagents',false) as any,agents,sessions,resolveParent:resolveParentOwned})
  const ownedDisposer = tools ? mountOwnedExecution({tools:tools as any,on:(name,listener,options)=>onNativeServiceEvent(ctx,name,listener,options)}, {
    runtime,
    unownedNative: execution => demand?.unownedNative(execution as any) === true,
    nativeCommand: execution => demand?.nativeCommand(execution as any) === true,
    nativeLisp: execution => demand?.nativeLisp(execution as any) === true,
    isTaskControl: execution => (ctx.get(TASK_WORKFLOW_SERVICE, false) as DshTaskWorkflow | undefined)?.isControl(execution) === true,
    resolve: execution => nativeTaskAuthority.resolve(execution) ?? resolveParentOwned(execution),
    async resolveRead(execution) {
      const agent = execution.agent as NativeAgent|undefined, session = agent?.session
      if (!agent || !session || agents?.get(agent.id)!==agent || sessions?.get(session.id)!==session) return undefined
      let cwd: string
      try { if (typeof session.header?.cwd !== 'string') return undefined; cwd = realpathSync(session.header.cwd) } catch { return undefined }
      // Child scopes retain their independent lineage checks. A primary session
      // may have been admitted from a directory other than plugin startup cwd.
      if (isGenericNativeChild(agent)) return cwd === root ? nativeTaskAuthority.read(execution) : undefined
      if (delegation.isChild(agent)) return cwd === root ? resolveParentOwned(execution) : undefined
      const current=resolveParentOwned(execution)
      if(execution.name==='kioku_read'&&current) {
        const item = currentSession(session.id)
        if (!item?.authority || item.cwd !== cwd || item.repositoryRoot !== current.repositoryRoot) return undefined
        const authority = item.authority
        try { await runtime.withDatabase(db => authorizeTaskLease(db, authority)) } catch { return undefined }
        if (currentSession(session.id) !== item || item.authority !== authority || item.closed
          || agents?.get(agent.id) !== agent || sessions?.get(session.id) !== session) return undefined
        return current
      }
      return await runtime.withDatabase(async db => {
        const project = await resolveProjectWorkspaceReadOnly(db, cwd, { allowDirectory: true })
        return project ? readOwnedIdentity(db,agent,project.repositoryRoot,execution.name==='kioku_result'?execution.arguments?.operationId:undefined) : undefined
      }) ?? resolveParentOwned(execution)
    },
    planActive:agent=>(ctx.get('planMode',false) as any)?.get(agent)?.active===true,
    async confirm(identity,detail,signal) {
      if(!userQuestions)return false
      const id=`kioku-destructive-${crypto.randomUUID()}`
      const answer=await userQuestions.ask({agent:identity.agent,signal,questions:[{id,header:'破壊的変更の確認',question:'この対象への変更を許可しますか？',detail,options:[{label:'許可しない'},{label:'許可する'}]}]})
      return answer.answers?.[0]?.id===id&&answer.answers[0].selected?.[0]==='許可する'
    },
  }):undefined
  const planDisposer=mountPlanTransition({on:(name,listener,options)=>onNativeServiceEvent(ctx,name,listener,options)},ctx.get('planMode',false))
  const observationMount = observation.install({
    ctx, ennoMemory, evolutionConfig, memoryFinalizer, currentSession, currentForAgentEvent,
    answerReview, markModelUnavailable: agent => routing.markModelUnavailable(agent),
    recordManualChange: (sessionId, pending) => routing.recordManualChange(sessionId, pending),
    modelAuto, root, autoReview, reviewBinding, sessionMirror, executionSupport,
    kickBoundary: (sessionId, agent) => {
      if (agent && isGenericNativeChild(agent as NativeAgent)) return
      const nativeAgent = agents?.get(agent?.id ?? currentSession(sessionId)?.agentId ?? sessionId)
      if (nativeAgent && demand?.awaitingClarification(nativeAgent)) return
      if (!nativeAgent || !isGenericNativeChild(nativeAgent)) boundaryWorker.kick(sessionId, agent)
    },
    stateForRun, objectRecord, isHumanMessage, eventContinuationId,
  })
  const lifecycle = createLifecycle({
    awaitingClarification: agent => demand?.awaitingClarification(agent) ?? false,
    runtime, sessions, sessionMirror, memoryFinalizer, autoReview, answerReview, ennoController,
    ennoMemory, executionSupport, gate, turnState, getSelection: runId => selections.get(runId),
    currentSession, currentForAgentEvent, stateForRun, deliverCompletionReport, reviewBinding,
    evolutionConfig, clearToolRun: toolHostModule.clearRun, sessionEventSource,
    onRunClosed: (runId, status, sessionId) => lifecycleMemory.completed(runId, status, sessionId),
  })
  const { runLifecycle, resolveIdleClose, resolveSessionRunId, resolveSessionClose } = lifecycle
  retireSupersededRun = lifecycle.retireSupersededRun

  const agenticReplayConfig = AgenticReplayConfig.parse(options.agenticReplay ?? {})
  const agenticReplay = !agenticReplayConfig.enabled ? undefined : createDshAgenticReplayHost(ctx, agenticReplayConfig, runtime, {
    session: id => sessions?.get(id), agent: id => agents?.get(id), logicalRun: resolveSessionRunId,
    ...(userQuestions ? { questions: userQuestions } : {}),
    interactive: agent => !delegation.isChild(agent) && !deepPlanning.executor.isChild(agent),
    recordingRun: agent => deepPlanning.executor.recordingRun(agent),
    recordingParent: agent => deepPlanning.executor.recordingParent(agent),
  })
  let disposePromise: Promise<void> | undefined
  if (agenticReplay) lifecycleMemory.connectAgenticReplay(agenticReplay)
  const efficiencyHost = createEfficiencyHost({ ctx, memoryFinalizer, agents, sessions, delegation, deepPlanning, currentSession })
  efficiencyHost.configure({ observe: efficiencyConfig.observe, inputMode: finalizationConfig.inputMode })
  // Register last so deferred preparation precedes the existing memory/completion pre-execute checks.
  if (demand) demand.mount(ctx as any, tools as any, systemPrompt)
  // Observe the bound identity before inner pre-execute policies can refuse a tool.
  executionSupport.mountPreExecution({ on: (name, listener, options) => onNativeServiceEvent(ctx, name, listener, options) })
  const host: DshCompositionHost = {
    ...(demand ? { onDemandIntake: demand } : {}),
    ...(taskWorkflow ? { taskWorkflow } : {}),
    bypassNativeIntake: isGenericNativeChild,
    modelAuto: { coordinator: modelAuto, validSession: (agentId, sessionId) => {
      const currentAgent = agents?.get(agentId) as { session?: object } | undefined
      const currentNativeSession = sessions?.get(sessionId)
      // Web sessions can belong to a workspace other than DSH's launch directory.
      return Boolean(currentAgent && currentNativeSession && currentAgent.session === currentNativeSession)
    } },
    ...(diffReview ? { diffReview } : {}),
    decisions,
    semanticCompaction,
    deepPlanning,
    get efficiency() { return efficiencyHost.efficiency },
    configureEfficiency: efficiencyHost.configure,
    get skillPrompts() { return skillPrompts },
    configureSkillPrompts(prompts) { skillPrompts = prompts },
    configureEnnoMemory: config => ennoMemory.configure(config),
    configureToolExposure: config => { toolExposureConfig = ToolExposureConfig.parse(config) },
    modelToolDefinitionsChanged: routing.modelToolDefinitionsChanged,
    memoryReview: createMemoryReviewHost({ runtime, autoReview, root, currentSession, objectRecord,
      memoryFinalizer, sessionMirror, reviewBinding }),
    memoryIndexReasoning: {configure:config=>memoryFinalizer.configureMemoryIndexReasoning(config),command:(sessionId,raw)=>memoryFinalizer.indexCommand(sessionId,raw)},
    memoryEvolution: createEvolutionHost({ runtime, memoryFinalizer, evolutionConfig }),
    autoGlobalization: { configure(enabled: boolean) { memoryFinalizer.configureAutoGlobalization(enabled) } },
    ...(agenticReplay === undefined ? {} : { agenticReplay }),
    ...(skills === undefined ? {} : { skills: skills as any }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    runtime,
    runtimeOwner: options.runtime ? 'external' : 'host',
    ...(userQuestions === undefined ? {} : { userQuestions }),
    ...(commands === undefined ? {} : { commands: commands as any }),
    ponytailModes: modes,
    ...(tools === undefined ? {} : {
      tools: { register: tools.register.bind(tools) as any, guard: tools.guard.bind(tools) as any },
      toolHost,
      toolPolicy: policy,
    }),
    ...(tools === undefined ? {} : { intakeGate: gate, mapPreStep }),
    memoryFinalizer,
    memoryFinalizerOwner: 'host',
    sessionMirror,
    sessionMirrorOwner: 'host',
    sessionExport,
    checkpointSessionMirror: (session) => sessionMirror.checkpointAfterNativeFlush(session as DshMirrorEventSession),
    resolveSessionRunId,
    boundaryWorker,
    boundaryWorkerOwner: 'host',
    lifecycle: runLifecycle,
    lifecycleOwner: 'host',
    resolveIdleClose,
    resolveSessionClose,
  }

  return {
    host,
    dispose: () => disposePromise ??= (async () => {
      demand?.stop()
      await ownedDisposer?.()
      planDisposer()
      await demand?.drain()
      await diffReview?.dispose()
      await answerReview.dispose()
      semanticCompaction.stop()
      modelHandoff.stop()
      await semanticCompaction.drain()
      await modelHandoff.drain()
      await deepPlanning.stop()
      await autoReview.dispose()
      await memoryFinalizer.dispose()
      await deepPlanning.dispose()
      await demand?.dispose()
      demandEnd?.()
      demandDisposed?.()
      childGuardDisposer?.()
      discussionGuardDisposer?.()
      childExecutionDisposer()
      routing.dispose()
      nativeTaskAuthority.dispose()
      nativeWorkers.dispose()
      nativeWorkerToolDisposer()
      freezePairDisposer()
      pairSelectionDisposer()
      pairSettingsDisposer()
      const failures: unknown[] = []
      try { await agenticReplay?.shutdown() } catch (error) { failures.push(error) }
      const pausedSessions = new Set(turnState.sessionIds().filter(id => executionSupport.paused(id)))
      ennoMemory.close()
      executionSupport.dispose()
      try { observationMount.disposeError() } catch (error) { failures.push(error) }
      try { observationMount.disposeSession() } catch (error) { failures.push(error) }
      try { boundarySessionStartDisposer?.() } catch (error) { failures.push(error) }
      try { policy.dispose() } catch (error) { failures.push(error) }
      try { modes.dispose() } catch (error) { failures.push(error) }
      try { ennoController.dispose() } catch (error) { failures.push(error) }
      try { await boundaryWorker.dispose() } catch (error) { failures.push(error) }
      failures.push(...await lifecycle.closeRemainingRuns(pausedSessions))
      try { await runLifecycle.dispose() } catch (error) { failures.push(error) }
      lifecycleMemory.stop()
      try { await lifecycleMemory.whenIdle() } catch { /* optional observations cannot veto shutdown */ }
      try { observationMount.disposeIdle(); await autoReview.dispose() } catch (error) { failures.push(error) }
      try { await memoryFinalizer.dispose() } catch (error) { failures.push(error) }
      efficiencyHost.close()
      try { applicationDisposer?.() } catch (error) { failures.push(error) }
      try { completionDisposer?.() } catch (error) { failures.push(error) }
      try { codingDisposer?.() } catch (error) { failures.push(error) }
      try { observationMount.disposeResult() } catch (error) { failures.push(error) }
      try { await sessionMirror.close() } catch (error) { failures.push(error) }
      try { if (!options.runtime) await runtime.close() } catch (error) { failures.push(error) }
      turnState.clear()
      toolHostModule.clear()
      boundaries.clear()
      admission.clear()
      observation.clear()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh adapter disposal failed')
    })(),
  }
}

function stateForRun(database: any, item: TurnRecord): EnnoOdunoState {
  if (!item.prepared.ennoOduno.applicable) return item.prepared.ennoOduno
  return stateForSnapshot(readEnnoSnapshot(database, { runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId }))
}

export { KIOKUKO_DSH_HOST_SERVICE }
