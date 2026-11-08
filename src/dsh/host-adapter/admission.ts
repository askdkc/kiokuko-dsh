import { KIOKUKO_DSH_SOURCE_KIND } from '../plugin-source.js'
import { isVerificationContinuation, acceptsVerificationContinuation } from '../verification-continuation.js'
import { nativeRequestProposals } from '../request-proposals.js'
import { readTaskCorrections } from '../correction-context.js'
import { timeConstraintForRequest } from '../../memory/retrieval-contracts.js'
import { isNativeSubagent } from '../native-subagent.js'
import {
  recordDiagnosticAdmission,
  observeDiagnostic,
} from '../decisions/diagnostics.js'
import type { TaskType } from '../../akinator/types.js'
import { createTurnState } from '../host-adapter/turn-state.js'
import {
  bindMemoryApplication,
  memoryRetrievalStatus,
} from '../../memory/application.js'
import { createMemoryReuseRuntime } from '../memory-reuse.js'
import type { DecisionService } from '../decisions/service.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import {
  classifyTaskForIntake,
  selectInstalledSkills,
} from '../decisions/workflows.js'
import {
  classifyRequestIntent,
  createRequestIntentContext,
  rebindRequestIntentDecision,
  requestIntentMessageRefs,
  requestIntentReferenceIds,
  requestIntentTaskType,
  requestIntentIsUnresolved,
  type RequestIntentContext,
  type RequestIntentDecision,
  type RequestIntentInterpretation,
} from '../decisions/request-intent.js'
import { humanInput } from '../../memory/review/evidence.js'
import { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import {
  ANSWER_REVIEW_FORM,
  hasHumanInput,
  type ReviewAgent,
} from '../answer-review/contracts.js'
import {
  AutoMemoryReviewCoordinator,
  type ReviewNativeSession,
} from '../auto-memory-review.js'
import { refreshContinuedTaskContext } from '../task-intake.js'
import { saveSessionNotice } from '../plugin-records.js'
import { AkinatorMemoryConfig } from '../config.js'
import {
  explicitExecutionMode,
  initializeExecutionSelection,
  readExecutionSelection,
  writeExecutionSelection,
  type StoredExecutionSelection,
} from '../execution-selection.js'
import {
  selectExecution,
  ExecutionSelectionPending,
} from '../model-selection-ui.js'
import {
  LISP_CODING_SERVICE,
  type LispCodingService,
} from '../lisp/coding-choice.js'
import type {
  ModelRoute,
  DshModelCatalog,
  DshModelCompatibility,
} from '../model-configuration.js'
import type { DeepPlanningController } from '../../deep-thinker/controller.js'
import { realpathSync } from 'node:fs'
import { type DshNativePreStepPayload } from '../composition.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { assertCapabilityCatalogBinding } from '../../akinator/capability-binding.js'
import {
  DshIntakeGate,
  type DshCapabilityReadContext,
  type DshIntakeGateResult,
  type DshPreStepDecision,
  type DshPreStepEvent,
} from '../intake-gate.js'
import { resolveGroundedIntakeProfile } from '../intake-profile-resolver.js'
import type { PreparedAgentTask } from '../task-intake.js'
import { deriveAkinatorReasoning } from '../../akinator/reasoning.js'
import {
  resolveCapabilities,
  hasBlockingRequiredCapability,
} from '../../akinator/capabilities.js'
import { readAkinatorSession, readRunIntakeLink } from '../../akinator/store.js'
import { type DshCloseIntent, type DshRunClose } from '../session-bridge.js'
import {
  DshMemoryFinalizer,
  dshTurnBoundarySeq,
  type DshLogEvent,
  type DshSessionEventSource,
} from '../session-memory-finalizer.js'
import {
  createDshIntakeAnswerer,
  type DshUserQuestions,
} from '../user-interaction.js'
import { type DshCapabilityCatalog } from '../capability-catalog.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { KiokukoError } from '../../errors.js'
import { resolveProjectWorkspaceReadOnly } from '../../memory/workspaces.js'
import {
  supersedeBoundaryJobsAtOrBeforeRevisionInTransaction,
  supersedeOutboxAtOrBeforeRevisionInTransaction,
} from '../turn-process.js'
import { unexecutedRunInput } from '../input-claim.js'
import {
  DshSessionLogMirror,
  type DshMirrorEventSession,
} from '../session-log-mirror.js'
import {
  DshExecutionSupport,
  type ExecutionBinding,
} from '../execution-support.js'
import { resetLoopGuardForUserInTransaction } from '../loop-guard.js'
import type {
  NativeSkills,
  NativeTools,
  NativeSessions,
  NativeAgents,
  AdapterContext,
} from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import { readCodingWorkflow } from '../coding-workflow/store.js'
import { markCodingScopeChange } from '../coding-workflow/service.js'
import { readExecutionFrame } from '../execution-frame.js'
import {
  assertMemoryOwner,
  createMemoryOwner,
  memoryOwnerKind,
} from '../memory-owner.js'
import {
  executionClarification,
  isContinuationReference,
} from '../intake-clarification.js'
import {
  authorizeTaskLease,
  bindTaskRepository,
  captureTaskLease,
  clearTaskUnresolved,
  findSessionTask,
  readTaskSnapshot,
  recordTaskUnresolved,
  resumeCompletedCodingTurn,
  taskCanExecute,
} from '../task-state.js'
import { continueTaskIntake } from '../existing-task-intake.js'
import { LedgerStore } from '../../ledger/store.js'
import {
  claimExecutionOwner,
  readExecutionOwner,
} from '../orchestration/execution-owner.js'
import { initializeCodingWorkflow } from '../coding-workflow/store.js'
import { codingWorkRequested } from '../coding-workflow/intent.js'
import { initializeTaskCompletion } from '../task-completion.js'
import type { DshLlm } from '../session-memory-finalizer.js'

interface AdmissionDependencies {
  readonly completionMode: import('../task-completion.js').CompletionMode
  readonly llm: DshLlm | undefined
  readonly native: AdapterContext
  readonly skills: NativeSkills | undefined
  readonly tools: NativeTools | undefined
  readonly userQuestions: DshUserQuestions | undefined
  readonly sessions: NativeSessions | undefined
  readonly agents: NativeAgents | undefined
  readonly deepPlanning: DeepPlanningController
  readonly modelCatalog: DshModelCatalog | undefined
  readonly modelCompatibility: DshModelCompatibility | undefined
  readonly modelRoutes: readonly ModelRoute[] | undefined
  readonly now: (() => string) | undefined
  readonly runtime: DshCoreRuntime
  readonly decisions: DecisionService
  readonly answerReview: AnswerReviewCoordinator
  readonly executionSupport: DshExecutionSupport
  readonly memoryFinalizer: DshMemoryFinalizer
  readonly autoReview: AutoMemoryReviewCoordinator
  readonly sessionMirror: DshSessionLogMirror
  readonly akinatorMemoryConfig: import('zod').z.infer<
    typeof AkinatorMemoryConfig
  >
  readonly memoryRetrievalConfig: import('zod').z.infer<
    typeof import('../../memory/retrieval-contracts.js').MemoryRetrievalConfig
  >
  readonly turnState: ReturnType<typeof createTurnState>
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly setSelection: (
    runId: string,
    value: StoredExecutionSelection,
  ) => void
  readonly executionBinding: (item: TurnRecord) => ExecutionBinding
  readonly captureInitialInput: (
    sessionId: string,
    turn: number,
    messages: readonly unknown[],
  ) => Promise<void>
  readonly contextMessages: (
    event: DshPreStepEvent,
    pending: readonly unknown[],
  ) => Promise<readonly unknown[]>
  readonly resolveIdleClose: (
    agentId: string,
    sessionId?: string,
    nativeSession?: object,
    nativeAgent?: object,
  ) => Promise<DshCloseIntent | undefined>
  readonly retireSupersededRun: (
    item: TurnRecord,
    status: 'completed' | 'failed' | 'cancelled',
  ) => Promise<void>
  readonly cancelBoundarySession: (sessionId: string) => void
  readonly isSelectionBlocked: (agent: object) => boolean
  readonly markSelectionPending: (agent: object) => void
  readonly closeTurn: (input: DshRunClose) => Promise<void>
  readonly capabilityCatalog: (
    skills: NativeSkills | undefined,
    tools: NativeTools | undefined,
    context: DshCapabilityReadContext,
  ) => Promise<DshCapabilityCatalog>
  readonly sessionEventSource: (
    value: object | undefined,
  ) => DshSessionEventSource
  readonly objectRecord: (value: unknown) => Record<string, unknown> | undefined
  readonly isHumanMessage: (value: unknown) => boolean
  readonly textFromMessages: (
    messages: readonly unknown[],
    fallback?: string,
  ) => string
  readonly pluginContinuationId: (value: unknown) => string | undefined
  readonly isLoopRecoveryMessage: (value: unknown) => boolean
}

interface AdmissionOwner {
  readonly gate: DshIntakeGate & {
    prepareRequestedWork(event: DshPreStepEvent): Promise<DshIntakeGateResult>
  }
  readonly mapPreStep: (
    payload: DshNativePreStepPayload,
    advisoryType?: TaskType,
    requestIntent?: RequestIntentDecision,
  ) => Promise<DshPreStepEvent>
  readonly requestContext: (
    payload: DshNativePreStepPayload,
    task: string,
  ) => Promise<RequestIntentContext | undefined>
  readonly interpret: (
    payload: DshNativePreStepPayload,
  ) => Promise<RequestIntentInterpretation | undefined>
  readonly refreshMemoryOwner: (
    item: TurnRecord,
    signal: AbortSignal,
  ) => Promise<void>
  readonly clear: () => void
}

export function createAdmission({
  native,
  skills,
  tools,
  userQuestions,
  sessions,
  agents,
  deepPlanning,
  modelCatalog,
  modelCompatibility,
  modelRoutes,
  now,
  runtime,
  llm,
  decisions,
  answerReview,
  executionSupport,
  memoryFinalizer,
  autoReview,
  sessionMirror,
  akinatorMemoryConfig,
  memoryRetrievalConfig,
  completionMode,
  turnState,
  getSelection,
  setSelection,
  executionBinding,
  captureInitialInput,
  contextMessages,
  resolveIdleClose,
  retireSupersededRun,
  cancelBoundarySession,
  isSelectionBlocked,
  markSelectionPending,
  closeTurn,
  capabilityCatalog,
  sessionEventSource,
  objectRecord,
  isHumanMessage,
  textFromMessages,
  pluginContinuationId,
  isLoopRecoveryMessage,
}: AdmissionDependencies): AdmissionOwner {
  const currentSession = turnState.currentSession
  const currentForAgentEvent = turnState.currentForAgentEvent
  let resumeExistingRun:
    | ((event: DshPreStepEvent) => Promise<DshIntakeGateResult | undefined>)
    | undefined
  function eventTurn(event: { readonly data?: unknown }): number | undefined {
    const data =
      typeof event.data === 'object' &&
      event.data !== null &&
      !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : undefined
    return Number.isSafeInteger(data?.turn) ? (data!.turn as number) : undefined
  }

  function continuesCodingScope(event: DshPreStepEvent): boolean {
    const intent = event.requestIntent
    return (
      !!intent &&
      (intent.relation === 'same_scope_continuation' ||
        intent.relation === 'scope_change') &&
      intent.action !== 'answer' &&
      intent.action !== 'unknown'
    )
  }

  let prepareGeneration = 0
  const continuedTurns = new Map<
    string,
    {
      readonly fingerprint: string
      readonly profileHints?: DshPreStepEvent['profileHints']
      readonly unresolvedBinding?: string
      readonly result: DshIntakeGateResult
      readonly nativeAgent?: object
      readonly nativeSession?: object
    }
  >()
  const resumedTurns = new Map<
    string,
    {
      readonly fingerprint: string
      readonly profileHints?: DshPreStepEvent['profileHints']
      readonly result: DshIntakeGateResult
      readonly nativeAgent?: object
      readonly nativeSession?: object
    }
  >()
  const bindAndRecord = async (
    event: DshPreStepEvent,
    result: DshIntakeGateResult,
    generation: number,
  ): Promise<void> => {
    const authority = await runtime.withDatabase((database) => {
      const identity = {
        taskId: result.prepared.run.runId,
        sessionId: event.sessionId,
        repositoryRoot: result.prepared.project.repositoryRoot,
      }
      bindTaskRepository(database, identity)
      if (event.signal.aborted) return undefined
      // Completion can settle while the final model response is streaming.
      // Retain that response without issuing another execution lease.
      if (readTaskSnapshot(database, identity).state === 'Done') return undefined
      // A continued native turn can reuse an already Working task without a
      // fresh admission. Capture its current lease from SQLite as well; never
      // synthesize authority from the model or a cached turn record.
      try {
        return captureTaskLease(database, identity)
      } catch (error) {
        if (result.admitted) throw error
        return undefined
      }
    })
    if (authority)
      await runtime.withDatabase((database) =>
        authorizeTaskLease(database, authority),
      )
    turnState.record(event, result, generation, authority)
    await observeDiagnostic(runtime, event.sessionId, (db) =>
      recordDiagnosticAdmission(db, {
        sessionId: event.sessionId,
        turn: event.turn,
        runId: result.prepared.run.runId,
        task: event.task,
        ...(event.requestIntentContext
          ? { context: event.requestIntentContext }
          : {}),
        ...(event.requestIntent ? { decision: event.requestIntent } : {}),
      }),
    )
    const reviewItem = currentSession(event.sessionId)
    const reviewAgent = event.nativeAgent as ReviewAgent | undefined
    if (
      reviewItem &&
      reviewAgent?.session &&
      typeof reviewAgent.session.snapshotEvents === 'function'
    ) {
      const eligible = () => {
        const item = currentSession(event.sessionId),
          selection = getSelection(reviewItem.runId)?.value
        return (
          item?.runId === reviewItem.runId &&
          !item.closed &&
          !item.failed &&
          item.prepared.run.status === 'active' &&
          !selection?.discussion &&
          (!selection ||
            (selection.mode === 'normal' && selection.status === 'ready')) &&
          !deepPlanning.executor.isChild(reviewAgent) &&
          !isNativeSubagent(reviewAgent) &&
          !executionSupport.paused(event.sessionId)
        )
      }
      answerReview.bind({
        runId: reviewItem.runId,
        workspace: reviewItem.workspace,
        requestId: `run:${reviewItem.runId}`,
        task: reviewItem.task,
        catalogDigest: reviewItem.catalog.digest,
        turn: event.turn,
        agent: reviewAgent,
        eligible,
        current: () => {
          const item = currentSession(event.sessionId)
          return (
            item?.runId === reviewItem.runId &&
            item.nativeAgent === reviewAgent &&
            item.nativeSession === reviewAgent.session &&
            agents?.get(reviewAgent.id) === reviewAgent &&
            sessions?.get(event.sessionId) === reviewAgent.session
          )
        },
        settled: async () => {
          const item = currentSession(event.sessionId)
          if (
            !item ||
            item.runId !== reviewItem.runId ||
            item.closed ||
            (reviewAgent as any).status === 'running'
          )
            return
          const intent = await resolveIdleClose(
            item.agentId,
            item.sessionId,
            item.nativeSession,
            item.nativeAgent,
          )
          if (intent) await retireSupersededRun?.(item, intent.status)
        },
      })
    }
    // Memory delivery/binding is not an admission prerequisite.
  }

  async function hasPendingExecutionDiscussion(
    sessionId: string,
    cwd: string,
  ): Promise<boolean> {
    return runtime.withDatabase(async (db) => {
      const project = await resolveProjectWorkspaceReadOnly(db, cwd, {
        allowDirectory: true,
      })
      if (!project) return false
      const activeRuns = db
        .prepare(
          `SELECT run_id FROM ledger_runs
        WHERE workspace=? AND dsh_session_id=? AND status='active'`,
        )
        .all<{ run_id: string }>(project.workspace, sessionId)
      if (activeRuns.length !== 1) return false
      return (
        readExecutionSelection(db, activeRuns[0]!.run_id)?.value.discussion !==
        undefined
      )
    })
  }

  class CapturingGate extends DshIntakeGate {
    readonly supersededChoices = new Map<string, StoredExecutionSelection>()
    async choose(
      event: DshPreStepEvent,
      result: DshIntakeGateResult,
    ): Promise<DshIntakeGateResult> {
      const runId = result.prepared.run.runId
      let stored = await runtime.withDatabase((db) =>
        readExecutionSelection(db, runId),
      )
      const key = `${event.sessionId}\u0000${event.turn}`
      const inherited = this.supersededChoices.get(key)
      if (
        stored?.value.mode === 'pending' &&
        inherited?.value.status === 'ready' &&
        inherited.value.mode === 'normal' &&
        (!explicitExecutionMode(event.task) ||
          explicitExecutionMode(event.task) === inherited.value.mode)
      ) {
        const revision = stored.revision
        stored = await runtime.withDatabase((db) =>
          writeExecutionSelection(db, runId, revision, inherited.value),
        )
        this.supersededChoices.delete(key)
      }
      if (result.admitted && result.prepared.selectedSkills === undefined) {
        const task = await runtime.withDatabase(
          (db) =>
            readAkinatorSession(db, {
              workspace: result.prepared.project.workspace,
              sessionId: result.prepared.intake.sessionId,
            }).task,
        )
        result.prepared.selectedSkills = await selectInstalledSkills(
          decisions,
          `run:${runId}`,
          task,
          [...event.capabilities.skills, ...event.capabilities.tools],
          result.prepared.capabilities,
          event.signal,
        )
      }
      if (!stored) return result
      if (
        stored.value.mode === 'pending' &&
        !explicitExecutionMode(event.task) &&
        !(['build', 'debug', 'review', 'devops'] as readonly string[]).includes(
          result.prepared.intake.profile.taskType ?? '',
        )
      ) {
        const revision = stored.revision
        await runtime.withDatabase((db) =>
          db
            .prepare(
              'DELETE FROM dsh_execution_selections WHERE run_id = ? AND revision = ?',
            )
            .run(runId, revision),
        )
        return result
      }
      setSelection(runId, stored)
      const selected = await selectExecution({
        signal: event.signal,
        stored,
        save: async (revision, value) => {
          const saved = await runtime.withDatabase((db) =>
            writeExecutionSelection(db, runId, revision, value),
          )
          setSelection(runId, saved)
          return saved
        },
      })
      setSelection(runId, selected)
      return result
    }
    override async prepare(
      event: DshPreStepEvent,
    ): Promise<DshIntakeGateResult> {
      if (
        event.requestIntent?.action === 'change' &&
        event.requestIntent.changeScope === 'unknown'
      ) {
        throw new KiokukoError(
          'CONFLICT',
          'request_intent_change_scope_unresolved',
        )
      }
      // Capture completion ordering before any asynchronous database or intake
      // work. Revision ordering alone cannot distinguish two same-revision
      // context deliveries that finish out of order.
      const generation = ++prepareGeneration
      const prior = currentForAgentEvent(
        event.agent.id,
        event.sessionId,
        undefined,
        event.nativeSession,
        event.nativeAgent,
      )
      const canonical = event.requestIntentContext?.activeTask
      // Once this exact native turn has been admitted, its execution lease is
      // the authority for generated steps. The interpretation remains evidence
      // of the original human request: admission may have retired that source
      // task and opened a new run, so its source revision must not be treated as
      // the new run's execution authority. Human input still takes the source
      // revision check below; never refresh a stale interpretation implicitly.
      const admittedStep =
        !!canonical &&
        continuesCodingScope(event) &&
        !hasHumanInput(event.nativeMessages ?? []) &&
        prior?.turn === event.turn &&
        !prior.closed &&
        !prior.failed &&
        prior.task === event.task &&
        !!prior.authority &&
        prior.requestIntent === event.requestIntent &&
        prior.requestIntentContext === event.requestIntentContext
      if (admittedStep)
        await runtime.withDatabase((database) =>
          authorizeTaskLease(database, prior.authority!),
        )
      if (canonical && continuesCodingScope(event) && !admittedStep) {
        const current = await runtime.withDatabase((database) =>
          readTaskSnapshot(database, canonical),
        )
        if (
          current.revision !== canonical.revision ||
          current.generation !== canonical.generation
        )
          throw new KiokukoError(
            'CONFLICT',
            'Task continuation revision changed',
          )
        const canonicalContinuation =
          event.requestIntent?.relation === 'same_scope_continuation' &&
          !!event.requestIntentContext &&
          !!rebindRequestIntentDecision(
            event.requestIntent,
            event.requestIntentContext,
          ) &&
          event.requestIntent.evidence.taskId === current.taskId &&
          taskCanExecute(current) &&
          prior?.runId === current.taskId &&
          !!prior.authority &&
          prior.authority.revision === current.revision &&
          prior.authority.generation === current.generation
        // An explicit resume invalidates the old in-memory preparation and memory
        // delivery, even when the native session and logical run ID are unchanged.
        // Reuse the existing resume path before advisory completion retires a
        // normal task; it also initializes any newly required coding workflow.
        const resumeCanonicalContinuation =
          canonicalContinuation &&
          prior &&
          !prior.closed &&
          !prior.failed &&
          prior.turn < event.turn &&
          !(await runtime.withDatabase((db) =>
            readCodingWorkflow(db, current.taskId),
          ))
        const previousCoding = current.runStatus === 'completed'
          ? await runtime.withDatabase(db => readCodingWorkflow(db, current.taskId))
          : undefined
        const needsNewRun = current.runStatus === 'completed' && (
          (!previousCoding && !codingWorkRequested(current.request ?? '')) ||
          (previousCoding?.state === 'completed' && event.requestIntent?.relation === 'scope_change')
        )
        if (!needsNewRun && (
          resumeCanonicalContinuation ||
          !taskCanExecute(current) ||
          (prior?.runId === current.taskId &&
            prior.authority &&
            (prior.authority.revision !== current.revision ||
              prior.authority.generation !== current.generation))
        )) {
          const refreshed = await resumeExistingRun?.(event)
          if (!refreshed)
            throw new KiokukoError(
              'CONFLICT',
              'Current task could not be resumed',
            )
          continuedTurns.delete(`${event.sessionId}\u0000${event.turn}`)
          resumedTurns.delete(`${event.sessionId}\u0000${event.turn}`)
          const selected = refreshed.admitted
            ? await this.choose(event, refreshed)
            : refreshed
          await bindAndRecord(event, selected, generation)
          return selected
        }
      }
      if (
        prior &&
        prior.turn === event.turn &&
        !prior.closed &&
        prior.task !== event.task &&
        hasHumanInput(event.nativeMessages ?? []) &&
        event.requestIntent?.relation === 'new'
      ) {
        const choice = getSelection(prior.runId)
        if (choice?.value.status === 'ready')
          this.supersededChoices.set(
            `${event.sessionId}\u0000${event.turn}`,
            choice,
          )
        await retireSupersededRun(prior, 'cancelled')
        this.supersedeTurn(event.sessionId, event.turn)
        continuedTurns.delete(`${event.sessionId}\u0000${event.turn}`)
        resumedTurns.delete(`${event.sessionId}\u0000${event.turn}`)
      }
      const reviewProject = await runtime.withDatabase((database) =>
        resolveProjectWorkspaceReadOnly(database, event.cwd, {
          allowDirectory: true,
        }),
      )
      if (reviewProject)
        await autoReview.acceptInput(
          reviewProject.workspace,
          event.sessionId,
          event.task,
        )
      const cacheKey = `${event.sessionId}\u0000${event.turn}`
      // Native inject/clarification can add human input within the same turn.
      // Retire only the superseded request cache; the source-bound intent and
      // current task lease above remain mandatory, and the run is retained.
      if (prior?.turn === event.turn && !prior.closed && !prior.failed && prior.task !== event.task
        && hasHumanInput(event.nativeMessages ?? []) && continuesCodingScope(event)
        && event.requestIntent && event.requestIntentContext?.task === event.task
        && rebindRequestIntentDecision(event.requestIntent, event.requestIntentContext)) {
        continuedTurns.delete(cacheKey)
        resumedTurns.delete(cacheKey)
      }
      const fingerprint = canonicalContentHash({
        sessionId: event.sessionId,
        agentId: event.agent.id,
        turn: event.turn,
        sourceStartSeq: event.sourceStartSeq ?? null,
        task: event.task,
        cwd: event.cwd,
        profileHints: event.profileHints ?? null,
        ...(event.deferTaskTypeInference
          ? { deferTaskTypeInference: true }
          : {}),
        evidence: event.evidence ?? null,
        requestIntent: event.requestIntent ?? null,
        requestIntentContextDigest: event.requestIntentContext
          ? canonicalContentHash(event.requestIntentContext)
          : null,
        memoryOwner: event.memoryOwner ?? null,
        skillDiscoveryMode: event.skillDiscoveryMode ?? null,
        catalogDigest: event.capabilities.digest,
      })
      const unresolvedBinding = canonicalContentHash({
        sessionId: event.sessionId,
        agentId: event.agent.id,
        turn: event.turn,
        sourceStartSeq: event.sourceStartSeq ?? null,
        task: event.task,
        cwd: event.cwd,
        evidence: event.evidence ?? null,
        context: event.requestIntentContext ?? null,
        catalogDigest: event.capabilities.digest,
        skillDiscoveryMode: event.skillDiscoveryMode ?? null,
      })
      const cached = continuedTurns.get(cacheKey) ?? resumedTurns.get(cacheKey)
      if (cached !== undefined) {
        if (
          cached.fingerprint !== fingerprint &&
          'unresolvedBinding' in cached &&
          cached.unresolvedBinding === unresolvedBinding &&
          cached.nativeAgent === event.nativeAgent &&
          cached.nativeSession === event.nativeSession &&
          event.requestIntentContext &&
          event.requestIntent &&
          continuesCodingScope(event) &&
          rebindRequestIntentDecision(
            event.requestIntent,
            event.requestIntentContext,
          )
        ) {
          // A host-owned confirmation may resume before optional interpretation.
          // Resolve that exact unresolved input once; changing resolved input still conflicts.
          const kind = memoryOwnerKind(
            event.requestIntent,
            event.profileHints?.taskType,
          )
          const prepared: PreparedAgentTask = {
            ...cached.result.prepared,
            memoryOwner: createMemoryOwner(kind, {
              agentId: event.agent.id,
              sessionId: event.sessionId,
              turn: event.turn,
              requestDigest: canonicalContentHash(event.task),
              runId: cached.result.prepared.run.runId,
            }),
          }
          const resolved = await this.choose(event, {
            ...cached.result,
            prepared,
          })
          continuedTurns.set(cacheKey, {
            fingerprint,
            result: resolved,
            ...(event.nativeAgent ? { nativeAgent: event.nativeAgent } : {}),
            ...(event.nativeSession
              ? { nativeSession: event.nativeSession }
              : {}),
          })
          await bindAndRecord(event, resolved, generation)
          return resolved
        }
        if (
          cached.fingerprint !== fingerprint ||
          cached.nativeAgent !== event.nativeAgent ||
          cached.nativeSession !== event.nativeSession
        ) {
          throw new KiokukoError(
            'CONFLICT',
            'dsh continued turn was reused with different bound input',
          )
        }
        this.assertCatalog(cached.result.catalog, event.capabilities)
        if (
          !hasHumanInput(event.nativeMessages ?? []) &&
          event.nativeMessages?.some(
            (message) =>
              objectRecord(objectRecord(message)?.source)?.form ===
              ANSWER_REVIEW_FORM,
          )
        ) {
          if (
            !event.nativeAgent ||
            !(await answerReview.accept(
              event.nativeAgent as ReviewAgent,
              event.nativeMessages,
              event.turn,
              cached.result.catalog.digest,
            ))
          )
            throw new Error('Stale answer review continuation')
        }
        return event.signal.aborted
          ? { ...cached.result, admitted: false }
          : this.choose(event, cached.result)
      }
      const previous = currentForAgentEvent(
        event.agent.id,
        event.sessionId,
        undefined,
        event.nativeSession,
        event.nativeAgent,
      )
      const reviewMessages = event.nativeMessages ?? []
      if (hasHumanInput(reviewMessages))
        answerReview.humanInput(event.sessionId, event.turn)
      if (
        !hasHumanInput(reviewMessages) &&
        reviewMessages.some(
          (message) =>
            objectRecord(objectRecord(message)?.source)?.form ===
            ANSWER_REVIEW_FORM,
        )
      ) {
        if (
          !previous ||
          !event.nativeAgent ||
          !(await answerReview.accept(
            event.nativeAgent as ReviewAgent,
            reviewMessages,
            event.turn,
            previous.catalog.digest,
          ))
        )
          throw new Error('Unbound answer review continuation')
        // Only the coordinator's exact reserved message may carry this owner
        // into another native turn; the request and run remain unchanged.
        const owner = previous.prepared.memoryOwner
        const prepared = owner
          ? {
              ...previous.prepared,
              memoryOwner: createMemoryOwner(owner.kind, {
                ...owner,
                turn: event.turn,
              }),
            }
          : previous.prepared
        const continued = {
          admitted: true,
          prepared,
          catalog: previous.catalog,
        }
        continuedTurns.set(cacheKey, {
          fingerprint,
          result: continued,
          nativeAgent: event.nativeAgent,
          ...(event.nativeSession === undefined
            ? {}
            : { nativeSession: event.nativeSession }),
        })
        await bindAndRecord(event, continued, generation)
        return continued
      }
      if (
        previous !== undefined &&
        previous.turn === event.turn &&
        !previous.closed
      ) {
        if (
          previous.task !== event.task &&
          hasHumanInput(event.nativeMessages ?? [])
        ) {
          if (!continuesCodingScope(event))
            return {
              admitted: false,
              prepared: previous.prepared,
              catalog: event.capabilities,
            }
          const workflow = await runtime.withDatabase((db) =>
            readCodingWorkflow(db, previous.runId),
          )
          const scopeChanging =
            !!workflow && event.requestIntent?.relation === 'scope_change'
          if (scopeChanging && event.requestIntent) {
            const evidenceRefs = event.requestIntentContext
              ? requestIntentReferenceIds(event.requestIntentContext)
              : []
            await runtime.withDatabase((db) =>
              markCodingScopeChange(
                db,
                {
                  runId: previous.runId,
                  sessionId: previous.sessionId,
                  repositoryRoot: previous.repositoryRoot,
                },
                `request-intent:${event.sessionId}:${event.turn}:${event.requestIntent!.evidence.requestDigest}`,
                event.requestIntent!.evidence.requestDigest,
                evidenceRefs,
              ),
            )
          }
          const ownerKind =
            event.memoryOwner ??
            memoryOwnerKind(
              event.requestIntent,
              event.profileHints?.taskType ??
                previous.prepared.intake.profile.taskType,
            )
          const prepared: PreparedAgentTask = {
            ...previous.prepared,
            ...(scopeChanging
              ? {
                  context: null,
                  memoryPolicy: {
                    memoryReasoningRequired: false,
                    contextWithheld: false,
                    withheldReason: null,
                    deliveryEmpty: true,
                  },
                }
              : {}),
            memoryOwner: createMemoryOwner(ownerKind, {
              agentId: event.agent.id,
              sessionId: event.sessionId,
              turn: event.turn,
              requestDigest: canonicalContentHash(event.task),
              runId: previous.runId,
            }),
          }
          const selected = await this.choose(event, {
            admitted: !event.signal.aborted,
            prepared,
            catalog: event.capabilities,
          })
          if (selected.admitted) {
            continuedTurns.set(cacheKey, { fingerprint, result: selected,
              ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
              ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
              ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }) })
            await bindAndRecord(event, selected, generation)
          }
          return selected
        }
        if (admittedStep) {
          this.assertCatalog(prior.catalog, event.capabilities)
          return { admitted: !event.signal.aborted, prepared: prior.prepared, catalog: prior.catalog }
        }
        // Model routing prepares before native pre-step. Reuse that exact
        // intake result instead of treating its newly active run as a cold
        // resume (which deliberately starts without historical context).
        const prepared = await super.prepare(event)
        if (prepared.prepared.run.runId !== previous.runId)
          throw new KiokukoError(
            'CONFLICT',
            'The prepared native turn changed run identity',
          )
        const selected = await this.choose(event, prepared)
        if (selected.admitted) await bindAndRecord(event, selected, generation)
        return selected
      }
      if (previous !== undefined && previous.turn < event.turn) {
        if (event.signal.aborted)
          return {
            admitted: false,
            prepared: previous.prepared,
            catalog: event.capabilities,
          }
        const previousWasChat =
          previous.prepared.intake.profile.taskType === "chat"
        const selection = getSelection(previous.runId)?.value
        const coding = await runtime.withDatabase((db) =>
          readCodingWorkflow(db, previous.runId),
        )
        // Child results and other generated turns continue the admitted Goal.
        // Only a new human request can replace it without an explicit continuation.
        const resumeCoding =
          coding &&
          !["completed", "cancelled", "superseded"].includes(coding.state) &&
          (!hasHumanInput(event.nativeMessages ?? []) ||
            continuesCodingScope(event))
        // Durable ledger state owns run liveness; an in-memory active record
        // cannot resurrect a failed, cancelled or missing run.
        const durableStatus = await runtime.withDatabase(
          (db) => new LedgerStore(db).readRun(previous.runId)?.status,
        )
        const durableOpen =
          durableStatus === "intake" || durableStatus === "active"
        const continuePrevious =
          (resumeCoding && durableOpen) ||
          (selection &&
            (selection.status !== "ready" ||
              (selection.mode === "normal" && previous.failed)))
            ? true
            : previousWasChat
              ? event.profileHints?.taskType === "chat"
              : event.requestIntent?.relation !== 'new' &&
                (!coding || !['completed', 'cancelled', 'superseded'].includes(coding.state)) &&
                durableOpen &&
                !previous.failed &&
                previous.prepared.run.status === "active" &&
                (event.profileHints?.taskType ??
                  previous.prepared.intake.profile.taskType) ===
                  previous.prepared.intake.profile.taskType
        if (continuePrevious) {
          this.assertCatalog(previous.catalog, event.capabilities)
          const intent = event.requestIntent
          const scopeChanging =
            !!coding &&
            intent?.relation === 'scope_change' &&
            intent.action !== 'answer' &&
            intent.action !== 'unknown'
          if (scopeChanging && intent) {
            const evidenceRefs = event.requestIntentContext
              ? requestIntentReferenceIds(event.requestIntentContext)
              : []
            await runtime.withDatabase((db) =>
              markCodingScopeChange(
                db,
                {
                  runId: previous.runId,
                  sessionId: previous.sessionId,
                  repositoryRoot: previous.repositoryRoot,
                },
                `request-intent:${event.sessionId}:${event.turn}:${intent.evidence.requestDigest}`,
                intent.evidence.requestDigest,
                evidenceRefs,
              ),
            )
          }
          const continuedMemory: Pick<
            PreparedAgentTask,
            'context' | 'memoryPolicy'
          > = {
            context: null,
            memoryPolicy: {
              memoryReasoningRequired: false,
              contextWithheld: false,
              withheldReason: null,
              deliveryEmpty: true,
            },
          }
          const ownerKind =
            event.memoryOwner ??
            memoryOwnerKind(
              intent,
              event.profileHints?.taskType ??
                previous.prepared.intake.profile.taskType,
            )
          const continuedPrepared: PreparedAgentTask = {
            ...previous.prepared,
            ...(continuedMemory ?? {}),
            memoryOwner: createMemoryOwner(ownerKind, {
              agentId: event.agent.id,
              sessionId: event.sessionId,
              turn: event.turn,
              requestDigest: canonicalContentHash(event.task),
              runId: previous.runId,
            }),
          }
          const continued = await this.choose(event, {
            admitted: !event.signal.aborted,
            prepared: continuedPrepared,
            catalog: event.capabilities,
          })
          if (continued.admitted) {
            continuedTurns.set(cacheKey, {
              fingerprint,
              ...(event.requestIntent?.relation === 'unknown' ||
              event.requestIntent?.action === 'unknown'
                ? { unresolvedBinding }
                : {}),
              result: continued,
              ...(event.profileHints === undefined
                ? {}
                : { profileHints: event.profileHints }),
              ...(event.nativeAgent === undefined
                ? {}
                : { nativeAgent: event.nativeAgent }),
              ...(event.nativeSession === undefined
                ? {}
                : { nativeSession: event.nativeSession }),
            })
            await bindAndRecord(event, continued, generation)
          }
          return continued
        }
        if (event.signal.aborted)
          return {
            admitted: false,
            prepared: previous.prepared,
            catalog: event.capabilities,
          }
        // The durable ledger status owns the retire outcome: a directly
        // failed/cancelled run must close with its recorded status (idempotent
        // close), never as 'completed' (which would fake verified completion
        // or collide with the immutable close-status ledger guard).
        const priorLedgerStatus = await runtime.withDatabase(
          (db) => new LedgerStore(db).readRun(previous.runId)?.status,
        )
        const priorStatus =
          priorLedgerStatus === 'failed' || priorLedgerStatus === 'cancelled'
            ? priorLedgerStatus
            : 'completed'
        await retireSupersededRun(previous, priorStatus)
        this.supersedeTurn(event.sessionId, event.turn)
      }
      const resumed = await resumeExistingRun?.(event)
      if (resumed !== undefined) {
        resumedTurns.set(cacheKey, {
          fingerprint,
          result: resumed,
          ...(event.profileHints === undefined
            ? {}
            : { profileHints: event.profileHints }),
          ...(event.nativeAgent === undefined
            ? {}
            : { nativeAgent: event.nativeAgent }),
          ...(event.nativeSession === undefined
            ? {}
            : { nativeSession: event.nativeSession }),
        })
        await bindAndRecord(event, resumed, generation)
        const selected = await this.choose(event, resumed)
        await bindAndRecord(event, selected, ++prepareGeneration)
        return selected
      }
      const prepared = await super.prepare(event)
      if (!prepared.admitted) return prepared
      await bindAndRecord(event, prepared, generation)
      const selected = await this.choose(event, prepared)
      await bindAndRecord(event, selected, ++prepareGeneration)
      return selected
    }
    private async acceptHumanInput(event: DshPreStepEvent): Promise<void> {
      answerReview.humanInput(event.sessionId, event.turn)
      cancelBoundarySession(event.sessionId)
      const previous = currentSession(event.sessionId)
      const state =
        previous === undefined
          ? undefined
          : turnState.policyState(previous.runId)
      if (previous !== undefined) {
        try {
          await runtime.withDatabase((database) =>
            withImmediateTransaction(database, () => {
              if (state !== undefined) {
                const timestamp = now?.() ?? new Date().toISOString()
                supersedeOutboxAtOrBeforeRevisionInTransaction(
                  database,
                  event.sessionId,
                  state.revision,
                  timestamp,
                )
                supersedeBoundaryJobsAtOrBeforeRevisionInTransaction(
                  database,
                  event.sessionId,
                  state.revision,
                  timestamp,
                )
              }
              resetLoopGuardForUserInTransaction(database, {
                runId: previous.runId,
                dshSessionId: event.sessionId,
                resolution: 'manual_user',
                ...(now === undefined ? {} : { now: now() }),
              })
            }),
          )
        } catch {
          // Human input remains authoritative in the current native batch;
          // stale durable outbox cleanup will be retried on a later kick.
        }
      }
    }
    private async refreshExecutionInput(
      event: DshPreStepEvent,
      messages: readonly unknown[],
      human: boolean,
    ): Promise<void> {
      const item = currentSession(event.sessionId)
      if (!item) return
      const task = human
        ? textFromMessages(messages.filter(isHumanMessage), event.task)
        : undefined
      if (task !== undefined) item.memoryInput = task
      await executionSupport.refresh(
        {
          ...executionBinding(item),
          ...(task === undefined
            ? {}
            : {
                task,
                humanInput: canonicalContentHash({
                  turn: event.turn,
                  messages: messages.filter(isHumanMessage),
                }),
              }),
        },
        human,
      )
    }
    /** The public preparation tool uses the same human boundary as native pre-step. */
    async prepareRequestedWork(
      event: DshPreStepEvent,
    ): Promise<DshIntakeGateResult> {
      const messages = event.nativeMessages ?? []
      if (!hasHumanInput(messages))
        throw new Error('Original human input is required for work preparation')
      await this.acceptHumanInput(event)
      const result = await this.prepare(event)
      if (result.admitted)
        await this.refreshExecutionInput(event, messages, true)
      return result
    }
    override async preStep(
      event: DshPreStepEvent,
      next: () => Promise<DshPreStepDecision>,
    ): Promise<DshPreStepDecision> {
      if (event.nativeAgent && deepPlanning.executor.isChild(event.nativeAgent))
        return next()
      // The native chain owns admission and the original message ordering.
      // Run it before any Kiokuko storage or classification work so an
      // auxiliary database failure cannot delay or rewrite its decision.
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      const pendingSelection = (decision: typeof downstream) => ({
        ...decision,
        messages: [...decision.messages, { role: 'user' as const,
          content: [{ type: 'text' as const, text: 'Execution selection is pending. Continue permitted independent reading and planning. Keep the current route and permissions until the user selects how to execute.' }],
          source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'instructions' } }],
      })
      if (event.nativeAgent && isSelectionBlocked(event.nativeAgent))
        return pendingSelection(downstream)
      const nativeMessages = Object.freeze([...(event.nativeMessages ?? [])])
      await captureInitialInput(event.sessionId, event.turn, nativeMessages)
      const humanPresent =
        nativeMessages.some(isHumanMessage) ||
        downstream.messages.some(isHumanMessage)
      const verification = nativeMessages.find(isVerificationContinuation)
      if (verification && !humanPresent) {
        const item = currentSession(event.sessionId)
        if (!item?.authority || item.closed || item.nativeAgent !== event.nativeAgent ||
          item.nativeSession !== event.nativeSession ||
          (item.turn !== event.turn - 1 && item.turn !== event.turn) ||
          !acceptsVerificationContinuation(verification, item.authority, event.turn))
          return { kind: 'reject' }
      }
      const seenContinuations = new Set<string>()
      let nativeDecision: DshPreStepDecision = {
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
        await this.acceptHumanInput(event)
        nativeDecision = {
          ...nativeDecision,
          messages: nativeDecision.messages.filter(
            (message) =>
              objectRecord(objectRecord(message)?.source)?.form !==
              ANSWER_REVIEW_FORM,
          ),
        }
      }
      try {
        const result = await this.prepare(event)
        if (!result.admitted) return nativeDecision
        const item = currentSession(event.sessionId)
        if (item !== undefined) {
          if (
            getSelection(item.runId)?.value.status === 'ready' ||
            getSelection(item.runId)?.value.discussion
          ) {
            const original = await runtime.withDatabase((db) =>
              unexecutedRunInput(db, item.runId, item.sessionId),
            )
            const deliveredIds = new Set(
              sessionEventSource(event.nativeSession)
                .snapshotEvents()
                .filter((e) => e.type === 'user/message')
                .map((e) => objectRecord(e.data)?.id),
            )
            const currentIds = new Set(
              nativeDecision.messages.map((m) => objectRecord(m)?.id),
            )
            const missing = original.filter((m) => {
              const id = objectRecord(m)?.id
              return (
                typeof id === 'string' &&
                !deliveredIds.has(id) &&
                !currentIds.has(id)
              )
            })
            if (missing.length)
              nativeDecision = {
                ...nativeDecision,
                messages: [...missing, ...nativeDecision.messages],
              }
          }
          const humanMessages = [
            ...new Map(
              [...nativeMessages, ...nativeDecision.messages]
                .filter(isHumanMessage)
                .map((message) => [
                  objectRecord(message)?.id ?? canonicalContentHash(message),
                  message,
                ]),
            ).values(),
          ]
          await this.refreshExecutionInput(event, humanMessages, humanPresent)
          // Only an empty, automatic step can be deliberately paused. Human,
          // attachment and other pending inputs must never be consumed here.
          if (
            !humanPresent &&
            event.nativeMessages?.length === 0 &&
            nativeDecision.messages.every((message) => {
              const source = objectRecord(objectRecord(message)?.source)
              return (
                (source?.kind === 'runtime-context' ||
                  (source?.kind === 'plugin' &&
                    source.plugin === '@deepseek-ai/dsh-system-prompt')) &&
                source.form === 'snapshot'
              )
            })
          ) {
            const paused = await executionSupport.pauseAtBoundary(
              event.sessionId,
              async (id, text) => {
                const session = event.nativeSession as
                  { snapshotEvents?: () => readonly DshLogEvent[] } | undefined
                if (!session?.snapshotEvents || !sessions?.flush)
                  throw new Error('Pause notice delivery unavailable')
                await runtime.withDatabase((db) =>
                  saveSessionNotice(db, {
                    id,
                    runId: item.runId,
                    sessionId: item.sessionId,
                    rootPath: item.cwd,
                    kind: 'status',
                    text,
                    anchorSeq: session.snapshotEvents!().at(-1)?.seq ?? 0,
                  }),
                )
                await sessions.flush(session)
                event.signal.throwIfAborted()
                // A human can arrive while the native log flush is in flight.
                const inbox = (event.nativeAgent as any)?.inbox
                if (
                  [...(inbox?.nextStep ?? []), ...(inbox?.nextTurn ?? [])].some(
                    isHumanMessage,
                  )
                ) {
                  throw new Error(
                    'Human input takes priority over exploration pause',
                  )
                }
              },
            )
            if (paused) return { kind: 'reject' }
          }
        }
        const messages = await contextMessages(event, nativeDecision.messages)
        return {
          ...nativeDecision,
          messages: [
            ...executionSupport.projectMessages(
              event.sessionId,
              nativeDecision.messages,
            ),
            ...messages,
          ],
        }
      } catch (error) {
        if (error instanceof ExecutionSelectionPending) {
          if (event.nativeAgent) markSelectionPending(event.nativeAgent)
          return pendingSelection(nativeDecision)
        }
        if (
          !humanPresent &&
          nativeMessages.some(
            (message) =>
              objectRecord(objectRecord(message)?.source)?.form ===
              ANSWER_REVIEW_FORM,
          )
        )
          return { kind: 'reject' }
        // The native message array is authoritative. Kiokuko degradation must
        // not turn a claimed user prompt into a rejected/empty DSH step.
        return nativeDecision
      }
    }
    override clearTurn(sessionId: string, turn: number): void {
      super.clearTurn(sessionId, turn)
      this.supersededChoices.delete(`${sessionId}\u0000${turn}`)
      continuedTurns.delete(`${sessionId}\u0000${turn}`)
      resumedTurns.delete(`${sessionId}\u0000${turn}`)
    }
  }

  const gate = new CapturingGate(
    runtime,
    userQuestions === undefined
      ? undefined
      : createDshIntakeAnswerer(userQuestions),
    (context) => capabilityCatalog(skills, tools, context),
    true,
    akinatorMemoryConfig,
    decisions,
    completionMode,
    memoryRetrievalConfig,
    llm,
  )
  const refreshMemoryOwner = async (
    item: TurnRecord,
    signal: AbortSignal,
  ): Promise<void> => {
    const nativeSession = item.nativeSession, prepared = item.prepared
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (currentSession(item.sessionId) !== item || item.closed || item.nativeSession !== nativeSession
        || (item.nativeAgent as { session?: object } | undefined)?.session !== nativeSession || item.prepared !== prepared)
        throw new KiokukoError('CONFLICT', 'memory_owner_changed')
    }
    assertCurrent()
    const selected = await runtime.withDatabase(async db => {
      if (item.authority) authorizeTaskLease(db, item.authority)
      const timeConstraint = memoryRetrievalConfig.mode === 'off' ? undefined : timeConstraintForRequest(item.task, memoryRetrievalConfig, Date.now())
      const selected = await readTaskCorrections(db, { project: prepared.project, runId: item.runId, task: item.task,
        profile: prepared.intake.profile, signal, decisions,
        runtime: { memoryRetrieval: memoryRetrievalConfig, ...(timeConstraint ? { timeConstraint } : {}) } })
      assertCurrent()
      if (item.authority) authorizeTaskLease(db, item.authority)
      return selected
    })
    assertCurrent()
    const { deliveryEmpty: _previousEmpty, ...policy } = prepared.memoryPolicy
    item.prepared = {
      ...item.prepared,
      ...selected,
      memoryPolicy: {
        ...policy,
        memoryReasoningRequired: selected.context !== null,
        ...(selected.context === null ? { deliveryEmpty: true as const } : {}),
      },
    }
  }

  resumeExistingRun = async (event): Promise<DshIntakeGateResult | undefined> =>
    runtime.withDatabase(async (database) => {
      const project = await resolveProjectWorkspaceReadOnly(
        database,
        event.cwd,
        { allowDirectory: true },
      )
      if (project === undefined) return undefined
      const human = hasHumanInput(event.nativeMessages ?? [])
      const context = event.requestIntentContext
      let task = findSessionTask(database, {
        sessionId: event.sessionId,
        repositoryRoot: project.repositoryRoot,
      }, { includeLatestTerminal: human && continuesCodingScope(event) && context?.activeTask?.runStatus === 'completed' })
      if (!task) return undefined
      if (human) {
        if (
          !event.requestIntent ||
          !context ||
          !rebindRequestIntentDecision(event.requestIntent, context)
        )
          throw new KiokukoError(
            'CONFLICT',
            'A source-bound interpretation is required for the current task',
          )
        if (event.requestIntent.relation === 'new') return undefined
        if (
          !continuesCodingScope(event) ||
          context.activeTask?.taskId !== task.taskId ||
          context.activeTask.revision !== task.revision ||
          context.activeTask.generation !== task.generation
        )
          throw new KiokukoError(
            'CONFLICT',
            'The current task continuation is unresolved or stale',
          )
      }
      const runId = task.taskId
      const run = new LedgerStore(database).readRun(runId)!
      const selection = readExecutionSelection(database, runId)?.value
      if (selection?.mode === 'deep-thinker')
        throw new KiokukoError(
          'CONFLICT',
          'Deep Thinker recovery requires its own execution lane',
        )
      const executionMode: 'normal' = 'normal'
      const owner = readExecutionOwner(database, event.sessionId)
      if (
        owner &&
        (owner.run_id !== runId ||
          owner.workspace !== project.workspace ||
          owner.mode !== executionMode)
      )
        throw new KiokukoError('CONFLICT', 'Task execution owner changed')
      const capabilityEntries = [
        ...event.capabilities.skills,
        ...event.capabilities.tools,
      ]
      if (task.runStatus === 'completed' && human && context) {
        const coding = readCodingWorkflow(database, runId)
        if ((coding ? ['cancelled', 'superseded'].includes(coding.state) : !codingWorkRequested(task.request ?? '')) ||
          (coding?.state === 'completed' && event.requestIntent?.relation === 'scope_change')) return undefined
        assertCapabilityCatalogBinding(run.metadata, capabilityEntries)
        gate.assertCatalog(event.capabilities, await capabilityCatalog(skills, tools, {
          agent: event.agent, ...(event.nativeAgent ? { nativeAgent: event.nativeAgent } : {}),
          cwd: event.cwd, signal: event.signal,
        }))
        event.signal.throwIfAborted()
        const previousTask = task
        const refs = requestIntentReferenceIds(context)
        task = withImmediateTransaction(database, () => {
          const resumed = resumeCompletedCodingTurn(database, previousTask,
            dshTurnRequestId({ dshSessionId: event.sessionId, turn: event.turn }), refs)
          if (coding && taskCanExecute(resumed) && event.requestIntent?.relation === 'scope_change') markCodingScopeChange(database, coding,
            `request-intent:${event.sessionId}:${event.turn}:${event.requestIntent.evidence.requestDigest}`,
            event.requestIntent.evidence.requestDigest, refs)
          return resumed
        })
      }
      const { state: intakeState, link: intakeLink } = await continueTaskIntake(
        database,
        {
          ...task,
          workspace: project.workspace,
          expectedRevision: task.revision,
          expectedGeneration: task.generation,
          capabilities: capabilityEntries,
          signal: event.signal,
          decisions, llm, requestId: dshTurnRequestId({ dshSessionId: event.sessionId, turn: event.turn }),
          requestIntent: event.requestIntent, evidence: [event.task],
          answerer: userQuestions
            ? createDshIntakeAnswerer(userQuestions)
            : undefined,
          agent: event.nativeAgent as { id: string } | undefined,
          validateCapabilities: async () =>
            gate.assertCatalog(
              event.capabilities,
              await capabilityCatalog(skills, tools, {
                agent: event.agent,
                ...(event.nativeAgent
                  ? { nativeAgent: event.nativeAgent }
                  : {}),
                cwd: event.cwd,
                signal: event.signal,
              }),
            ),
        },
      )
      const intake = intakeState.session
      const capabilityResolution = resolveCapabilities({
        task: intake.task,
        profile: intake.profile,
        recommendedTags: intakeLink.recommendedTags,
        capabilities: capabilityEntries,
        memoryUse: 'none',
      })
      const canonicalCwd = realpathSync(event.cwd)
      const admitted =
        !event.signal.aborted &&
        intakeState.status !== 'needs_answer' &&
        taskCanExecute(readTaskSnapshot(database, task)) &&
        !hasBlockingRequiredCapability(capabilityResolution)
      const runStatus = new LedgerStore(database).readRun(runId)!.status
      if (runStatus !== 'active' && runStatus !== 'intake')
        throw new KiokukoError('CONFLICT', 'Task requires an explicit resume')
      if (admitted) {
        if (!owner)
          claimExecutionOwner(database, {
            sessionId: event.sessionId,
            workspace: project.workspace,
            mode: executionMode,
            startId:
              typeof run.metadata.requestId === 'string'
                ? run.metadata.requestId
                : `run:${runId}`,
            runId,
          })
        initializeTaskCompletion(database, runId, completionMode, event.requestIntent)
        if (
          executionMode === 'normal' &&
          !readCodingWorkflow(database, runId) &&
          codingWorkRequested(
            intake.task,
            event.requestIntent,
            intake.profile.taskType,
          )
        )
          initializeCodingWorkflow(database, {
            runId,
            sessionId: event.sessionId,
            repositoryRoot: project.repositoryRoot,
            requestId:
              typeof run.metadata.requestId === 'string'
                ? run.metadata.requestId
                : `run:${runId}`,
            task: intake.task,
          }, { optional: true })
      }
      const prepared: PreparedAgentTask = {
        memoryOwner: createMemoryOwner(
          event.memoryOwner ??
            memoryOwnerKind(event.requestIntent, intake.profile.taskType),
          {
            agentId: event.agent.id,
            sessionId: event.sessionId,
            turn: event.turn,
            requestDigest: canonicalContentHash(event.task),
            runId,
          },
        ),
        project,
        executionContext: {
          canonicalCwd,
          repositoryRoot: project.repositoryRoot,
          cwdIsRepositoryRoot: canonicalCwd === project.repositoryRoot,
          pathPolicy: 'canonical_absolute_under_repository_root',
        },
        intake: {
          status: intakeState.status,
          sessionId: intake.id,
          profile: intake.profile,
          question: intakeState.question,
          missingFields: intakeState.missingFields,
          recommendedTags: intakeLink.recommendedTags,
          reasoning: deriveAkinatorReasoning(intake.task, intake.profile),
        },
        capabilities: capabilityResolution,
        run: { runId, status: runStatus },
        skillDiscovery: {
          attempted: false,
          mode: 'off',
          requirements: [],
          queries: [],
          cacheHits: 0,
          candidates: 0,
          selected: [],
          failures: [],
        },
        context: null,
        memoryPolicy: {
          memoryReasoningRequired: false,
          contextWithheld: false,
          withheldReason: null,
          deliveryEmpty: true,
        },
        warnings: capabilityResolution.warnings,
        nextAction: admitted
          ? 'proceed'
          : hasBlockingRequiredCapability(capabilityResolution)
            ? 'required_capability_unavailable'
            : 'answer_from_evidence_or_ask_user',
        securityNotice:
          'This resumed DSH run uses only current repository evidence and the current host capability catalog; previously delivered ordinary memory is not replayed implicitly.',
      }
      return { admitted, prepared, catalog: event.capabilities }
    })
  const requestIntentContextFor = async (
    input: DshNativePreStepPayload,
    sessionId: string,
    nativeSession: object | undefined,
    previous: TurnRecord | undefined,
    task: string,
  ): Promise<RequestIntentContext | undefined> => {
    const human = input.messages.filter(isHumanMessage)
    if (!human.length || !task.trim()) return undefined
    const sessionHeader = objectRecord(objectRecord(nativeSession)?.header)
    const cwd =
      typeof sessionHeader?.cwd === 'string' ? sessionHeader.cwd : undefined
    if (!cwd) return undefined
    if (previous && previous.turn < input.turn && !previous.closed &&
      (codingWorkRequested(previous.task, previous.requestIntent) ||
        await runtime.withDatabase(db => Boolean(readCodingWorkflow(db, previous.runId))))) {
      const close = await resolveIdleClose(previous.agentId, sessionId, nativeSession, input.agent)
      if (close?.status === 'completed' && close.runId === previous.runId)
        await retireSupersededRun(previous, 'completed')
    }
    const messageRefs = requestIntentMessageRefs(human, task)
    const activeTask = await runtime.withDatabase(async (database) => {
      const project = await resolveProjectWorkspaceReadOnly(database, cwd, {
        allowDirectory: true,
      })
      const task = project
        ? findSessionTask(database, {
            sessionId,
            repositoryRoot: project.repositoryRoot,
          }, { includeLatestTerminal: true })
        : undefined
      return task?.pendingStop || task && ['active', 'intake', 'completed'].includes(task.runStatus)
        ? task : undefined
    })
    let activeGoal: RequestIntentContext['activeGoal']
    let proposals: NonNullable<RequestIntentContext['proposals']> = []
    const sameOwner =
      previous &&
      previous.sessionId === sessionId &&
      previous.nativeAgent === input.agent &&
      previous.nativeSession === nativeSession
    const persistedRun = sameOwner
      ? undefined
      : await runtime.withDatabase(async (database) => {
          const project = await resolveProjectWorkspaceReadOnly(database, cwd, {
            allowDirectory: true,
          })
          if (!project) return undefined
          const candidates = database
            .prepare(
              `SELECT lr.run_id AS runId
        FROM ledger_runs AS lr
        LEFT JOIN dsh_coding_workflows AS cw ON cw.run_id = lr.run_id
        WHERE lr.workspace = ? AND COALESCE(lr.task_owner_session_id, lr.dsh_session_id) = ? AND lr.status = 'active'
          AND lr.task_state NOT IN ('Done', 'Ignore')
          AND ((json_extract(cw.snapshot_json, '$.repositoryRoot') = ?
              AND json_extract(cw.snapshot_json, '$.sessionId') = ?
              AND json_extract(cw.snapshot_json, '$.state') NOT IN ('completed', 'cancelled', 'superseded')))
        ORDER BY lr.created_at, lr.run_id LIMIT 2`,
            )
            .all<{ runId: string }>(
              project.workspace,
              sessionId,
              project.repositoryRoot,
              sessionId,
            )
          if (candidates.length > 1)
            throw new KiokukoError(
              'CONFLICT',
              'Multiple active tasks match this session; refusing to guess',
            )
          return candidates[0] === undefined
            ? undefined
            : { ...candidates[0], workspace: project.workspace }
        })
    const runId = activeTask?.runId ?? (sameOwner ? previous.runId : persistedRun?.runId)
    if (runId) {
      const state = await runtime.withDatabase((database) => {
        const workflow = readCodingWorkflow(database, runId)
        const openWorkflow = workflow && !['completed', 'cancelled', 'superseded'].includes(workflow.state) ? workflow : undefined
        const definition = openWorkflow?.definition
        const frame = readExecutionFrame(database, runId)
        const active: RequestIntentContext['activeGoal'] = definition
          ? {
              runId,
              workflowRevision: workflow!.revision,
              goalId: definition.goal.goalId,
              goalRevision: definition.goal.revision,
              scopeRevision: workflow!.scopeVersion,
              ideal: definition.goal.ideal,
              target: definition.goal.target,
              outOfScope: [...definition.goal.outOfScope],
              constraints: [...definition.goal.constraints],
            }
          : openWorkflow
            ? {
                runId,
                workflowRevision: openWorkflow.revision,
                scopeRevision: openWorkflow.scopeVersion,
                outOfScope: [],
                constraints: [],
              }
            : undefined
        const candidates = (frame?.conditions ?? [])
          .filter((condition) => condition.approval === 'proposed')
          .slice(0, 7)
          .map((condition) => ({
            id: `condition-${canonicalContentHash([runId, frame!.revision, condition.field, condition.text, condition.planRevision])}`,
            revision: condition.planRevision ?? frame!.revision,
            digest: canonicalContentHash(condition),
            text: `${condition.field}: ${condition.text}`,
            field: condition.field,
          }))
        return { active, candidates }
      })
      activeGoal = state.active
      proposals = state.candidates
    }
    const eventSource = sessionEventSource(nativeSession)
    proposals = [
      ...proposals,
      ...nativeRequestProposals(
        eventSource.snapshotEvents(),
        input.turn,
        sessionId,
      ),
    ].slice(0, 8)
    return createRequestIntentContext({
      task,
      workspaceDirectory: realpathSync(cwd),
      messageRefs,
      ...(activeGoal ? { activeGoal } : {}),
      ...(activeTask ? { activeTask } : {}),
      proposals: proposals.slice(0, 8),
    })
  }

  const mapPreStep = async (
    payload: DshNativePreStepPayload,
    advisoryType?: TaskType,
    suppliedIntent?: RequestIntentDecision,
    interpretationOnly = false,
  ): Promise<DshPreStepEvent> => {
    const nativeSession = payload.agent.session
    const registered =
      nativeSession === undefined && payload.agent.sessionId === undefined
        ? sessions?.get(payload.agent.id)
        : undefined
    const sessionId =
      nativeSession?.id ?? payload.agent.sessionId ?? registered?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      throw new Error(
        'kiokuko-dsh native agent session identity is unavailable',
      )
    const registeredSession =
      nativeSession === undefined ? sessions?.get(sessionId) : undefined
    const boundSession = nativeSession ?? registeredSession ?? registered
    if (boundSession !== undefined && boundSession.id !== sessionId)
      throw new Error('kiokuko-dsh native session identity is inconsistent')
    const cwd = boundSession?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0)
      throw new Error('kiokuko-dsh native session cwd is unavailable')
    if (
      !currentSession(sessionId) &&
      boundSession &&
      !deepPlanning.executor.isChild(payload.agent as never)
    )
      await answerReview.recover(payload.agent as ReviewAgent, async (row) => {
        await sessions?.flush?.(boundSession)
        await sessionMirror.checkpointAfterNativeFlush(
          boundSession as DshMirrorEventSession,
        )
        await closeTurn({
          runId: row.runId,
          status: row.status,
          ...(row.endSeq === undefined ? {} : { sourceEndSeq: row.endSeq }),
        })
      })
    const sourceStartSeq = dshTurnBoundarySeq(
      sessionEventSource(boundSession as object | undefined),
      payload.turn,
      'start',
    )
    const bound = currentForAgentEvent(
      payload.agent.id,
      sessionId,
      payload.turn,
      boundSession as object | undefined,
      payload.agent as object,
    )
    const previous =
      bound === undefined
        ? currentForAgentEvent(
            payload.agent.id,
            sessionId,
            undefined,
            boundSession as object | undefined,
            payload.agent as object,
          )
        : undefined
    // DSH supplies only the messages claimed for this particular step. After
    // the first step that batch may contain steering/injected context rather
    // than the original user task, so the established logical-turn record is
    // the authoritative task projection.
    // After a turn was deliberately paused, DSH may consume the next-turn
    // inbox item before pre-step and expose an empty step-local message batch.
    // The durable resumed run is still authoritative, so fall back to its last
    // human task. The native conversation retains the new user message for the
    // model, while any supplied step-local user text still replaces this
    // fallback and is recorded as the continuation instruction.
    const reviewing =
      !hasHumanInput(payload.messages) &&
      payload.messages.some(
        (message) =>
          objectRecord(objectRecord(message)?.source)?.form ===
          ANSWER_REVIEW_FORM,
      )
    const intentTask = hasHumanInput(payload.messages)
      ? textFromMessages(payload.messages.filter(isHumanMessage), '')
      : ''
    const task = intentTask.trim()
      ? intentTask
      : (bound?.task ??
        (reviewing && previous
          ? previous.task
          : textFromMessages(payload.messages, previous?.task)))
    let profile = (() => {
      if (bound !== undefined) return bound.profileHints
      if (advisoryType) return { taskType: advisoryType }
      if (reviewing && previous) return previous.profileHints
      if (previous === undefined) return undefined
      const inferred = resolveGroundedIntakeProfile({ task, cwd }).profileHints
        .taskType
      const previousType = getSelection(previous.runId)?.value.discussion
        ? 'chat'
        : previous.prepared.intake.profile.taskType
      return inferred === null ||
        (previousType === 'chat' && inferred === 'chat')
        ? { taskType: previousType }
        : undefined
    })()
    let deferTaskTypeInference =
      bound?.deferTaskTypeInference ??
      (reviewing ? previous?.deferTaskTypeInference : false) ??
      false
    let requestIntentContext: RequestIntentContext | undefined
    let requestIntent: RequestIntentDecision | undefined
    const activeRecord = bound ?? previous
    if (
      !reviewing &&
      hasHumanInput(payload.messages) &&
      !deepPlanning.executor.isChild(payload.agent as never) &&
      intentTask.trim()
    ) {
      requestIntentContext = await requestIntentContextFor(
        payload,
        sessionId,
        boundSession as object | undefined,
        activeRecord,
        intentTask,
      )
      const requestId = dshTurnRequestId({
        dshSessionId: sessionId,
        turn: payload.turn,
      })
      const establishedConversation =
        profile?.taskType === 'chat' &&
        !requestIntentContext?.activeGoal &&
        (!requestIntentContext?.activeTask ||
          requestIntentContext.activeTask.type === 'chat')
      if (requestIntentContext && !establishedConversation) {
        requestIntent = await classifyRequestIntent(
          decisions,
          requestId,
          requestIntentContext,
          payload.signal,
        )
      }
      const configuration = await decisions?.bind(requestId, payload.signal)
      // This profile is inherited from a previous turn, not a current user choice.
      // Let Laya assess new work, but retain the user's chat choice for an
      // ambiguous continuation instead of asking the same classification again.
      const explicit =
        advisoryType ??
        (configuration?.provider === 'laya-coreml' &&
        profile?.taskType !== 'chat'
          ? undefined
          : profile?.taskType)
      const classification = await classifyTaskForIntake(
        decisions,
        requestId,
        intentTask,
        explicit,
        payload.signal,
      )
      deferTaskTypeInference = classification.deferInference
      if (classification.taskType)
        profile = { ...profile, taskType: classification.taskType }
      else if (deferTaskTypeInference && profile)
        profile = { ...profile, taskType: null }
    } else if (activeRecord) {
      requestIntent = activeRecord.requestIntent
      requestIntentContext = activeRecord.requestIntentContext
    }
    if (suppliedIntent) {
      if (!requestIntentContext)
        throw new KiokukoError('CONFLICT', 'request_intent_context_unavailable')
      const rebound = rebindRequestIntentDecision(
        suppliedIntent,
        requestIntentContext,
      )
      if (!rebound)
        throw new KiokukoError('CONFLICT', 'request_intent_evidence_stale')
      if (
        requestIntent?.source === 'decision-provider' &&
        requestIntent.relation !== 'unknown' &&
        requestIntent.action !== 'unknown' &&
        (requestIntent.relation !== rebound.relation ||
          requestIntent.action !== rebound.action)
      ) {
        throw new KiokukoError('CONFLICT', 'request_intent_provider_conflict')
      }
      requestIntent =
        requestIntent?.source === 'decision-provider' &&
        requestIntent.relation !== 'unknown' &&
        requestIntent.action !== 'unknown'
          ? { ...requestIntent, evidence: rebound.evidence }
          : rebound
    }
    if (requestIntentContext?.activeTask && hasHumanInput(payload.messages)) {
      const identity = requestIntentContext.activeTask
      const contextDigest = canonicalContentHash(requestIntentContext)
      const requestId = dshTurnRequestId({
        dshSessionId: sessionId,
        turn: payload.turn,
      })
      await runtime.withDatabase((db) => {
        if (requestIntentIsUnresolved(requestIntent))
          return recordTaskUnresolved(db, identity, {
            operationId: `intent:${canonicalContentHash([requestId, contextDigest, requestIntent?.unresolvedReason ?? 'request_intent_unresolved'])}`,
            expectedRevision: identity.revision,
            requestId,
            contextDigest,
            reason:
              requestIntent?.unresolvedReason ?? 'request_intent_unresolved',
            evidence: requestIntentReferenceIds(requestIntentContext!),
          })
        const current = readTaskSnapshot(db, identity)
        return current.unresolved?.requestId === requestId &&
          current.unresolved.contextDigest === contextDigest
          ? clearTaskUnresolved(db, identity, {
              requestId,
              contextDigest,
              expectedRevision: identity.revision,
            })
          : undefined
      })
    }
    const pendingDiscussion =
      isContinuationReference(intentTask) &&
      (await hasPendingExecutionDiscussion(sessionId, cwd))
    const establishedConversation =
      profile?.taskType === 'chat' &&
      !requestIntentContext?.activeGoal &&
      !requestIntentContext?.activeTask
    if (
      !interpretationOnly &&
      intentTask.trim() &&
      !pendingDiscussion &&
      !establishedConversation
    ) {
      const clarification = executionClarification(
        intentTask,
        requestIntent,
        requestIntentContext,
      )
      if (clarification)
        throw new KiokukoError('VALIDATION_ERROR', clarification)
    }
    const legacyTaskType =
      advisoryType !== undefined &&
      advisoryType !== 'chat' &&
      !requestIntentContext?.activeGoal &&
      !requestIntentContext?.activeTask &&
      (requestIntentContext?.proposals.length ?? 0) === 0
    if (requestIntent?.source === 'unresolved' && legacyTaskType)
      requestIntent = undefined
    if (requestIntent?.source !== 'unresolved') {
      const intentType = requestIntentTaskType(
        requestIntent,
        profile?.taskType ?? advisoryType,
      )
      if (intentType !== undefined)
        profile = { ...profile, taskType: intentType }
    }
    // Coding Lisp choice belongs to the admitted Goal, after all criteria exist.
    // Task intake never starts Lisp or interrupts an explanation with a mode question.
    const catalog = await capabilityCatalog(skills, tools, {
      agent: { id: payload.agent.id },
      nativeAgent: payload.agent,
      cwd,
      signal: payload.signal,
    })
    return {
      agent: { id: payload.agent.id },
      nativeAgent: payload.agent,
      sessionId,
      ...(boundSession === undefined
        ? {}
        : { nativeSession: boundSession as object }),
      turn: payload.turn,
      sourceStartSeq,
      step: payload.step,
      nativeMessages: payload.messages,
      task,
      cwd,
      ...(profile === undefined ? {} : { profileHints: profile }),
      ...(deferTaskTypeInference ? { deferTaskTypeInference: true } : {}),
      ...(requestIntent === undefined ? {} : { requestIntent }),
      ...(requestIntentContext === undefined ? {} : { requestIntentContext }),
      memoryOwner: memoryOwnerKind(requestIntent, profile?.taskType),
      capabilities: catalog,
      signal: payload.signal,
    }
  }
  return {
    gate,
    mapPreStep,
    requestContext: async (payload, task) => {
      const session = payload.agent.session
      if (!session) return undefined
      const previous =
        currentForAgentEvent(
          payload.agent.id,
          session.id,
          payload.turn,
          session,
          payload.agent,
        ) ??
        currentForAgentEvent(
          payload.agent.id,
          session.id,
          undefined,
          session,
          payload.agent,
        )
      return requestIntentContextFor(
        payload,
        session.id,
        session,
        previous,
        task,
      )
    },
    interpret: async (payload) => {
      const event = await mapPreStep(payload, undefined, undefined, true)
      if (!event.requestIntentContext || !event.requestIntent) return undefined
      return {
        context: event.requestIntentContext,
        decision: event.requestIntent,
      }
    },
    refreshMemoryOwner,
    clear: (): void => {
      continuedTurns.clear()
      resumedTurns.clear()
    },
  }
}
