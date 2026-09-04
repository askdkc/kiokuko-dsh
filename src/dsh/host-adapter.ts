import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  KIOKUKO_DSH_HOST_SERVICE,
  type DshCompositionHost,
  type DshNativePreStepPayload,
} from './composition.js'
import { DshRuntime } from './runtime.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { DshIntakeGate, type DshCapabilityReadContext, type DshIntakeGateResult, type DshPreStepDecision, type DshPreStepEvent } from './intake-gate.js'
import { resolveGroundedIntakeProfile } from './intake-profile-resolver.js'
import type { PreparedAgentTask } from './task-intake.js'
import { deriveAkinatorReasoning } from '../akinator/reasoning.js'
import { resolveCapabilities } from '../akinator/capabilities.js'
import { readAkinatorSession, readRunIntakeLink } from '../akinator/store.js'
import { DshToolPolicy, type DshToolPolicyState } from './tool-policy.js'
import {
  DSH_MODEL_FACING_OPERATIONS,
  type DshToolExecution,
  type DshToolHostBinding,
  type DshNativeToolExecution,
  type DshToolHost,
} from './tools.js'
import { DshRunLifecycle, type DshCloseIntent, type DshRunClose } from './session-bridge.js'
import { DshMemoryFinalizer, dshTurnBoundarySeq, type DshLlm, type DshLogEvent, type DshSessionEventSource, type DshSessionQuery } from './session-memory-finalizer.js'
import { DshConfirmationController, DshEnnoController } from './enno-controller.js'
import { DshAdvisoryRunner, type DshAdvisoryCall, type DshAdvisoryRoundResult } from './advisory-runner.js'
import { DshPonytailModes, dshPonytailOwnerKey } from './commands.js'
import { createDshIntakeAnswerer, createDshConfirmationAnswerer, type DshUserQuestionAgent, type DshUserQuestions } from './user-interaction.js'
import { createDshCapabilityCatalog, type DshCapabilityCatalog } from './capability-catalog.js'
import { STANDARD_SKILL_MANIFESTS } from './standard-skills.js'
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js'
import { KiokukoError } from '../errors.js'
import { injectDshContext, selectDshDirectiveSources } from './context-injection.js'
import { projectDshDirective } from './directive-projection.js'
import { submitOdunoIdeal, submitEnnoPlan, submitEnnoAdvice, readPendingEnnoAdvice, reportEnnoWork, finishEnno, submitOdunoMeditation, answerEnno, prepareEnnoVerification, stateForSnapshot, type EnnoOperationResponse } from '../enno-oduno/service.js'
import { claimExecutionLeaseInTransaction, readEnnoSnapshot, terminalizeLedgerRunInTransaction } from '../enno-oduno/store.js'
import { decideDshContinuation } from './continuation.js'
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js'
import { curateMemoryCandidates } from '../memory/curator.js'
import { checkpointDshMemory, type ScopedCheckpointInput } from '../memory/scoped-memory.js'
import { LedgerStore } from '../ledger/store.js'
import { ENNO_APPLICABLE_TASK_TYPES, type EnnoExecutionLease, type EnnoNextAction, type EnnoOdunoState } from '../enno-oduno/types.js'
import {
  commitExpectedFailure,
  ennoReceiptOperation,
  isExpectedTurnFailure,
  phaseForOperation,
  prepareTurnIntent,
  readPendingOutbox,
  readTurnSeal,
  markOutboxObservedInTransaction,
  appliedTurnOutcome,
  replacePendingOutboxMessageInTransaction,
  supersedeOutboxAtOrBeforeRevisionInTransaction,
  type DshBoundaryJob,
} from './turn-process.js'
import {
  backupInputClaimInTransaction,
  markClaimProgressInTransaction,
  settleInputClaimInTransaction,
  takeRecoverableInputClaimInTransaction,
} from './input-claim.js'
import { DshSessionLogMirror, type DshImageAttachmentRef, type DshMirrorEventSession } from './session-log-mirror.js'
import { DshBoundaryWorker } from './boundary-worker.js'
import { DshSessionLogExportService } from './session-log-export.js'

interface NativeSkills {
  registerProvider(create: (control: { readonly signal: AbortSignal }) => unknown): () => void
  snapshot?(options?: unknown): Promise<{
    readonly skills: readonly { name: string; description?: string; invocation?: { modelInvocable?: boolean } }[]
    readonly complete: boolean
  }>
}

interface NativeTools {
  register(definition: unknown): () => void
  guard(guard: (execution: unknown) => string | undefined): () => void
  schemas?(scope?: unknown): readonly { name: string; description?: string }[] | PromiseLike<readonly { name: string; description?: string }[]>
}

interface NativeCommands { register(...args: any[]): () => void }
interface NativeSessions {
  get(id: string): { id: string; header?: { cwd?: string }; snapshotEvents?: () => readonly DshLogEvent[] } | undefined
  flush?(session: object): PromiseLike<unknown>
}
interface NativeAgent {
  readonly id: string
  readonly session?: { readonly id: string; readonly header?: { readonly cwd?: string }; snapshotEvents?: () => readonly DshLogEvent[] }
  readonly inject?: (message: unknown) => void
  readonly steer?: (message: unknown) => void
}
interface NativeAgents {
  get(id: string): NativeAgent | undefined
  list?(): readonly NativeAgent[]
}
interface NativeAttachments {
  readImage(ref: DshImageAttachmentRef, signal?: AbortSignal): Promise<{
    readonly ref: DshImageAttachmentRef
    readonly data: Uint8Array
  }>
}

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

interface AdapterContext extends Context {
  get(name: string, strict?: boolean): unknown
}

export interface DshHostAdapterOptions {
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

interface TurnRecord {
  readonly agentId: string
  readonly sessionId: string
  readonly runId: string
  readonly workspace: string
  readonly orchestrationId: string
  readonly repositoryRoot: string
  readonly cwd: string
  nativeAgent?: DshUserQuestionAgent
  nativeSession?: object
  task: string
  turn: number
  prepared: DshIntakeGateResult['prepared']
  catalog: DshCapabilityCatalog
  /** Monotonic host generation assigned before each prepare begins. */
  prepareGeneration: number
  contextInjectionKey?: string
  failed: boolean
  closed: boolean
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

function pluginContinuationId(value: unknown): string | undefined {
  const message = objectRecord(value)
  const source = objectRecord(message?.source)
  if (source?.kind !== 'plugin' || source.plugin !== 'kiokuko-dsh' || source.form !== 'continuation') return undefined
  return typeof source.deliveryId === 'string' && /^[0-9a-f]{64}$/u.test(source.deliveryId)
    ? source.deliveryId
    : undefined
}

function eventContinuationId(data: unknown): string | undefined {
  const direct = pluginContinuationId(data)
  if (direct !== undefined) return direct
  const record = objectRecord(data)
  return pluginContinuationId(record?.message)
}

function continuationMessage(continuationId: string, nextAction: EnnoNextAction): unknown {
  const work = nextAction === 'execute_work_unit'
    ? 'The current WorkUnit is not accepted unless the latest Enno result says so. Correct or report only that WorkUnit.'
    : `Continue only the current Kiokuko phase for nextAction=${nextAction}. Do not skip ahead.`
  return Object.freeze({
    id: continuationId,
    role: 'user',
    content: [{ type: 'text', text: work }],
    source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'continuation', deliveryId: continuationId },
  })
}

function phaseForState(state: EnnoOdunoState): DshToolPolicyState['phase'] {
  if (!state.applicable) return 'completed'
  if (state.status === 'intake') return 'intake'
  if (state.status === 'oduno_ideal') return 'ideal'
  if (state.status === 'zenki_planning') return 'planning'
  if (state.status === 'needs_confirmation') return 'confirmation'
  if (state.status === 'goki_executing') return 'goki'
  if (state.status === 'enno_verifying') return 'verifying'
  if (state.status === 'oduno_meditation') return 'meditation'
  if (state.status === 'blocked') return 'blocked'
  if (state.status === 'cancelled') return 'cancelled'
  return 'completed'
}

function supersedesUnstartedEnno(event: DshPreStepEvent, state: EnnoOdunoState): boolean {
  if (state.status !== 'oduno_ideal') return false
  const incomingType = resolveGroundedIntakeProfile({
    task: event.task,
    cwd: event.cwd,
    ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
  }).profileHints.taskType
  return incomingType !== null && !ENNO_APPLICABLE_TASK_TYPES.includes(incomingType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number])
}

function policyState(state: EnnoOdunoState, record: TurnRecord, sessionId: string, lease?: EnnoOperationResponse['executionLease']): DshToolPolicyState {
  return {
    phase: phaseForState(state),
    runId: record.runId,
    workspace: record.workspace,
    orchestrationId: record.orchestrationId,
    ...(record.prepared.context?.deliveryId === null || record.prepared.context?.deliveryId === undefined ? {} : { deliveryId: record.prepared.context.deliveryId }),
    revision: state.contractRevision ?? 1,
    routeEpoch: lease?.routeEpoch ?? state.routeEpoch ?? 0,
    ...(state.advisoryPhaseState.state === 'aggregated' ? { advisoryRoundDigest: state.advisoryPhaseState.inputDigest } : {}),
    ...(lease === undefined ? {} : { leaseToken: lease.leaseToken, workUnitId: lease.workUnitId, currentWorkUnitId: lease.workUnitId }),
    dshSessionId: sessionId,
    nativeTurn: record.turn,
    ...(state.nextAction === undefined ? {} : { nextAction: state.nextAction }),
  }
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

function operationInput(
  args: unknown,
  binding: DshToolHostBinding,
  cwd: string,
  operation: string,
  catalog: DshCapabilityCatalog,
): Record<string, unknown> {
  const source = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const identity = { runId: binding.runId, workspace: binding.workspace, orchestrationId: binding.orchestrationId, expectedRevision: binding.revision, idempotencyKey: binding.idempotencyKey }
  const advisory = binding.advisoryRoundDigest === undefined ? {} : { advisoryRoundDigest: binding.advisoryRoundDigest }
  if (operation === 'enno_work_report') return { ...source, ...identity, leaseToken: binding.leaseToken, routeEpoch: binding.routeEpoch, workUnitId: binding.workUnitId }
  if (operation === 'enno_plan_submit') return { ...source, ...identity, ...advisory, capabilities: [...catalog.skills, ...catalog.tools] }
  if (operation === 'curator_check') return { ...source, cwd, workspace: binding.workspace }
  if (operation === 'memory_checkpoint') return { ...source, cwd, runId: binding.runId, ...(binding.deliveryId === undefined ? {} : { deliveryId: binding.deliveryId }) }
  return { ...source, ...identity, ...advisory }
}

function operationName(value: string): value is typeof DSH_MODEL_FACING_OPERATIONS[number] {
  return (DSH_MODEL_FACING_OPERATIONS as readonly string[]).includes(value)
}

export function createDshHostAdapter(ctx: Context, options: DshHostAdapterOptions = {}): DshHostAdapter {
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
  const advisory = options.advisory ?? native.get('dshAdvisory', false) as DshAdvisoryHost | undefined
  const root = realpathSync(options.repositoryRoot ?? process.cwd())
  const runtime = new DshRuntime({
    repositoryRoot: root,
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    migrationsDirectory: options.migrationsDirectory ?? fileURLToPath(new URL('../../migrations/', import.meta.url)),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 30_000, batchSize: 16 },
    autoRegisterRepository: true,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const sessionCachePath = options.sessionCachePath
    ?? (options.databasePath === undefined ? undefined : `${options.databasePath}.session-cache`)
  const sessionMirror = new DshSessionLogMirror({
    runtime,
    ...(sessionCachePath === undefined ? {} : { databasePath: sessionCachePath }),
    ...(attachments === undefined ? {} : { readAttachment: attachments.readImage.bind(attachments) }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  async function importLegacySession(sessionId: string) {
    if (sessionQuery === undefined) throw new KiokukoError('NOT_FOUND', 'DSH session is unavailable')
    // DSH 0.1.2-rc.1 exposes only a materializing reader for cold sessions.
    // Bound the one-time compatibility path before copying into the mirror.
    const snapshot = await sessionQuery.readSession(sessionId)
    let bytes = 0
    for (const event of snapshot.events) {
      bytes += Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
      if (bytes > 32 * 1024 * 1024) {
        throw new KiokukoError('VALIDATION_ERROR', 'legacy DSH log exceeds the bounded one-time import limit', {
          httpStatus: 413,
          code: 'legacy_log_too_large',
        })
      }
      await sessionMirror.observe(sessionId, event)
    }
    return snapshot
  }
  const finalizationQuery: DshSessionQuery = {
    cachePromptLayout: (layout) => sessionMirror.cachePromptLayout(layout),
    streamSession: async (sessionId) => {
      try {
        return await sessionMirror.streamSession(sessionId)
      } catch (error) {
        if (!(error instanceof KiokukoError) || error.code !== 'NOT_FOUND') throw error
      }
      const snapshot = await importLegacySession(sessionId)
      return Object.freeze({
        session: snapshot.session,
        inheritedEventCount: snapshot.inheritedEventCount,
        events: (async function* () { for (const event of snapshot.events) yield event })(),
      })
    },
    readSession: async (sessionId) => {
      try {
        return await sessionMirror.readSession(sessionId)
      } catch (error) {
        if (!(error instanceof KiokukoError) || error.code !== 'NOT_FOUND') throw error
      }
      return importLegacySession(sessionId)
    },
  }
  const sessionExport = new DshSessionLogExportService(sessionMirror, {
    ensureNativeDurable: async (sessionId) => {
      const liveSession = sessions?.get(sessionId)
      if (liveSession !== undefined) {
        if (sessions?.flush === undefined || typeof liveSession.snapshotEvents !== 'function') {
          throw new KiokukoError('SERVICE_UNAVAILABLE', 'The live DSH session cannot be durably flushed for export')
        }
        await sessions.flush(liveSession)
        // Mirror checkpointing is non-vetoing. Its structured degraded health
        // is evaluated by the export service after this durability barrier.
        await sessionMirror.checkpointAfterNativeFlush(liveSession as DshMirrorEventSession)
        return
      }
      const current = await sessionMirror.checkpoint(sessionId)
      if (current.error !== undefined
        || (current.confirmedThrough >= current.observedThrough && current.observedThrough >= 0)) return
      if (sessionQuery === undefined) return
      const snapshot = await importLegacySession(sessionId)
      // The public cold-session reader returns the already persisted DSH log;
      // unlike a live Session, it does not require another sessions.flush().
      await sessionMirror.checkpointAfterNativeFlush({
        id: sessionId,
        header: snapshot.session,
        snapshotEvents: () => snapshot.events,
      })
    },
  })
  const turns = new Map<string, TurnRecord>()
  const latestBySession = new Map<string, TurnRecord>()
  const states = new Map<string, DshToolPolicyState>()
  const activeModeRequests = new Map<string, string>()
  const advisoryRounds = new Map<string, {
    readonly stateDigest: string
    readonly result: DshAdvisoryRoundResult
  }>()
  const resumedLeases = new Map<string, NonNullable<EnnoOperationResponse['executionLease']>>()
  const policy = new DshToolPolicy({ phase: 'intake', runId: 'pending', workspace: 'pending', orchestrationId: 'pending', revision: 1, routeEpoch: 0 })
  const memoryFinalizer = new DshMemoryFinalizer({
    runtime,
    sessionQuery: finalizationQuery,
    onFinalized: (sessionId) => sessionMirror.markFinalized(sessionId),
    ...(llm === undefined ? {} : { llm }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const modes = new DshPonytailModes()
  const confirmationAnswerer = userQuestions === undefined ? undefined : createDshConfirmationAnswerer(userQuestions)
  let prepareGeneration = 0
  const continuedTurns = new Map<string, {
    readonly fingerprint: string
    readonly result: DshIntakeGateResult
    readonly nativeAgent?: object
    readonly nativeSession?: object
  }>()
  const resumedTurns = new Map<string, {
    readonly fingerprint: string
    readonly result: DshIntakeGateResult
    readonly nativeAgent?: object
    readonly nativeSession?: object
  }>()
  const inMemoryClaims = new Map<string, {
    readonly messages: readonly unknown[]
    providerStarted: boolean
    sideEffectStarted: boolean
    recovered: boolean
  }>()
  let retireSupersededRun: ((item: TurnRecord, status: 'completed' | 'failed' | 'cancelled') => Promise<void>) | undefined
  let resumeExistingRun: ((event: DshPreStepEvent) => Promise<DshIntakeGateResult | undefined>) | undefined

  const identityKey = (agentId: string, sessionId: string): string => dshPonytailOwnerKey(agentId, sessionId)
  const turnKey = (agentId: string, sessionId: string, turn: number): string => `${identityKey(agentId, sessionId)}\u0000${turn}`
  const record = (event: DshPreStepEvent, result: DshIntakeGateResult, generation: number): void => {
    const run = result.prepared.run.runId
    const latest = latestBySession.get(event.sessionId)
    if (latest !== undefined && (latest.nativeAgent !== event.nativeAgent || latest.nativeSession !== event.nativeSession)) {
      throw new Error('kiokuko-dsh session identity changed while the previous native session is active')
    }
    if (latest !== undefined && latest.turn > event.turn) return
    const key = turnKey(event.agent.id, event.sessionId, event.turn)
    const previous = turns.get(key)
    if (previous !== undefined && previous.runId !== run) throw new Error('kiokuko-dsh logical turn changed run identity')
    if (previous !== undefined && (previous.nativeAgent !== event.nativeAgent || previous.nativeSession !== event.nativeSession)) {
      throw new Error('kiokuko-dsh logical turn changed native agent or session identity')
    }
    const incomingRevision = result.prepared.ennoOduno.contractRevision ?? 0
    const previousRevision = previous?.prepared.ennoOduno.contractRevision ?? 0
    if (previous !== undefined && (incomingRevision < previousRevision
      || incomingRevision === previousRevision && generation <= previous.prepareGeneration)) return
    const item: TurnRecord = previous ?? {
      agentId: event.agent.id,
      sessionId: event.sessionId,
      runId: run,
      workspace: result.prepared.project.workspace,
      orchestrationId: result.prepared.intake.sessionId,
      repositoryRoot: result.prepared.project.repositoryRoot,
      cwd: event.cwd,
      task: event.task,
      turn: event.turn,
      prepared: result.prepared,
      catalog: result.catalog,
      prepareGeneration: generation,
      failed: false,
      closed: false,
    }
    if (event.nativeAgent !== undefined) item.nativeAgent = event.nativeAgent
    if (event.nativeSession !== undefined) item.nativeSession = event.nativeSession
    item.turn = event.turn
    const sameRevision = previous !== undefined && incomingRevision === previousRevision
    if (sameRevision) {
      // A newer prepare may carry a newer context delivery while Enno has not
      // advanced its revision. Preserve the active lease and other policy
      // state; only replace the authoritative prepared context and delivery.
      item.prepared = { ...item.prepared, context: result.prepared.context }
    } else {
      item.prepared = result.prepared
    }
    item.prepareGeneration = generation
    item.task = event.task
    item.catalog = result.catalog
    turns.set(key, item)
    latestBySession.set(event.sessionId, item)
    const modeRequest = `dsh:${event.agent.id}:${event.sessionId}:${event.turn}`
    const modeKey = identityKey(event.agent.id, event.sessionId)
    const activeModeRequest = activeModeRequests.get(modeKey)
    if (activeModeRequest !== modeRequest) {
      if (activeModeRequest !== undefined) modes.end(activeModeRequest)
      modes.begin(modeRequest, modeKey)
      activeModeRequests.set(modeKey, modeRequest)
    }
    const existingState = states.get(item.runId)
    if (existingState !== undefined && existingState.revision === incomingRevision) {
      // A continued native turn for the same Enno revision must retain the
      // active WorkUnit lease and route epoch. Rebuilding policy from the
      // public prepared projection would silently discard those host-only
      // credentials and make the first report after recovery fail with
      // lease_required. The operation path already advances this state when
      // Enno changes phase; at pre-step only the delivery and authoritative
      // native turn can legitimately be refreshed without a new contract
      // revision.
      const { deliveryId: _previousDeliveryId, ...withoutDeliveryId } = existingState
      const deliveryId = result.prepared.context?.deliveryId
      const next = deliveryId === null || deliveryId === undefined
        ? { ...withoutDeliveryId, nativeTurn: event.turn }
        : { ...withoutDeliveryId, deliveryId, nativeTurn: event.turn }
      states.set(item.runId, next)
      policy.setState(next)
    } else {
      const next = policyState(result.prepared.ennoOduno, item, event.sessionId, resumedLeases.get(run))
      resumedLeases.delete(run)
      states.set(item.runId, next)
      policy.setState(next)
    }
  }
  const bindAndRecord = async (event: DshPreStepEvent, result: DshIntakeGateResult, generation: number): Promise<void> => {
    const sourceStartSeq = event.sourceStartSeq
      ?? dshTurnBoundarySeq(sessionEventSource(event.nativeSession), event.turn, 'start')
    await memoryFinalizer.bindRunStart({
      runId: result.prepared.run.runId,
      workspace: result.prepared.project.workspace,
      dshSessionId: event.sessionId,
      sourceStartSeq,
      sourceStartTurn: event.turn,
    })
    record(event, result, generation)
  }

  const refreshContinuedWorkLease = async (
    item: TurnRecord,
    expected: EnnoOdunoState,
  ): Promise<{ state: EnnoOdunoState; lease: EnnoExecutionLease } | undefined> => {
    const expectedWorkUnitId = expected.nextAction === 'execute_work_unit'
      ? expected.directive?.workUnit?.id
      : undefined
    if (expectedWorkUnitId === undefined) return undefined
    return runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      const snapshot = readEnnoSnapshot(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
      })
      const state = stateForSnapshot(snapshot)
      const workUnitId = state.nextAction === 'execute_work_unit'
        ? state.directive?.workUnit?.id
        : undefined
      if (state.contractRevision !== expected.contractRevision || workUnitId !== expectedWorkUnitId) {
        throw new KiokukoError('CONFLICT', 'Enno WorkUnit changed before DSH turn recovery')
      }
      if (snapshot.dshSessionId !== item.sessionId) {
        throw new KiokukoError('CONFLICT', 'Enno DSH route changed before WorkUnit recovery')
      }
      return {
        state,
        lease: claimExecutionLeaseInTransaction(database, snapshot, workUnitId, {
          dshSessionId: item.sessionId,
        }),
      }
    }))
  }

  class CapturingGate extends DshIntakeGate {
    override async prepare(event: DshPreStepEvent): Promise<DshIntakeGateResult> {
      // Capture completion ordering before any asynchronous database or intake
      // work. Revision ordering alone cannot distinguish two same-revision
      // context deliveries that finish out of order.
      const generation = ++prepareGeneration
      await runtime.withDatabase((database) => resolveProjectWorkspaceReadOnly(database, event.cwd, { allowDirectory: true }))
      const cacheKey = `${event.sessionId}\u0000${event.turn}`
      const fingerprint = canonicalContentHash({
        sessionId: event.sessionId,
        agentId: event.agent.id,
        turn: event.turn,
        sourceStartSeq: event.sourceStartSeq ?? null,
        task: event.task,
        cwd: event.cwd,
        profileHints: event.profileHints ?? null,
        evidence: event.evidence ?? null,
        skillDiscoveryMode: event.skillDiscoveryMode ?? null,
        catalogDigest: event.capabilities.digest,
      })
      const cached = continuedTurns.get(cacheKey) ?? resumedTurns.get(cacheKey)
      if (cached !== undefined) {
        if (cached.fingerprint !== fingerprint
          || cached.nativeAgent !== event.nativeAgent
          || cached.nativeSession !== event.nativeSession) {
          throw new KiokukoError('CONFLICT', 'dsh continued turn was reused with different bound input')
        }
        this.assertCatalog(cached.result.catalog, event.capabilities)
        return event.signal.aborted ? { ...cached.result, admitted: false } : cached.result
      }
      const previous = currentForAgentEvent(event.agent.id, event.sessionId, undefined, event.nativeSession, event.nativeAgent)
      if (previous !== undefined && previous.turn < event.turn) {
        if (event.signal.aborted) return { admitted: false, prepared: previous.prepared, catalog: event.capabilities }
        let previousState = await runtime.withDatabase((database) => stateForRun(database, previous))
        // DSH's dedicated plan-review card returns the composer to the user
        // when they choose "Chat about it". The next human message is the
        // requested plan revision; settle it host-side before Zenki resumes.
        // This keeps enno_answer host-only and avoids reopening Akinator.
        if (previousState.nextAction === 'ask_user_confirmation' && previousState.contractRevision !== null) {
          const expectedRevision = previousState.contractRevision
          const requestedChanges = event.task.trim()
          if (requestedChanges.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'Plan revision feedback is empty')
          const revised = await runtime.withDatabase((database) => answerEnno(database, {
            runId: previous.runId,
            workspace: previous.workspace,
            orchestrationId: previous.orchestrationId,
            expectedRevision,
            idempotencyKey: `dsh-confirmation-feedback:${canonicalContentHash({
              runId: previous.runId,
              revision: expectedRevision,
              sessionId: event.sessionId,
              turn: event.turn,
              requestedChanges,
            })}`,
            action: 'revise',
            requestedChanges,
          }))
          previous.prepared = { ...previous.prepared, ennoOduno: revised.ennoOduno }
          const next = policyState(revised.ennoOduno, previous, previous.sessionId, revised.executionLease)
          states.set(previous.runId, next)
          policy.setState(next)
          previousState = revised.ennoOduno
        }
        const previousWasChat = previous.prepared.intake.profile.taskType === 'chat'
        const superseded = previous.prepared.ennoOduno.applicable && supersedesUnstartedEnno(event, previousState)
        const continuePrevious = previousWasChat
          ? event.profileHints?.taskType === 'chat'
          : !superseded
            && previousState.status !== 'completed'
            && previousState.status !== 'blocked'
            && previousState.status !== 'cancelled'
            && previousState.nextAction !== 'complete'
        if (continuePrevious) {
          this.assertCatalog(previous.catalog, event.capabilities)
          const refreshedWork = await refreshContinuedWorkLease(previous, previousState)
          if (refreshedWork !== undefined) {
            previous.prepared = { ...previous.prepared, ennoOduno: refreshedWork.state }
            const next = policyState(refreshedWork.state, previous, previous.sessionId, refreshedWork.lease)
            states.set(previous.runId, next)
            policy.setState(next)
          }
          const continued = { admitted: !event.signal.aborted, prepared: previous.prepared, catalog: event.capabilities }
          if (continued.admitted) {
            continuedTurns.set(cacheKey, {
              fingerprint,
              result: continued,
              ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
              ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
            })
            await bindAndRecord(event, continued, generation)
          }
          return continued
        }
        if (event.signal.aborted) return { admitted: false, prepared: previous.prepared, catalog: event.capabilities }
        if (retireSupersededRun === undefined) throw new Error('kiokuko-dsh run lifecycle is unavailable')
        await retireSupersededRun(
          previous,
          superseded || previousState.status === 'cancelled' ? 'cancelled' : previousState.status === 'blocked' ? 'failed' : 'completed',
        )
      }
      const resumed = await resumeExistingRun?.(event)
      if (resumed !== undefined) {
        resumedTurns.set(cacheKey, {
          fingerprint,
          result: resumed,
          ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
          ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
        })
        await bindAndRecord(event, resumed, generation)
        return resumed
      }
      const prepared = await super.prepare(event)
      if (prepared.admitted) await bindAndRecord(event, prepared, generation)
      return prepared
    }
    override async preStep(event: DshPreStepEvent, next: () => Promise<DshPreStepDecision>): Promise<DshPreStepDecision> {
      // The native chain owns admission and the original message ordering.
      // Run it before any Kiokuko storage or classification work so an
      // auxiliary database failure cannot delay or rewrite its decision.
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      const claimKey = `${event.sessionId}\u0000${event.turn}`
      const nativeMessages = Object.freeze([...(event.nativeMessages ?? [])])
      inMemoryClaims.set(claimKey, {
        messages: nativeMessages,
        providerStarted: false,
        sideEffectStarted: false,
        recovered: false,
      })
      try {
        await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          backupInputClaimInTransaction(database, {
            dshSessionId: event.sessionId,
            nativeTurn: event.turn,
            messages: nativeMessages,
          })
        }))
      } catch {
        // The in-memory copy still protects a pre-provider failure in this
        // process. Durable backup failure cannot veto the native decision.
      }
      const humanPresent = nativeMessages.some(isHumanMessage) || downstream.messages.some(isHumanMessage)
      const seenContinuations = new Set<string>()
      const nativeDecision: DshPreStepDecision = {
        ...downstream,
        messages: downstream.messages.filter((message) => {
          const deliveryId = pluginContinuationId(message)
          if (deliveryId === undefined) return true
          if (humanPresent || seenContinuations.has(deliveryId)) return false
          seenContinuations.add(deliveryId)
          return true
        }),
      }
      if (humanPresent) {
        const previous = currentSession(event.sessionId)
        const state = previous === undefined ? undefined : states.get(previous.runId)
        if (state !== undefined) {
          try {
            await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
              supersedeOutboxAtOrBeforeRevisionInTransaction(database, event.sessionId, state.revision)
            }))
          } catch {
            // Human input remains authoritative in the current native batch;
            // stale durable outbox cleanup will be retried on a later kick.
          }
        }
      }
      try {
        const result = await this.prepare(event)
        if (!result.admitted) return nativeDecision
        const messages = await contextMessages(event, result)
        return { ...nativeDecision, messages: [...nativeDecision.messages, ...messages] }
      } catch {
        // The native message array is authoritative. Kiokuko degradation must
        // not turn a claimed user prompt into a rejected/empty DSH step.
        return nativeDecision
      }
    }
    override clearTurn(sessionId: string, turn: number): void {
      super.clearTurn(sessionId, turn)
      continuedTurns.delete(`${sessionId}\u0000${turn}`)
      resumedTurns.delete(`${sessionId}\u0000${turn}`)
    }
  }

  const gate = new CapturingGate(
    runtime,
    userQuestions === undefined ? undefined : createDshIntakeAnswerer(userQuestions),
    (context) => capabilityCatalog(skills, tools, context),
  )
  const currentSession = (sessionId: string): TurnRecord | undefined => latestBySession.get(sessionId)
  const currentForAgentEvent = (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object): TurnRecord | undefined => {
    // The session is the authoritative route key. Agent ID alone is not
    // sufficient because an agent can own multiple sessions over its life.
    if (sessionId === undefined) return undefined
    const matchesNativeIdentity = (item: TurnRecord): boolean => {
      const sessionMatches = item.nativeSession === undefined ? nativeSession === undefined : nativeSession !== undefined && item.nativeSession === nativeSession
      const agentMatches = item.nativeAgent === undefined ? nativeAgent === undefined : nativeAgent !== undefined && item.nativeAgent === nativeAgent
      return sessionMatches && agentMatches
    }
    const item = currentSession(sessionId)
    return item?.agentId === agentId && (turn === undefined || item.turn === turn) && matchesNativeIdentity(item) ? item : undefined
  }
  const contextInjectionKey = (item: TurnRecord, turn: number, state: EnnoOdunoState, selection: { readonly routeSkillNames: readonly string[]; readonly expertRefs: readonly unknown[] }): string => canonicalContentHash({
    sessionId: item.sessionId,
    turn,
    routeSkillNames: selection.routeSkillNames,
    expertRefs: selection.expertRefs,
    contractRevision: state.contractRevision,
    nextAction: state.nextAction,
    directiveDigest: state.directive === null ? null : canonicalContentHash(state.directive),
    advisoryRoundDigest: state.advisoryPhaseState.state === 'aggregated' ? state.advisoryPhaseState.inputDigest : null,
  })
  const advisoryEvidenceFor = async (item: TurnRecord, state: EnnoOdunoState): Promise<{
    readonly phase: DshAdvisoryRoundResult['phase']
    readonly contributions: DshAdvisoryRoundResult['contributions']
  } | undefined> => {
    const advisoryState = state.advisoryPhaseState
    const contractRevision = state.contractRevision
    if (advisoryState.state !== 'aggregated' || contractRevision === null) return undefined
    let round = advisoryRounds.get(item.runId)
    if (round?.stateDigest !== advisoryState.inputDigest) {
      const restored = await runtime.withDatabase((database) => readPendingEnnoAdvice(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
        expectedRevision: contractRevision,
        advisoryRoundDigest: advisoryState.inputDigest,
      }))
      round = {
        stateDigest: restored.advisoryRound.inputDigest,
        result: {
          phase: restored.advisoryRound.phase,
          inputDigest: restored.advisoryRound.inputDigest,
          contributions: restored.advisoryRound.contributions,
          degraded: restored.advisoryRound.degraded,
        },
      }
      advisoryRounds.set(item.runId, round)
    }
    return { phase: round.result.phase, contributions: round.result.contributions }
  }
  resumeExistingRun = async (event): Promise<DshIntakeGateResult | undefined> => runtime.withDatabase(async (database) => {
    const project = await resolveProjectWorkspaceReadOnly(database, event.cwd, { allowDirectory: true })
    if (project === undefined) return undefined
    const candidates = database.prepare(`
      SELECT ec.run_id AS runId, ec.orchestration_session_id AS orchestrationId
      FROM enno_contracts AS ec
      JOIN ledger_runs AS lr ON lr.run_id = ec.run_id AND lr.workspace = ec.workspace
      WHERE ec.repository_root = ? AND ec.dsh_session_id = ? AND lr.status = 'active'
        AND ec.status NOT IN ('completed', 'cancelled', 'blocked')
      ORDER BY ec.created_at, ec.run_id
      LIMIT 2
    `).all<{ runId: string; orchestrationId: string }>(project.repositoryRoot, event.sessionId)
    if (candidates.length === 0) return undefined
    if (candidates.length !== 1) {
      throw new KiokukoError('CONFLICT', 'Multiple active Enno-Oduno runs match this repository; refusing to guess')
    }
    const candidate = candidates[0]!
    const runId = candidate.runId
    const snapshot = readEnnoSnapshot(database, {
      runId,
      workspace: project.workspace,
      orchestrationId: candidate.orchestrationId,
    })
    if (!event.signal.aborted && supersedesUnstartedEnno(event, stateForSnapshot(snapshot))) {
      terminalizeLedgerRunInTransaction(database, runId, 'cancelled')
      return undefined
    }
    const decision = decideDshContinuation(database, {
      dshSessionId: event.sessionId,
      cwd: event.cwd,
    }, runId)
    if (!decision.continue || decision.runId !== runId) {
      throw new KiokukoError('CONFLICT', decision.warning ?? 'The active Enno-Oduno run cannot be resumed by this DSH session')
    }
    const intakeLink = readRunIntakeLink(database, { workspace: project.workspace, runId })
    const intake = readAkinatorSession(database, { workspace: project.workspace, sessionId: intakeLink.sessionId })
    if (intake.status === 'active') throw new KiokukoError('INTEGRITY_ERROR', 'Resumable Enno-Oduno run has unfinished intake')
    const capabilityEntries = [...event.capabilities.skills, ...event.capabilities.tools]
    const capabilityResolution = resolveCapabilities({
      task: intake.task,
      profile: intake.profile,
      recommendedTags: intakeLink.recommendedTags,
      capabilities: capabilityEntries,
      memoryUse: 'none',
    })
    const canonicalCwd = realpathSync(event.cwd)
    const prepared: PreparedAgentTask = {
      project,
      executionContext: {
        canonicalCwd,
        repositoryRoot: project.repositoryRoot,
        cwdIsRepositoryRoot: canonicalCwd === project.repositoryRoot,
        pathPolicy: 'canonical_absolute_under_repository_root',
      },
      intake: {
        status: intake.status,
        sessionId: intake.id,
        profile: intake.profile,
        question: null,
        missingFields: [],
        recommendedTags: intakeLink.recommendedTags,
        reasoning: deriveAkinatorReasoning(intake.task, intake.profile),
      },
      capabilities: capabilityResolution,
      run: { runId, status: 'active' },
      skillDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] },
      context: null,
      memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false, withheldReason: null, deliveryEmpty: true },
      warnings: capabilityResolution.warnings,
      nextAction: 'proceed',
      securityNotice: 'This resumed DSH run uses only current repository evidence and the current host capability catalog; previously delivered ordinary memory is not replayed implicitly.',
      ennoOduno: stateForSnapshot(snapshot),
    }
    if (decision.executionLease !== null) resumedLeases.set(runId, decision.executionLease)
    return { admitted: !event.signal.aborted, prepared, catalog: event.capabilities }
  })
  const mapPreStep = async (payload: DshNativePreStepPayload): Promise<DshPreStepEvent> => {
    const nativeSession = payload.agent.session
    const registered = nativeSession === undefined && payload.agent.sessionId === undefined
      ? sessions?.get(payload.agent.id)
      : undefined
    const sessionId = nativeSession?.id ?? payload.agent.sessionId ?? registered?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('kiokuko-dsh native agent session identity is unavailable')
    const registeredSession = nativeSession === undefined ? sessions?.get(sessionId) : undefined
    const boundSession = nativeSession ?? registeredSession ?? registered
    if (boundSession !== undefined && boundSession.id !== sessionId) throw new Error('kiokuko-dsh native session identity is inconsistent')
    const cwd = boundSession?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('kiokuko-dsh native session cwd is unavailable')
    const sourceStartSeq = dshTurnBoundarySeq(sessionEventSource(boundSession as object | undefined), payload.turn, 'start')
    const catalog = await capabilityCatalog(skills, tools, {
      agent: { id: payload.agent.id },
      nativeAgent: payload.agent,
      cwd,
      signal: payload.signal,
    })
    const bound = currentForAgentEvent(payload.agent.id, sessionId, payload.turn, boundSession as object | undefined, payload.agent as object)
    const previous = bound === undefined
      ? currentForAgentEvent(payload.agent.id, sessionId, undefined, boundSession as object | undefined, payload.agent as object)
      : undefined
    // DSH supplies only the messages claimed for this particular step. After
    // the first step that batch may contain steering/injected context rather
    // than the original user task, so the established logical-turn record is
    // the authoritative task projection.
    // After a turn was deliberately paused, DSH may consume the next-turn
    // inbox item before pre-step and expose an empty step-local message batch.
    // The durable Enno run is still authoritative, so fall back to its last
    // human task. The native conversation retains the new user message for the
    // model, while any supplied step-local user text still replaces this
    // fallback and is recorded as the continuation instruction.
    const task = bound === undefined ? textFromMessages(payload.messages, previous?.task) : bound.task
    return {
      agent: { id: payload.agent.id },
      nativeAgent: payload.agent,
      sessionId,
      ...(boundSession === undefined ? {} : { nativeSession: boundSession as object }),
      turn: payload.turn,
      sourceStartSeq,
      step: payload.step,
      nativeMessages: payload.messages,
      task,
      cwd,
      ...(() => {
        if (bound !== undefined) {
          return continuedTurns.has(`${sessionId}\u0000${payload.turn}`)
            ? { profileHints: { taskType: bound.prepared.intake.profile.taskType } }
            : {}
        }
        if (previous === undefined) return {}
        const inferred = resolveGroundedIntakeProfile({ task, cwd }).profileHints.taskType
        const previousType = previous.prepared.intake.profile.taskType
        if (inferred === null || previousType === 'chat' && inferred === 'chat') {
          return { profileHints: { taskType: previousType } }
        }
        return {}
      })(),
      capabilities: catalog,
      signal: payload.signal,
    }
  }
  const contextMessages = async (event: DshPreStepEvent, _result: DshIntakeGateResult): Promise<readonly unknown[]> => {
    const item = currentForAgentEvent(event.agent.id, event.sessionId, event.turn, event.nativeSession, event.nativeAgent)
    if (item === undefined || item.sessionId !== event.sessionId) throw new Error('kiokuko-dsh turn identity is not bound')
    if (event.nativeSession !== undefined && item.nativeSession !== event.nativeSession) throw new Error('kiokuko-dsh native session identity is not bound')
    // The intake cache is intentionally stable for the logical turn, while
    // Enno operations advance item.prepared after each tool result. Always
    // inject from that current host state instead of replaying the intake-time
    // directive from the cached gate result.
    const prepared = item.prepared
    const directive = projectDshDirective(prepared.ennoOduno)
    const selection = directive === null ? { routeSkillNames: [], expertRefs: [] } : selectDshDirectiveSources(directive)
    const contextKey = contextInjectionKey(item, event.turn, prepared.ennoOduno, selection)
    if (item.contextInjectionKey === contextKey) return []
    const advisoryEvidence = await advisoryEvidenceFor(item, prepared.ennoOduno)
    const messages = await injectDshContext({
      prepared,
      task: event.task,
      routeSkillNames: selection.routeSkillNames,
      expertRefs: selection.expertRefs,
      ...(directive === null ? {} : { directive }),
      ...(advisoryEvidence === undefined ? {} : { advisoryEvidence }),
      runtime,
    })
    const nativeMessages = messages.map((message) => ({
        id: randomUUID(),
        role: message.role,
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' },
      }))
    item.contextInjectionKey = contextKey
    return Object.freeze(nativeMessages)
  }

  const toolHost: DshToolHost = {
    bind: (execution) => {
      const sessionId = execution.agent?.dshSessionId
      if (sessionId === undefined) throw new Error('kiokuko-dsh tool session identity is unavailable')
      const item = currentSession(sessionId)
      if (item === undefined || item.closed) throw new Error('kiokuko-dsh tool session is not bound to an active run')
      if (item.nativeSession !== execution.agent?.nativeSession) throw new Error('kiokuko-dsh tool native session identity is stale')
      if (execution.agent?.turn !== undefined && execution.agent.turn !== item.turn) throw new Error('kiokuko-dsh tool turn identity is stale')
      const state = states.get(item.runId)
      if (state === undefined || state.dshSessionId !== sessionId) throw new Error('kiokuko-dsh tool state is unavailable')
      return {
        dshSessionId: sessionId,
        runId: state.runId,
        workspace: state.workspace,
        orchestrationId: state.orchestrationId,
        ...(state.deliveryId === undefined ? {} : { deliveryId: state.deliveryId }),
        revision: state.revision,
        routeEpoch: state.routeEpoch,
        ...(state.advisoryRoundDigest === undefined ? {} : { advisoryRoundDigest: state.advisoryRoundDigest }),
        ...(state.leaseToken === undefined ? {} : { leaseToken: state.leaseToken }),
        ...(state.workUnitId === undefined ? {} : { workUnitId: state.workUnitId }),
      }
    },
    execute: async (operation, args, binding, signal) => {
      if (!operationName(operation)) throw new Error('Unsupported Kiokuko dsh operation')
      const run = [...turns.values()]
        .filter((item) => item.runId === binding.runId && item.sessionId === binding.dshSessionId && !item.closed)
        .sort((left, right) => right.turn - left.turn)[0]
      const currentState = run === undefined ? undefined : states.get(run.runId)
      if (binding.dshSessionId === undefined || run === undefined || run.closed
        || binding.workspace !== run.workspace
        || binding.orchestrationId !== run.orchestrationId
        || currentState === undefined
        || binding.revision !== currentState.revision
        || binding.routeEpoch !== currentState.routeEpoch
        || binding.advisoryRoundDigest !== currentState.advisoryRoundDigest) throw new Error('kiokuko-dsh tool binding is not authoritative')
      if (signal?.aborted) throw signal.reason
      const cwd = run.cwd
      const operationSignal = signal ?? new AbortController().signal
      const currentCatalog = await capabilityCatalog(skills, tools, {
        agent: { id: run.agentId },
        ...(run.nativeAgent === undefined ? {} : { nativeAgent: run.nativeAgent }),
        cwd,
        signal: operationSignal,
      })
      gate.assertTurnStoppingCatalog(run.catalog, currentCatalog)
      const phase = phaseForOperation(operation)
      const receiptOperation = ennoReceiptOperation(operation)
      const inputDigest = canonicalContentHash({
        operation,
        arguments: args,
        revision: binding.revision,
        routeEpoch: binding.routeEpoch,
        workUnitId: binding.workUnitId ?? null,
      })
      if (phase !== undefined && receiptOperation !== undefined) {
        await runtime.withDatabase((database) => prepareTurnIntent(database, {
          runId: run.runId,
          dshSessionId: run.sessionId,
          nativeTurn: run.turn,
          phase,
          contractRevision: binding.revision,
          ...(binding.workUnitId === undefined ? {} : { workUnitId: binding.workUnitId }),
          inputDigest,
          operation: receiptOperation,
          idempotencyKey: binding.idempotencyKey,
        }))
      }
      let response: EnnoOperationResponse | unknown
      try {
        response = await runtime.withDatabase(async (database) => {
          const input = operationInput(args, binding, cwd, operation, run.catalog)
          if (operation === 'enno_ideal_submit') return submitOdunoIdeal(database, input)
          if (operation === 'enno_plan_submit') return submitEnnoPlan(database, input)
          if (operation === 'enno_work_report') return reportEnnoWork(database, input)
          if (operation === 'enno_finish') return finishEnno(database, input)
          if (operation === 'enno_meditation_submit') {
            // The native DSH turn still has a tool result, final assistant
            // message, step end, and turn end to commit. Keep the ledger open
            // until the idle lifecycle flushes that ordered suffix.
            return submitOdunoMeditation(database, input, { deferLedgerTerminalization: true })
          }
          if (operation === 'curator_check') return curateMemoryCandidates(database, input)
          return checkpointDshMemory(database, input as unknown as ScopedCheckpointInput, signal)
        }) as EnnoOperationResponse | unknown
      } catch (error) {
        if (phase === undefined || receiptOperation === undefined || !isExpectedTurnFailure(error)) throw error
        response = await runtime.withDatabase((database) => commitExpectedFailure(database, {
          runId: run.runId,
          dshSessionId: run.sessionId,
          nativeTurn: run.turn,
          phase,
          contractRevision: binding.revision,
          ...(binding.workUnitId === undefined ? {} : { workUnitId: binding.workUnitId }),
          inputDigest,
          operation: receiptOperation,
          idempotencyKey: binding.idempotencyKey,
          error,
        }))
      }
      const ennoResponse = isAppliedEnnoOutcome(response) ? response.value : response
      if (run !== undefined && isEnnoResponse(ennoResponse)) {
        if (binding.advisoryRoundDigest !== undefined) advisoryRounds.delete(run.runId)
        run.prepared = { ...run.prepared, ennoOduno: ennoResponse.ennoOduno }
        const next = policyState(ennoResponse.ennoOduno, run, run.sessionId, ennoResponse.executionLease)
        states.set(run.runId, next)
        policy.setState(next)
      }
      if (phase !== undefined && isEnnoResponse(ennoResponse) && !isTurnOutcome(response)) {
        response = appliedTurnOutcome(ennoResponse, {
          schemaVersion: 1,
          runId: run.runId,
          phase,
          revision: binding.revision,
          nextAction: ennoResponse.ennoOduno.nextAction,
        })
      }
      if (phase !== undefined) {
        const seal = await runtime.withDatabase((database) => readTurnSeal(database, run.sessionId, run.turn))
        if (seal === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Committed DSH phase has no turn seal')
        policy.sealSession(run.sessionId, run.turn, seal.receiptId)
      }
      return response
    },
  }

  const advisoryRunner = new DshAdvisoryRunner({
    verifyReadOnly: advisory?.verifyReadOnly ?? (() => false),
    execute: advisory?.execute ?? (async () => { throw new Error('kiokuko-dsh advisory host is unavailable') }),
  })
  const assertTurnBoundary = async (event: {
    readonly agent: { readonly id: string; readonly sessionId?: string; readonly nativeSession?: object; readonly nativeAgent?: DshUserQuestionAgent }
    readonly turn: number
    readonly signal: AbortSignal
  }): Promise<TurnRecord> => {
    const item = currentForAgentEvent(
      event.agent.id,
      event.agent.sessionId,
      event.turn,
      event.agent.nativeSession,
      event.agent.nativeAgent,
    )
    if (item === undefined || item.closed) throw new Error('kiokuko-dsh turn boundary identity is stale')
    const currentCatalog = await capabilityCatalog(skills, tools, {
      agent: { id: event.agent.id },
      ...(event.agent.nativeAgent === undefined ? {} : { nativeAgent: event.agent.nativeAgent }),
      cwd: item.cwd,
      signal: event.signal,
    })
    gate.assertTurnStoppingCatalog(item.catalog, currentCatalog)
    return item
  }
  const submitAdvisory = async (result: DshAdvisoryRoundResult, input: { readonly event: { readonly agent: { readonly id: string; readonly sessionId?: string; readonly nativeSession?: object; readonly nativeAgent?: DshUserQuestionAgent }; readonly turn: number; readonly signal: AbortSignal }; readonly state: EnnoOdunoState }): Promise<EnnoOdunoState> => {
    // Advisory execution is asynchronous. Revalidate the live Agent/catalog
    // after it settles and immediately before committing its contribution.
    const item = await assertTurnBoundary(input.event)
    const directive = input.state.directive?.advisoryRound
    if (directive === undefined || input.state.contractRevision === null) throw new Error('kiokuko-dsh advisory directive is unavailable')
    const response = await runtime.withDatabase((database) => {
      const snapshot = readEnnoSnapshot(database, { runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId })
      if (snapshot.revision !== input.state.contractRevision || snapshot.mutationRevision < 0) throw new Error('kiokuko-dsh advisory state changed')
      return submitEnnoAdvice(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
        expectedRevision: snapshot.revision,
        mutationRevision: snapshot.mutationRevision,
        idempotencyKey: `dsh-advice:${canonicalContentHash({ runId: item.runId, revision: snapshot.revision, mutationRevision: snapshot.mutationRevision, phase: result.phase, inputDigest: result.inputDigest })}`,
        phase: result.phase,
        allowlistedContext: directive.context,
        contributions: result.contributions,
      })
    })
    item.prepared = { ...item.prepared, ennoOduno: response.ennoOduno }
    if (response.ennoOduno.advisoryPhaseState.state !== 'aggregated') {
      throw new Error('kiokuko-dsh advisory submission did not produce an aggregated round')
    }
    advisoryRounds.set(item.runId, {
      stateDigest: response.ennoOduno.advisoryPhaseState.inputDigest,
      result,
    })
    const next = policyState(response.ennoOduno, item, item.sessionId)
    states.set(item.runId, next)
    policy.setState(next)
    return response.ennoOduno
  }

  const boundaryAgents = new Map<string, object>()
  const boundaryEvent = (item: TurnRecord, signal = new AbortController().signal) => ({
    agent: {
      id: item.agentId,
      sessionId: item.sessionId,
      ...(item.nativeAgent === undefined ? {} : { nativeAgent: item.nativeAgent }),
      ...(item.nativeSession === undefined ? {} : { nativeSession: item.nativeSession }),
      steer: () => undefined,
    },
    turn: item.turn,
    signal,
  })
  const readBoundaryState = async (item: TurnRecord): Promise<EnnoOdunoState> => (
    runtime.withDatabase((database) => stateForRun(database, item))
  )
  const confirmBoundary = async (item: TurnRecord, state: EnnoOdunoState): Promise<'submitted' | 'dismissed'> => {
    const confirmation = state.directive?.userFacingConfirmation
    if (confirmation === undefined || state.contractRevision === null) throw new Error('kiokuko-dsh confirmation directive is unavailable')
    const event = boundaryEvent(item)
    let response: EnnoOperationResponse | undefined
    const controller = new DshConfirmationController({
      ...(confirmationAnswerer === undefined ? {} : { answerer: confirmationAnswerer }),
      readRevision: async () => {
        await assertTurnBoundary(event)
        return runtime.withDatabase((database) => readEnnoSnapshot(database, {
          runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
        }).revision)
      },
      submit: async (answer) => {
        response = await runtime.withDatabase((database) => answerEnno(database, {
          runId: item.runId,
          workspace: item.workspace,
          orchestrationId: item.orchestrationId,
          expectedRevision: answer.expectedRevision,
          idempotencyKey: `dsh-confirm:${canonicalContentHash({ runId: item.runId, revision: answer.expectedRevision, action: answer.action, requestedChanges: answer.requestedChanges ?? null })}`,
          action: answer.action,
          ...(answer.requestedChanges === undefined ? {} : { requestedChanges: answer.requestedChanges }),
        }))
      },
    })
    const decision = await controller.confirm({
      confirmation,
      expectedRevision: state.contractRevision,
      signal: event.signal,
      ...(item.nativeAgent === undefined ? {} : { agent: item.nativeAgent }),
    })
    if (decision.kind === 'dismissed') return 'dismissed'
    if (decision.kind !== 'submitted' || response === undefined) {
      throw new Error(`kiokuko-dsh confirmation could not advance: ${decision.kind === 'blocked' ? decision.reason : 'missing_response'}`)
    }
    item.prepared = { ...item.prepared, ennoOduno: response.ennoOduno }
    const next = policyState(response.ennoOduno, item, item.sessionId, response.executionLease)
    states.set(item.runId, next)
    policy.setState(next)
    return 'submitted'
  }
  const injectBoundaryContext = async (item: TurnRecord, state: EnnoOdunoState): Promise<void> => {
    const event = boundaryEvent(item)
    await assertTurnBoundary(event)
    if (state.directive === null) throw new Error('kiokuko-dsh boundary context has no directive')
    const selection = selectDshDirectiveSources(state.directive)
    const exactNativeAgent = item.nativeAgent as { readonly inject?: (message: unknown) => void } | undefined
    const agent = exactNativeAgent === undefined ? agents?.get(item.agentId) : exactNativeAgent
    if (agent?.inject === undefined) throw new Error('kiokuko-dsh native agent injection is unavailable')
    const contextKey = contextInjectionKey(item, item.turn, state, selection)
    if (item.contextInjectionKey === contextKey) return
    const projectedDirective = projectDshDirective({ nextAction: state.nextAction, directive: state.directive })
    const advisoryEvidence = await advisoryEvidenceFor(item, state)
    const messages = await injectDshContext({
      prepared: item.prepared,
      task: item.task,
      routeSkillNames: selection.routeSkillNames,
      expertRefs: selection.expertRefs,
      ...(projectedDirective === null ? {} : { directive: projectedDirective }),
      ...(advisoryEvidence === undefined ? {} : { advisoryEvidence }),
      runtime,
    })
    for (const message of messages) {
      agent.inject({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message.content }], source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' } })
    }
    item.contextInjectionKey = contextKey
  }
  const runFinalVerificationBoundary = async (item: TurnRecord): Promise<void> => {
    await assertTurnBoundary(boundaryEvent(item))
    const state = await readBoundaryState(item)
    if (state.contractRevision === null) throw new Error('kiokuko-dsh verification revision is unavailable')
    const response = await runtime.withDatabase((database) => prepareEnnoVerification(database, {
      runId: item.runId,
      workspace: item.workspace,
      orchestrationId: item.orchestrationId,
      expectedRevision: state.contractRevision,
      idempotencyKey: `dsh-verify:${canonicalContentHash({ runId: item.runId, revision: state.contractRevision })}`,
    }))
    item.prepared = { ...item.prepared, ennoOduno: response.ennoOduno }
    const next = policyState(response.ennoOduno, item, item.sessionId)
    states.set(item.runId, next)
    policy.setState(next)
  }

  // Retained as a public compatibility implementation, but production host
  // mounting below uses the durable worker instead of the native callback.
  const ennoController = new DshEnnoController({
    readState: async (event) => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh agent is not bound to a run')
      return readBoundaryState(item)
    },
    validateBoundary: async ({ event }) => { await assertTurnBoundary(event) },
    confirmUser: async ({ event, state }) => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh confirmation turn is not bound')
      return confirmBoundary(item, state)
    },
    injectNextStepContext: async ({ event, state }) => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh turn identity is not bound')
      await injectBoundaryContext(item, state)
    },
    runFinalVerification: async ({ event }) => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh verification turn identity is not bound')
      await runFinalVerificationBoundary(item)
      return readBoundaryState(item)
    },
    advisoryRunner,
    submitAdvisory,
  })

  const boundaryWorker = new DshBoundaryWorker({
    runtime,
    ...(options.now === undefined ? {} : { now: options.now }),
    bindNativeAgent: (sessionId, nativeAgent) => {
      const item = currentSession(sessionId)
      if (item !== undefined && item.nativeAgent !== undefined && item.nativeAgent !== nativeAgent) {
        throw new Error('kiokuko-dsh boundary agent identity changed')
      }
      boundaryAgents.set(sessionId, nativeAgent)
    },
    process: async (job: DshBoundaryJob) => {
      const item = currentSession(job.dshSessionId)
      if (item === undefined || item.closed || item.runId !== job.runId || item.turn < job.nativeTurn) {
        throw new Error('kiokuko-dsh boundary job has no exact live run binding')
      }
      if (job.kind.startsWith('retry_') || job.kind === 'ask_akinator') {
        return { kind: 'completed', nextKind: 'delivery' }
      }
      if (job.kind === 'classify_boundary') {
        const state = await readBoundaryState(item)
        if (state.status === 'completed' || state.status === 'blocked' || state.status === 'cancelled'
          || state.nextAction === 'complete' || state.nextAction === 'report_blocker') {
          await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
            database.prepare(`UPDATE dsh_continuation_outbox SET status = 'superseded', updated_at = ? WHERE receipt_id = ? AND status IN ('pending', 'dispatched')`)
              .run(options.now?.() ?? new Date().toISOString(), job.receiptId)
          }))
          return { kind: 'superseded' }
        }
        if (state.nextAction === 'ask_user_confirmation') return { kind: 'completed', nextKind: 'confirmation' }
        if (state.nextAction === 'run_final_verification') return { kind: 'completed', nextKind: 'final_verification' }
        if (state.directive?.advisoryRound !== undefined && state.advisoryPhaseState.state !== 'aggregated') {
          return { kind: 'completed', nextKind: 'advisory' }
        }
        return { kind: 'completed', nextKind: 'context' }
      }
      if (job.kind === 'confirmation') {
        const outcome = await confirmBoundary(item, await readBoundaryState(item))
        if (outcome === 'dismissed') {
          await sessionMirror.markWaitingUser(item.sessionId)
          return { kind: 'waiting_user' }
        }
        return { kind: 'completed', nextKind: 'classify_boundary' }
      }
      if (job.kind === 'final_verification') {
        await runFinalVerificationBoundary(item)
        return { kind: 'completed', nextKind: 'classify_boundary' }
      }
      if (job.kind === 'advisory') {
        const state = await readBoundaryState(item)
        const directive = state.directive?.advisoryRound
        if (directive === undefined) return { kind: 'completed', nextKind: 'classify_boundary' }
        const result = await advisoryRunner.run({ directive, signal: new AbortController().signal })
        await submitAdvisory(result, { event: boundaryEvent(item), state })
        return { kind: 'completed', nextKind: 'classify_boundary' }
      }
      if (job.kind === 'context') {
        const state = await readBoundaryState(item)
        await injectBoundaryContext(item, state)
        await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          const outbox = readPendingOutbox(database, item.sessionId).find((candidate) => candidate.receiptId === job.receiptId)
          if (outbox !== undefined) replacePendingOutboxMessageInTransaction(database, job.receiptId, continuationMessage(outbox.continuationId, state.nextAction))
        }))
        return { kind: 'completed', nextKind: 'delivery' }
      }
      throw new Error(`unsupported DSH boundary job kind: ${job.kind}`)
    },
    flush: async (job) => {
      const item = currentSession(job.dshSessionId)
      const nativeSession = item?.nativeSession ?? sessions?.get(job.dshSessionId)
      if (nativeSession === undefined || sessions?.flush === undefined) {
        throw new Error('kiokuko-dsh native session flush is unavailable for boundary delivery')
      }
      await sessions.flush(nativeSession)
      try { await sessionMirror.checkpointAfterNativeFlush(nativeSession as DshMirrorEventSession) } catch { /* non-vetoing cache */ }
    },
    dispatch: async (job, outbox) => {
      const item = currentSession(job.dshSessionId)
      const nativeAgent = (boundaryAgents.get(job.dshSessionId) ?? agents?.get(job.dshSessionId)) as { readonly steer?: (message: unknown) => void } | undefined
      if ((item !== undefined && (item.closed || item.runId !== job.runId)) || nativeAgent?.steer === undefined) {
        throw new Error('kiokuko-dsh native boundary delivery agent is unavailable')
      }
      nativeAgent.steer(outbox.message)
    },
  })

  const rehydrateBoundarySession = async (nativeAgent: NativeAgent): Promise<void> => {
    const nativeSession = nativeAgent.session ?? sessions?.get(nativeAgent.id)
    const sessionId = nativeSession?.id
    const cwd = nativeSession?.header?.cwd
    if (sessionId === undefined || cwd === undefined || typeof nativeSession?.snapshotEvents !== 'function') return
    const pending = await runtime.withDatabase((database) => database.prepare(`
      SELECT receipt.run_id AS runId, receipt.native_turn AS nativeTurn,
             intake.task_text AS task
        FROM dsh_boundary_jobs AS job
        JOIN dsh_turn_receipts AS receipt ON receipt.receipt_id = job.receipt_id
        JOIN ledger_runs AS run ON run.run_id = receipt.run_id
        JOIN run_intakes AS link ON link.run_id = run.run_id
        JOIN akinator_sessions AS intake ON intake.id = link.session_id
       WHERE receipt.dsh_session_id = ?
         AND job.status IN ('pending', 'processing', 'failed_retryable')
         AND run.status IN ('intake', 'active')
       ORDER BY job.created_at, job.job_id LIMIT 2
    `).all<{ runId: string; nativeTurn: number; task: string }>(sessionId))
    if (pending.length === 0) return
    if (new Set(pending.map(row => row.runId)).size !== 1) {
      throw new KiokukoError('CONFLICT', 'Multiple durable boundary runs target one live DSH session')
    }
    const first = pending[0]!
    const catalog = await capabilityCatalog(skills, tools, {
      agent: { id: nativeAgent.id }, nativeAgent, cwd, signal: new AbortController().signal,
    })
    await gate.prepare({
      agent: { id: nativeAgent.id }, nativeAgent, sessionId, nativeSession,
      turn: first.nativeTurn, step: 1, task: first.task, cwd, capabilities: catalog,
      sourceStartSeq: dshTurnBoundarySeq(nativeSession as DshSessionEventSource, first.nativeTurn, 'start'),
      signal: new AbortController().signal,
    })
    boundaryWorker.kick(sessionId, nativeAgent)
  }
  const boundarySessionStartDisposer = (ctx as any).on('agent/session-start', (payload: { agent: NativeAgent }) => {
    void rehydrateBoundarySession(payload.agent).catch(() => {
      // Durable jobs remain retryable. A later pre-step/status kick retries
      // once the exact live Agent and its capabilities are available.
    })
  })
  for (const nativeAgent of agents?.list?.() ?? []) {
    void rehydrateBoundarySession(nativeAgent).catch(() => undefined)
  }

  const resolveIdleClose = async (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object): Promise<DshCloseIntent | undefined> => {
    const item = currentForAgentEvent(agentId, sessionId, undefined, nativeSession, nativeAgent)
    if (item === undefined || item.closed) return undefined
    const state = await runtime.withDatabase((database) => stateForRun(database, item))
    if (state.status === 'cancelled') return { runId: item.runId, status: 'cancelled' }
    if (state.status === 'blocked' || state.nextAction === 'report_blocker') return { runId: item.runId, status: 'failed' }
    // A chat run spans the quiet time between user messages. Enno's
    // inapplicable `complete` means that no orchestration is required for this
    // turn; it does not mean that the persistent conversation has ended.
    if (item.prepared.intake.profile.taskType === 'chat') return undefined
    if (state.status === 'completed' || state.nextAction === 'complete') {
      return item.failed
        ? { runId: item.runId, status: 'failed' }
        : { runId: item.runId, status: 'completed', terminalTurn: item.turn }
    }
    // Idle means the driver has no active work, not that Enno reached a
    // terminal state. Keep only genuinely resumable active states open.
    return undefined
  }
  const resolveSessionRunId = (session: { id: string }): string | undefined => {
    const item = currentSession(session.id)
    if (item?.nativeSession !== undefined && item.nativeSession !== session) return undefined
    return item?.closed === true ? undefined : item?.runId
  }
  const resolveSessionClose = async (sessionId: string, nativeSession: object): Promise<DshCloseIntent | undefined> => {
    const item = currentSession(sessionId)
    if (item === undefined || item.closed || item.nativeSession !== nativeSession) return undefined
    if (item.failed) return { runId: item.runId, status: 'failed' }
    const state = await runtime.withDatabase((database) => stateForRun(database, item))
    if (state.status === 'cancelled') return { runId: item.runId, status: 'cancelled' }
    if (state.status === 'blocked' || state.nextAction === 'report_blocker') return { runId: item.runId, status: 'failed' }
    if (item.prepared.intake.profile.taskType === 'chat' || state.status === 'completed' || state.nextAction === 'complete') {
      return { runId: item.runId, status: 'completed', terminalTurn: item.turn }
    }
    return { runId: item.runId, status: 'cancelled' }
  }
  const closeRun = async (input: DshRunClose): Promise<void> => {
    let scheduled = false
    let scheduledSessionId: string | undefined
    await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      const store = new LedgerStore(database)
      const before = store.readRun(input.runId)
      if (before === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Run close target does not exist')
      if (before.status === 'intake' || before.status === 'active') {
        terminalizeLedgerRunInTransaction(database, input.runId, input.status)
      } else if (before.status !== input.status) {
        throw new KiokukoError('CONFLICT', 'Run close status is immutable')
      }
      if (input.status === 'completed') {
        if (input.sourceEndSeq === undefined) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Completed DSH run has no checkpointed log end')
        }
        memoryFinalizer.scheduleInTransaction(database, {
          runId: before.runId,
          workspace: before.workspace,
          dshSessionId: before.dshSessionId,
          sourceEndSeq: input.sourceEndSeq,
        })
        scheduled = true
        scheduledSessionId = before.dshSessionId
      }
    }))
    if (scheduled) {
      if (scheduledSessionId === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Completed run has no DSH session identity')
      await sessionMirror.markUnfinalized(scheduledSessionId)
      memoryFinalizer.kick()
    }
    const items = [...turns.values()].filter((candidate) => candidate.runId === input.runId)
    for (const item of items) {
      ennoController.retire({
        ...(item.nativeAgent === undefined ? {} : { nativeAgent: item.nativeAgent }),
        ...(item.nativeSession === undefined ? {} : { nativeSession: item.nativeSession }),
      })
      item.closed = true
      gate.clearTurn(item.sessionId, item.turn)
      const modeKey = identityKey(item.agentId, item.sessionId)
      const modeRequest = `dsh:${item.agentId}:${item.sessionId}:${item.turn}`
      if (activeModeRequests.get(modeKey) === modeRequest) {
        modes.end(modeRequest)
        activeModeRequests.delete(modeKey)
      }
      turns.delete(turnKey(item.agentId, item.sessionId, item.turn))
      if (latestBySession.get(item.sessionId) === item) latestBySession.delete(item.sessionId)
    }
    for (const sessionId of new Set(items.map((item) => item.sessionId))) {
      if (![...turns.values()].some((candidate) => candidate.sessionId === sessionId && !candidate.closed)) policy.clearSession(sessionId)
    }
    if (![...turns.values()].some((candidate) => candidate.runId === input.runId)) states.delete(input.runId)
    advisoryRounds.delete(input.runId)
    resumedLeases.delete(input.runId)
  }
  const errorDisposer = (ctx as any).on('agent/error', (event: { agent: { id: string; session?: { id: string }; sessionId?: string } }) => {
    const item = currentForAgentEvent(event.agent.id, event.agent.session?.id ?? event.agent.sessionId, undefined, event.agent.session, event.agent)
    if (item !== undefined) item.failed = true
  })
  const sessionEventDisposer = (ctx as any).on('session/event', (session: { id: string }, event: { type?: unknown; seq?: unknown; data?: unknown }) => {
    // This observer is deliberately fire-and-contain. DSH persistence and the
    // model turn must never depend on Kiokuko claim bookkeeping.
    void (async () => {
      if (typeof event.type === 'string' && typeof event.seq === 'number') {
        await sessionMirror.observe(session.id, event as DshLogEvent)
        const continuationId = eventContinuationId(event.data)
        if (continuationId !== undefined) {
          try {
            await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
              markOutboxObservedInTransaction(database, continuationId, event.seq as number)
            }))
          } catch {
            // Delivery observation is durable bookkeeping. A missed callback
            // is recovered by delivery-id deduplication at the next pre-step.
          }
        }
      }
      const item = currentSession(session.id)
      if (item === undefined || item.closed || typeof event.type !== 'string') return
      const data = objectRecord(event.data)
      const eventTurn = typeof data?.turn === 'number' && Number.isSafeInteger(data.turn)
        ? data.turn
        : item.turn
      if (eventTurn !== item.turn) return
      const claimKey = `${item.sessionId}\u0000${item.turn}`
      const fallback = inMemoryClaims.get(claimKey)
      const providerStarted = event.type === 'request/header'
        || event.type === 'request/context'
        || event.type === 'assistant/chunk'
        || event.type === 'assistant/message'
      const sideEffectStarted = event.type === 'tool/call'
      if (fallback !== undefined) {
        fallback.providerStarted ||= providerStarted
        fallback.sideEffectStarted ||= sideEffectStarted
      }
      if (providerStarted || sideEffectStarted) {
        try {
          await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
            markClaimProgressInTransaction(database, {
              dshSessionId: item.sessionId,
              nativeTurn: item.turn,
              providerStarted,
              sideEffectStarted,
            })
          }))
        } catch {
          // The process-local flags remain monotonic.
        }
      }
      if (event.type !== 'turn/end') return
      const reason = objectRecord(data?.reason)
      const turnEndedWithError = reason?.kind === 'error'
      let durableRecoverable = false
      try {
        const settled = await runtime.withDatabase((database) => withImmediateTransaction(database, () => (
          settleInputClaimInTransaction(database, {
            dshSessionId: item.sessionId,
            nativeTurn: item.turn,
            turnEndedWithError,
          })
        )))
        durableRecoverable = settled?.status === 'recoverable'
      } catch {
        // Fall through to the process-local decision.
      }
      const locallyRecoverable = turnEndedWithError
        && fallback !== undefined
        && !fallback.providerStarted
        && !fallback.sideEffectStarted
        && !fallback.recovered
      const steer = (item.nativeAgent as { steer?: (message: unknown) => void } | undefined)?.steer
      if ((durableRecoverable || locallyRecoverable) && steer !== undefined) {
        let messages: readonly unknown[] | undefined
        if (durableRecoverable) {
          try {
            const claim = await runtime.withDatabase((database) => withImmediateTransaction(database, () => (
              takeRecoverableInputClaimInTransaction(database, item.sessionId, item.turn)
            )))
            messages = claim?.messages
          } catch {
            // Use the exact in-memory batch if the durable consumer failed.
          }
        }
        messages ??= fallback?.messages
        if (messages !== undefined && messages.length > 0) {
          if (fallback !== undefined) fallback.recovered = true
          for (const message of messages) steer(message)
        }
      }
      if (!turnEndedWithError || (!durableRecoverable && !locallyRecoverable)) inMemoryClaims.delete(claimKey)
      boundaryWorker.kick(item.sessionId, item.nativeAgent)
    })().catch(() => {
      // Observe-only DSH listeners must never veto the native event.
    })
  })
  const runLifecycle = new DshRunLifecycle({ closeRun })
  retireSupersededRun = async (item, status) => {
    if (status !== 'completed') {
      await runLifecycle.closeTurn({ runId: item.runId, status })
      return
    }
    if (item.nativeSession === undefined || sessions?.flush === undefined) {
      throw new KiokukoError('CONFLICT', 'Completed DSH run requires its exact native session checkpoint')
    }
    await sessions.flush(item.nativeSession)
    await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession)
    await runLifecycle.closeTurn({
      runId: item.runId,
      status,
      sourceEndSeq: dshTurnBoundarySeq(sessionEventSource(item.nativeSession), item.turn, 'end'),
    })
  }

  const host: DshCompositionHost = {
    ...(skills === undefined ? {} : { skills: skills as any }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    runtime,
    runtimeOwner: 'host',
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
    dispose: async () => {
      const failures: unknown[] = []
      try { errorDisposer?.() } catch (error) { failures.push(error) }
      try { sessionEventDisposer?.() } catch (error) { failures.push(error) }
      try { boundarySessionStartDisposer?.() } catch (error) { failures.push(error) }
      try { policy.dispose() } catch (error) { failures.push(error) }
      try { modes.dispose() } catch (error) { failures.push(error) }
      try { ennoController.dispose() } catch (error) { failures.push(error) }
      try { await boundaryWorker.dispose() } catch (error) { failures.push(error) }
      const remainingRuns = [...new Map(
        [...turns.values()]
          .filter((item) => !item.closed)
          .map((item) => [item.runId, item]),
      ).values()]
      for (const item of remainingRuns) {
        try {
          let status: 'completed' | 'failed' | 'cancelled'
          if (item.failed) status = 'failed'
          else if (item.prepared.intake.profile.taskType === 'chat') status = 'cancelled'
          else {
            const state = await runtime.withDatabase((database) => stateForRun(database, item))
            status = state.status === 'completed' || state.nextAction === 'complete'
              ? 'completed'
              : state.status === 'blocked' || state.nextAction === 'report_blocker'
                ? 'failed'
                : 'cancelled'
          }
          if (status === 'completed') {
            if (item.nativeSession === undefined || sessions?.flush === undefined) {
              throw new KiokukoError('CONFLICT', 'Completed DSH run requires its exact native session checkpoint')
            }
            await sessions.flush(item.nativeSession)
            await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession)
          }
          await runLifecycle.closeTurn({
            runId: item.runId,
            status,
            ...(status !== 'completed' ? {} : {
              sourceEndSeq: dshTurnBoundarySeq(sessionEventSource(item.nativeSession), item.turn, 'end'),
            }),
          })
        } catch (error) { failures.push(error) }
      }
      try { await runLifecycle.dispose() } catch (error) { failures.push(error) }
      try { await memoryFinalizer.dispose() } catch (error) { failures.push(error) }
      try { await sessionMirror.close() } catch (error) { failures.push(error) }
      try { await runtime.close() } catch (error) { failures.push(error) }
      turns.clear()
      latestBySession.clear()
      states.clear()
      activeModeRequests.clear()
      advisoryRounds.clear()
      boundaryAgents.clear()
      resumedTurns.clear()
      resumedLeases.clear()
      inMemoryClaims.clear()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh adapter disposal failed')
    },
  }
}

function isEnnoResponse(value: unknown): value is EnnoOperationResponse {
  return typeof value === 'object' && value !== null && 'ennoOduno' in value && typeof (value as { ennoOduno?: unknown }).ennoOduno === 'object'
}

function isTurnOutcome(value: unknown): value is { readonly kind: 'applied' | 'retry' | 'clarify' | 'waiting_user' | 'infrastructure_error' } {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'applied' || kind === 'retry' || kind === 'clarify' || kind === 'waiting_user' || kind === 'infrastructure_error'
}

function isAppliedEnnoOutcome(value: unknown): value is { readonly kind: 'applied'; readonly value: EnnoOperationResponse } {
  return isTurnOutcome(value) && value.kind === 'applied'
    && 'value' in value && isEnnoResponse((value as { value?: unknown }).value)
}

function stateForRun(database: any, item: TurnRecord): EnnoOdunoState {
  if (!item.prepared.ennoOduno.applicable) return item.prepared.ennoOduno
  return stateForSnapshot(readEnnoSnapshot(database, { runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId }))
}

export { KIOKUKO_DSH_HOST_SERVICE }
