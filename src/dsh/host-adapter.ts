import { ObservationPackConfig } from './observation-pack/policy.js'
import { createTurnState, policyState, type TurnRecord } from './host-adapter/turn-state.js'
import { createRouting } from './host-adapter/routing.js'
import { createAdmission } from './host-adapter/admission.js'
import { createSessionObservation } from './host-adapter/session-observation.js'
import { createContextMessages } from './host-adapter/context.js'
import { createToolHost } from './host-adapter/tool-host.js'
import { createBoundaries } from './host-adapter/boundaries.js'
import { createLifecycle } from './host-adapter/lifecycle.js'
import { mountHostMemoryApplication } from './host-adapter/memory-application-host.js'
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



import { DshEnnoMemoryRefresh } from './enno-memory-refresh.js'
import { EnnoMemoryConfig } from './config.js'

import { saveSessionNotice } from './plugin-records.js'
import { MemoryEvolutionConfig, type EvolutionConfig } from '../memory/evolution/contracts.js'
import { evolutionStatus } from '../memory/evolution/store.js'
import { OrcaConfig, EfficiencyConfig, FinalizationConfig, AkinatorMemoryConfig, ContinuityConfig } from './config.js'

import { type StoredExecutionSelection } from './execution-selection.js'

import { LISP_CODING_SERVICE, type LispCodingService } from './lisp/coding-choice.js'


import { DshSkillPrompts } from './skill-prompts.js'

import type { ModelRoute, DshModelCatalog, DshModelCompatibility } from './model-configuration.js'
import { nativeModelCatalog } from './native-model-catalog.js'

import { DshEnnoDelegation, type DshSpawnBackend } from './enno-delegation.js'
import { createDshOrcaHost } from './orca-host.js'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

import { Context } from '@deepseek-ai/cordis'
import { KIOKUKO_DSH_HOST_SERVICE, type DshCompositionHost } from './composition.js'
import { DshRuntime } from './runtime.js'
import type { DshCoreRuntime } from './core-runtime.js'

import { type DshCapabilityReadContext } from './intake-gate.js'





import { DshToolPolicy } from './tool-policy.js'
import { ToolExposureConfig } from './tool-exposure.js'
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
  readonly answerReview?: import('zod').z.input<typeof AnswerReviewConfig>
  readonly decisions?: DecisionService
  readonly semanticCompactionCoordinator?: SemanticCompactionCoordinator
  readonly observationPack?: import('zod').z.input<typeof ObservationPackConfig>
  readonly semanticCompaction?: import('zod').z.input<typeof SemanticCompactionConfig>
  readonly modelHandoff?: import('zod').z.input<typeof ModelHandoffConfig>
  readonly modelAutoMode?: import('zod').z.input<typeof ModelAutoConfig>
  readonly typedDecisions?: import('zod').z.input<typeof TypedDecisionsConfig>
  readonly memoryReuse?: import('zod').z.input<typeof MemoryReuseConfig>
  /** An enclosing composition owns and closes this shared runtime. */
  readonly runtime?: DshCoreRuntime
  readonly skillPrompts?: DshSkillPrompts
  readonly deepPlanning?: unknown
  readonly akinatorMemory?: import('zod').z.input<typeof AkinatorMemoryConfig>
  readonly efficiency?: import('zod').z.input<typeof EfficiencyConfig>
  readonly ennoMemory?: import('zod').z.input<typeof EnnoMemoryConfig>
  readonly continuity?: import('zod').z.input<typeof ContinuityConfig>
  readonly memoryEvolution?: import('zod').z.input<typeof MemoryEvolutionConfig>
  readonly autoGlobalization?: { enabled?: boolean }
  readonly memoryReview?: import('zod').z.input<typeof MemoryReviewConfig>
  readonly finalization?: import('zod').z.input<typeof FinalizationConfig>
  readonly modelRoutes?: readonly ModelRoute[]
  readonly modelCompatibility?: DshModelCompatibility
  readonly orca?: import('zod').z.input<typeof OrcaConfig>
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
  const nativeTools = await tools.schemas(scope)
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
  const reportToolExposureFallback = (fallback: string): void => {
    if (toolExposureConfig.mode !== 'phase' || reportedToolExposureFallbacks.has(fallback)) return
    reportedToolExposureFallbacks.add(fallback)
    console.warn(`[kiokuko-dsh] [warn] toolExposure left the native surface unchanged: ${fallback}`)
  }
  const efficiencyConfig = EfficiencyConfig.parse(options.efficiency ?? {})
  const continuityConfig = ContinuityConfig.parse(options.continuity ?? {})
  const evolutionConfig = MemoryEvolutionConfig.parse(options.memoryEvolution ?? {})
  const finalizationConfig = FinalizationConfig.parse(options.finalization ?? {})
  const native = ctx as unknown as AdapterContext
  const skills = native.get('skills', false) as NativeSkills | undefined
  const systemPrompt = native.get('systemPrompt', false) as DshCompositionHost['systemPrompt'] | undefined
  const tools = native.get('tools', false) as NativeTools | undefined
  const commands = native.get('commands', false) as NativeCommands | undefined
  const userQuestions = native.get('userQuestions', false) as DshUserQuestions | undefined
  const sessions = native.get('sessions', false) as NativeSessions | undefined
  const agents = native.get('agents', false) as NativeAgents | undefined
  const attachments = native.get('attachments', false) as NativeAttachments | undefined
  const sessionQuery = options.sessionQuery ?? native.get('sessionQuery', false) as DshSessionQuery | undefined
  const llm = options.llm ?? native.get('llm', false) as DshLlm | undefined
  const reviewConfig = DiffReviewConfig.parse(options.diffReview ?? {})
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
  const delegation = new DshEnnoDelegation(runtime, native.get('subagents', false) as DshSpawnBackend | undefined)
  const deepPlanning = new DeepPlanningController({ runtime, decisions, ctx: (ctx.root ?? ctx) as any, backend: native.get('subagents', false) as DshSpawnBackend | undefined,
    sessions, agents, catalog: modelCatalog, questions: userQuestions, routes: options.modelRoutes ?? [], compatibility: modelCompatibility, sessionQuery, config: options.deepPlanning,
    capabilities: async (agent, signal) => {
      const catalog = await capabilityCatalog(skills, tools, { cwd: root, signal, agent, nativeAgent: agent })
      return [...catalog.skills, ...catalog.tools]
    },
  })
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
    akinatorMemoryConfig, turnState,
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
  const routing = createRouting({
    ctx, native, tools, agents, sessions, runtime, modelAuto, answerReview, semanticCompaction, delegation, deepPlanning,
    getSkillPrompts: () => skillPrompts,
    getToolExposureConfig: () => toolExposureConfig, reportToolExposureFallback,
    getSelection: runId => selections.get(runId), setSelection: (runId, value) => { selections.set(runId, value) },
    hasSelection: runId => selections.has(runId), getPolicyState: runId => turnState.policyState(runId),
    captureInitialInput, prepareTurn: event => gate.prepare(event), mapPreStep, currentSession,
    readStateForRun: item => runtime.withDatabase(db => stateForRun(db, item)),
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
    turnState, gate, capabilityCatalog,
  })
  const observationMount = observation.install({
    ctx, ennoMemory, evolutionConfig, currentSession, currentForAgentEvent,
    answerReview, markModelUnavailable: agent => routing.markModelUnavailable(agent),
    recordManualChange: (sessionId, pending) => routing.recordManualChange(sessionId, pending),
    modelAuto, root, autoReview, reviewBinding, sessionMirror, executionSupport,
    kickBoundary: (sessionId, agent) => boundaryWorker.kick(sessionId, agent),
    stateForRun, objectRecord, isHumanMessage, eventContinuationId,
  })
  const lifecycle = createLifecycle({
    runtime, sessions, sessionMirror, memoryFinalizer, autoReview, answerReview, ennoController,
    ennoMemory, executionSupport, gate, turnState, getSelection: runId => selections.get(runId),
    currentSession, currentForAgentEvent, stateForRun, deliverCompletionReport, reviewBinding,
    evolutionConfig, clearToolRun: toolHostModule.clearRun, sessionEventSource,
  })
  const { runLifecycle, resolveIdleClose, resolveSessionRunId, resolveSessionClose } = lifecycle
  retireSupersededRun = lifecycle.retireSupersededRun

  const orcaConfig = OrcaConfig.parse(options.orca ?? {})
  const orca = !orcaConfig.enabled ? undefined : createDshOrcaHost(ctx, orcaConfig, runtime, {
    session: id => sessions?.get(id), agent: id => agents?.get(id), logicalRun: resolveSessionRunId,
    ...(userQuestions ? { questions: userQuestions } : {}),
    interactive: agent => !delegation.isChild(agent) && !deepPlanning.executor.isChild(agent),
    recordingRun: agent => deepPlanning.executor.recordingRun(agent),
    recordingParent: agent => deepPlanning.executor.recordingParent(agent),
  })
  let disposePromise: Promise<void> | undefined
  const efficiencyHost = createEfficiencyHost({ ctx, memoryFinalizer, agents, sessions, delegation, deepPlanning, currentSession })
  efficiencyHost.configure({ observe: efficiencyConfig.observe, inputMode: finalizationConfig.inputMode })
  const host: DshCompositionHost = {
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
    memoryEvolution: createEvolutionHost({ runtime, memoryFinalizer, evolutionConfig }),
    autoGlobalization: { configure(enabled: boolean) { memoryFinalizer.configureAutoGlobalization(enabled) } },
    ...(orca === undefined ? {} : { orca }),
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
      childGuardDisposer?.()
      discussionGuardDisposer?.()
      childExecutionDisposer()
      routing.dispose()
      const failures: unknown[] = []
      try { await orca?.shutdown() } catch (error) { failures.push(error) }
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
      try { observationMount.disposeIdle(); await autoReview.dispose() } catch (error) { failures.push(error) }
      try { await memoryFinalizer.dispose() } catch (error) { failures.push(error) }
      efficiencyHost.close()
      try { applicationDisposer?.() } catch (error) { failures.push(error) }
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
