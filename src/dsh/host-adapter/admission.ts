import { createTurnState, policyState } from '../host-adapter/turn-state.js'
import { bindMemoryApplication, memoryRetrievalStatus } from '../../memory/application.js'
import { createMemoryReuseRuntime } from '../memory-reuse.js'
import type { DecisionService } from '../decisions/service.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import { classifyTask, selectInstalledSkills } from '../decisions/workflows.js'
import { humanInput } from '../../memory/review/evidence.js'
import { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import { ANSWER_REVIEW_FORM, hasHumanInput, type ReviewAgent } from '../answer-review/contracts.js'
import { AutoMemoryReviewCoordinator, type ReviewNativeSession } from '../auto-memory-review.js'
import { refreshContinuedTaskContext } from '../task-intake.js'
import { DshEnnoMemoryRefresh } from '../enno-memory-refresh.js'
import { saveSessionNotice } from '../plugin-records.js'
import { AkinatorMemoryConfig } from '../config.js'
import { explicitExecutionMode, initializeExecutionSelection, readExecutionSelection, writeExecutionSelection, type StoredExecutionSelection } from '../execution-selection.js'
import { selectExecution, ExecutionSelectionPending } from '../model-selection-ui.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../lisp/coding-choice.js'
import type { ModelRoute, DshModelCatalog, DshModelCompatibility } from '../model-configuration.js'
import { ennoStateForPreparedTask } from '../../enno-oduno/service.js'
import { DshEnnoDelegation } from '../enno-delegation.js'
import type { DeepPlanningController } from '../../deep-thinker/controller.js'
import { realpathSync } from 'node:fs'
import { type DshNativePreStepPayload } from '../composition.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { DshIntakeGate, type DshCapabilityReadContext, type DshIntakeGateResult, type DshPreStepDecision, type DshPreStepEvent } from '../intake-gate.js'
import { resolveGroundedIntakeProfile } from '../intake-profile-resolver.js'
import type { PreparedAgentTask } from '../task-intake.js'
import { deriveAkinatorReasoning } from '../../akinator/reasoning.js'
import { resolveCapabilities } from '../../akinator/capabilities.js'
import { readAkinatorSession, readRunIntakeLink } from '../../akinator/store.js'
import { type DshCloseIntent, type DshRunClose } from '../session-bridge.js'
import { DshMemoryFinalizer, dshTurnBoundarySeq, type DshLogEvent, type DshSessionEventSource } from '../session-memory-finalizer.js'
import { createDshIntakeAnswerer, type DshUserQuestions } from '../user-interaction.js'
import { type DshCapabilityCatalog } from '../capability-catalog.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { KiokukoError } from '../../errors.js'
import { answerEnno, stateForSnapshot, inapplicableEnnoState } from '../../enno-oduno/service.js'
import { claimExecutionLeaseInTransaction, readEnnoSnapshot, terminalizeLedgerRunInTransaction } from '../../enno-oduno/store.js'
import { decideDshContinuation } from '../continuation.js'
import { resolveProjectWorkspaceReadOnly } from '../../memory/workspaces.js'
import { ENNO_APPLICABLE_TASK_TYPES, type EnnoExecutionLease, type EnnoOdunoState } from '../../enno-oduno/types.js'
import { supersedeBoundaryJobsAtOrBeforeRevisionInTransaction, supersedeOutboxAtOrBeforeRevisionInTransaction } from '../turn-process.js'
import { unexecutedRunInput } from '../input-claim.js'
import { DshSessionLogMirror, type DshMirrorEventSession } from '../session-log-mirror.js'
import { DshExecutionSupport, type ExecutionBinding } from '../execution-support.js'
import { resetLoopGuardForUserInTransaction } from '../loop-guard.js'
import type { NativeSkills, NativeTools, NativeSessions, NativeAgents, AdapterContext } from './native-events.js'
import type { TurnRecord } from './turn-state.js'

interface AdmissionDependencies {
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
  readonly delegation: DshEnnoDelegation
  readonly executionSupport: DshExecutionSupport
  readonly ennoMemory: DshEnnoMemoryRefresh
  readonly memoryFinalizer: DshMemoryFinalizer
  readonly autoReview: AutoMemoryReviewCoordinator
  readonly sessionMirror: DshSessionLogMirror
  readonly akinatorMemoryConfig: import('zod').z.infer<typeof AkinatorMemoryConfig>
  readonly turnState: ReturnType<typeof createTurnState>
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly setSelection: (runId: string, value: StoredExecutionSelection) => void
  readonly refreshEnnoMemory: (item: TurnRecord, signal: AbortSignal) => Promise<void>
  readonly executionBinding: (item: TurnRecord) => ExecutionBinding
  readonly captureInitialInput: (sessionId: string, turn: number, messages: readonly unknown[]) => Promise<void>
  readonly contextMessages: (event: DshPreStepEvent, pending: readonly unknown[]) => Promise<readonly unknown[]>
  readonly resolveIdleClose: (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object) => Promise<DshCloseIntent | undefined>
  readonly retireSupersededRun: (item: TurnRecord, status: 'completed' | 'failed' | 'cancelled') => Promise<void>
  readonly cancelBoundarySession: (sessionId: string) => void
  readonly isSelectionBlocked: (agent: object) => boolean
  readonly closeTurn: (input: DshRunClose) => Promise<void>
  readonly readStateForRun: (item: TurnRecord) => Promise<EnnoOdunoState>
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<DshCapabilityCatalog>
  readonly sessionEventSource: (value: object | undefined) => DshSessionEventSource
  readonly objectRecord: (value: unknown) => Record<string, unknown> | undefined
  readonly isHumanMessage: (value: unknown) => boolean
  readonly textFromMessages: (messages: readonly unknown[], fallback?: string) => string
  readonly pluginContinuationId: (value: unknown) => string | undefined
  readonly isLoopRecoveryMessage: (value: unknown) => boolean
}

interface AdmissionOwner {
  readonly gate: DshIntakeGate
  readonly mapPreStep: (payload: DshNativePreStepPayload) => Promise<DshPreStepEvent>
  readonly clear: () => void
}

export function createAdmission({
  native, skills, tools, userQuestions, sessions, agents, deepPlanning, modelCatalog, modelCompatibility,
  modelRoutes, now, runtime, decisions, answerReview, delegation, executionSupport,
  ennoMemory, memoryFinalizer, autoReview, sessionMirror, akinatorMemoryConfig,
  turnState, getSelection, setSelection, refreshEnnoMemory, executionBinding,
  captureInitialInput, contextMessages, resolveIdleClose, retireSupersededRun,
  cancelBoundarySession, isSelectionBlocked, closeTurn, readStateForRun,
  capabilityCatalog, sessionEventSource, objectRecord, isHumanMessage,
  textFromMessages, pluginContinuationId, isLoopRecoveryMessage,
}: AdmissionDependencies): AdmissionOwner {
  const currentSession = turnState.currentSession
  const currentForAgentEvent = turnState.currentForAgentEvent
  let resumeExistingRun: ((event: DshPreStepEvent) => Promise<DshIntakeGateResult | undefined>) | undefined
function supersedesUnstartedEnno(event: DshPreStepEvent, state: EnnoOdunoState): boolean {
  if (state.status !== 'oduno_ideal') return false
  const incomingType = resolveGroundedIntakeProfile({
    task: event.task,
    cwd: event.cwd,
    ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
  }).profileHints.taskType
  return incomingType !== null && !ENNO_APPLICABLE_TASK_TYPES.includes(incomingType as (typeof ENNO_APPLICABLE_TASK_TYPES)[number])
}

  let prepareGeneration = 0
  const continuedTurns = new Map<string, {
    readonly fingerprint: string
    readonly profileHints?: DshPreStepEvent['profileHints']
    readonly result: DshIntakeGateResult
    readonly nativeAgent?: object
    readonly nativeSession?: object
  }>()
  const resumedTurns = new Map<string, {
    readonly fingerprint: string
    readonly profileHints?: DshPreStepEvent['profileHints']
    readonly result: DshIntakeGateResult
    readonly nativeAgent?: object
    readonly nativeSession?: object
  }>()
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
    turnState.record(event, result, generation)
    const reviewItem = currentSession(event.sessionId)
    const reviewAgent = event.nativeAgent as ReviewAgent | undefined
    if (reviewItem && reviewAgent?.session && typeof reviewAgent.session.snapshotEvents === 'function') {
      const eligible = () => {
        const item = currentSession(event.sessionId), selection = getSelection(reviewItem.runId)?.value
        const header = reviewAgent.session.header
        return item?.runId === reviewItem.runId && !item.closed && !item.failed && item.prepared.run.status === 'active'
          && !item.prepared.ennoOduno.applicable && !selection?.discussion && (!selection || selection.mode === 'normal' && selection.status === 'ready')
          && !delegation.isChild(reviewAgent) && !deepPlanning.executor.isChild(reviewAgent) && !header?.parentSession && header?.origin !== 'subagent' && !header?.delegationDepth
          && !executionSupport.paused(event.sessionId)
      }
      answerReview.bind({ runId: reviewItem.runId, workspace: reviewItem.workspace, requestId: `run:${reviewItem.runId}`, task: reviewItem.task,
        catalogDigest: reviewItem.catalog.digest, turn: event.turn, agent: reviewAgent, eligible,
        current: () => { const item = currentSession(event.sessionId); return item?.runId === reviewItem.runId && item.nativeAgent === reviewAgent && item.nativeSession === reviewAgent.session && agents?.get(reviewAgent.id) === reviewAgent && sessions?.get(event.sessionId) === reviewAgent.session },
        settled: async () => {
          const item = currentSession(event.sessionId)
          if (!item || item.runId !== reviewItem.runId || item.closed || (reviewAgent as any).status === 'running') return
          const intent = await resolveIdleClose(item.agentId,item.sessionId,item.nativeSession,item.nativeAgent)
          if (intent) await retireSupersededRun?.(item,intent.status)
        },
      })
    }
    if (result.admitted && result.prepared.run.status === 'active' && currentSession(event.sessionId)?.prepareGeneration === generation && !delegation.isChild(event.nativeAgent ?? {})) {
      await runtime.withDatabase(db => {
        if (currentSession(event.sessionId)?.prepareGeneration !== generation) return
        bindMemoryApplication(db, {
        runId: result.prepared.run.runId, workspace: result.prepared.project.workspace,
        sessionId: event.sessionId, repositoryRoot: result.prepared.project.repositoryRoot,
      }, result.prepared.intake.profile, result.prepared.context,
      memoryRetrievalStatus(db, result.prepared.project.workspace, result.prepared.context, result.prepared.memoryPolicy.contextWithheld))
      })
    }
    if(event.nativeSession && !delegation.isChild(event.nativeAgent??{})) {
      try { await autoReview.bind({workspace:result.prepared.project.workspace,runId:result.prepared.run.runId,session:event.nativeSession as ReviewNativeSession,startSeq:sourceStartSeq}) }
      catch { /* Unsupported or unavailable review source must not veto a native request. */ }
    }
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
    async choose(event: DshPreStepEvent, result: DshIntakeGateResult): Promise<DshIntakeGateResult> {
      const runId = result.prepared.run.runId
      let stored = await runtime.withDatabase(db => readExecutionSelection(db, runId))
      if (result.admitted && result.prepared.selectedSkills === undefined) {
        const task = await runtime.withDatabase(db => readAkinatorSession(db, { workspace: result.prepared.project.workspace, sessionId: result.prepared.intake.sessionId }).task)
        result.prepared.selectedSkills = await selectInstalledSkills(decisions, `run:${runId}`, task, [...event.capabilities.skills, ...event.capabilities.tools], result.prepared.capabilities, event.signal)
      }
      // Legacy accepted plans keep their original execution contract. A draft
      // awaiting the new review gate must first acquire an explicit check binding.
      if (!stored && result.prepared.ennoOduno.status === 'zenki_planning') {
        stored = await runtime.withDatabase(db => {
          initializeExecutionSelection(db, runId)
          const current = readExecutionSelection(db, runId)!
          return current.value.mode === 'pending' ? writeExecutionSelection(db, runId, current.revision, { mode: 'enno', status: 'selecting' }) : current
        })
      }
      if (!stored) return result
      const discussion = stored.value.discussion
      if (discussion && event.turn > discussion.turn) {
        const incomingType = resolveGroundedIntakeProfile({ task: event.task, cwd: event.cwd,
          ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
        }).profileHints.taskType
        const requestedMode = explicitExecutionMode(event.task)
        if (requestedMode !== undefined || incomingType !== null && incomingType !== 'chat') {
          const { discussion: _answered, ...value } = stored.value
          const revision = stored.revision
          stored = await runtime.withDatabase(db => writeExecutionSelection(db, runId, revision,
            requestedMode === undefined ? value : { ...value, mode: 'pending' }))
        }
      }
      if (!ENNO_APPLICABLE_TASK_TYPES.includes(result.prepared.intake.profile.taskType as typeof ENNO_APPLICABLE_TASK_TYPES[number])) {
        const revision = stored.revision
        if (stored.value.mode === 'pending') await runtime.withDatabase(db => db.prepare('DELETE FROM dsh_execution_selections WHERE run_id = ? AND revision = ?').run(runId, revision))
        return result
      }
      setSelection(runId, stored)
      const lispCoding = native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined
      if (stored.value.mode === 'pending' && !stored.value.discussion && event.nativeAgent && lispCoding?.enabled(event.nativeAgent)) {
        if (explicitExecutionMode(event.task) === 'enno') throw new ExecutionSelectionPending('Lispモードでは役小角を使えません。/kioku-lisp disable で解除してから選択してください。')
        stored = await runtime.withDatabase(db => writeExecutionSelection(db, runId, stored!.revision, {
          mode: 'normal', status: 'ready', ...(stored!.value.ordinaryModel ? { ordinaryModel: stored!.value.ordinaryModel } : {}),
        }))
        setSelection(runId, stored)
      }
      const selected = await selectExecution({
        task: event.task, turn: event.turn, signal: event.signal, stored, routes: modelRoutes ?? [],
        ...(event.nativeAgent ? { agent: event.nativeAgent } : {}),
        ...(userQuestions ? { questions: userQuestions } : {}),
        ...(modelCatalog ? { llm: modelCatalog } : {}),
        ...(modelCompatibility ? { compatibility: modelCompatibility } : {}),
        save: async (revision, value) => {
          const saved = await runtime.withDatabase(db => writeExecutionSelection(db, runId, revision, value))
          setSelection(runId, saved)
          return saved
        },
      })
      setSelection(runId, selected)
      const ennoOduno = selected.value.discussion ? result.prepared.ennoOduno
        : await runtime.withDatabase(db => ennoStateForPreparedTask(db, result.prepared, event.sessionId))
      return { ...result, prepared: { ...result.prepared, ennoOduno } }
    }
    override async prepare(event: DshPreStepEvent): Promise<DshIntakeGateResult> {
      // Capture completion ordering before any asynchronous database or intake
      // work. Revision ordering alone cannot distinguish two same-revision
      // context deliveries that finish out of order.
      const generation = ++prepareGeneration
      const reviewProject=await runtime.withDatabase((database) => resolveProjectWorkspaceReadOnly(database, event.cwd, { allowDirectory: true }))
      if(reviewProject)await autoReview.acceptInput(reviewProject.workspace,event.sessionId,event.task)
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
        if (!hasHumanInput(event.nativeMessages ?? []) && event.nativeMessages?.some(message => objectRecord(objectRecord(message)?.source)?.form === ANSWER_REVIEW_FORM)) {
          if (!event.nativeAgent || !await answerReview.accept(event.nativeAgent as ReviewAgent, event.nativeMessages, event.turn, event.capabilities.digest)) throw new Error('Stale answer review continuation')
        }
        return event.signal.aborted ? { ...cached.result, admitted: false } : this.choose(event, cached.result)
      }
      const previous = currentForAgentEvent(event.agent.id, event.sessionId, undefined, event.nativeSession, event.nativeAgent)
      const reviewMessages = event.nativeMessages ?? []
      if (hasHumanInput(reviewMessages)) answerReview.humanInput(event.sessionId, event.turn)
      if (!hasHumanInput(reviewMessages) && reviewMessages.some(message => objectRecord(objectRecord(message)?.source)?.form === ANSWER_REVIEW_FORM)) {
        if (!previous || !event.nativeAgent || !await answerReview.accept(event.nativeAgent as ReviewAgent, reviewMessages, event.turn, event.capabilities.digest)) throw new Error('Unbound answer review continuation')
        const continued = { admitted: true, prepared: previous.prepared, catalog: previous.catalog }
        continuedTurns.set(cacheKey, { fingerprint, result: continued, nativeAgent: event.nativeAgent, ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }) })
        await bindAndRecord(event, continued, generation)
        return continued
      }
      if (previous !== undefined && previous.turn === event.turn && !previous.closed) {
        // Model routing prepares before native pre-step. Reuse that exact
        // intake result instead of treating its newly active run as a cold
        // resume (which deliberately starts without historical context).
        const prepared = await super.prepare(event)
        if (prepared.prepared.run.runId !== previous.runId) throw new KiokukoError('CONFLICT', 'The prepared native turn changed run identity')
        const selected = await this.choose(event, prepared)
        if (selected.admitted) await bindAndRecord(event, selected, generation)
        return selected
      }
      if (previous !== undefined && previous.turn < event.turn) {
        if (event.signal.aborted) return { admitted: false, prepared: previous.prepared, catalog: event.capabilities }
        let previousState = await readStateForRun(previous)
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
          turnState.applyPolicy(previous.runId, next)
          previousState = revised.ennoOduno
        }
        const previousWasChat = previous.prepared.intake.profile.taskType === 'chat'
        const superseded = previous.prepared.ennoOduno.applicable && supersedesUnstartedEnno(event, previousState)
        const selection = getSelection(previous.runId)?.value
        const continuePrevious = selection && (selection.status !== 'ready' || selection.mode === 'normal' && previous.failed)
          ? true : previousWasChat
          ? event.profileHints?.taskType === 'chat'
          : !superseded
            && previousState.status !== 'completed'
            && previousState.status !== 'blocked'
            && previousState.status !== 'cancelled'
            && (previousState.nextAction !== 'complete' || executionSupport.paused(previous.sessionId))
        if (continuePrevious) {
          this.assertCatalog(previous.catalog, event.capabilities)
          const refreshedWork = await refreshContinuedWorkLease(previous, previousState)
          if (refreshedWork !== undefined) {
            previous.prepared = { ...previous.prepared, ennoOduno: refreshedWork.state }
            const next = policyState(refreshedWork.state, previous, previous.sessionId, refreshedWork.lease)
            turnState.applyPolicy(previous.runId, next)
          }
          let continuedMemory:Pick<PreparedAgentTask,'context'|'memoryPolicy'>|undefined
          if(!ennoMemory.ownsActiveRefresh(previous.prepared.ennoOduno)) {
            const captured=previous.prepared, started=performance.now()
            const inboxIdentity=()=>canonicalContentHash([...((event.nativeAgent as any)?.inbox?.nextStep??[]),...((event.nativeAgent as any)?.inbox?.nextTurn??[])].filter(isHumanMessage))
            const pendingInput=inboxIdentity()
            const assertCurrent=()=>{
              event.signal.throwIfAborted()
              if(inboxIdentity()!==pendingInput||previous.closed||previous.prepared!==captured||currentSession(event.sessionId)!==previous||prepareGeneration!==generation)
                throw new KiokukoError('CONFLICT', 'continued_memory_stale')
              if(event.nativeSession!==previous.nativeSession||event.nativeAgent!==previous.nativeAgent)throw new KiokukoError('CONFLICT', 'continued_memory_owner_changed')
              if(performance.now()-started>1000+(decisions.memoryReuse.mode==='auto'?decisions.memoryReuse.budgetMs:0))throw new Error('continued_memory_deadline')
            }
            try { continuedMemory=await runtime.withDatabase(async (database,embedding)=>{
              if(embedding.mode==='required')throw new Error('required_embedding_unavailable')
              return refreshContinuedTaskContext({database, memoryReuse: await createMemoryReuseRuntime(decisions, `run:${captured.run.runId}`, event.signal), prepared:captured,task:event.task,capabilities:[...event.capabilities.skills,...event.capabilities.tools],assertCurrent,
                validateCapabilities:async()=>{const fresh=await capabilityCatalog(skills,tools,{agent:event.agent,...(event.nativeAgent?{nativeAgent:event.nativeAgent}:{}),cwd:event.cwd,signal:event.signal});this.assertCatalog(event.capabilities,fresh);assertCurrent()}})
            }) } catch (error) {
              if(event.signal.aborted || error instanceof KiokukoError && ['CONFLICT','SECURITY_REJECTION','AUTHENTICATION_ERROR','INTEGRITY_ERROR'].includes(error.code))throw error
              /* Optional retrieval failure retains the previous delivery, whose state is validated before injection. */
            }
          }
          const continued = await this.choose(event, { admitted: !event.signal.aborted, prepared: continuedMemory?{...previous.prepared,...continuedMemory}:previous.prepared, catalog: event.capabilities })
          if (continued.admitted) {
            continuedTurns.set(cacheKey, {
              fingerprint,
              result: continued,
              ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
              ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
              ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
            })
            await bindAndRecord(event, continued, generation)
          }
          return continued
        }
        if (event.signal.aborted) return { admitted: false, prepared: previous.prepared, catalog: event.capabilities }
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
          ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
          ...(event.nativeAgent === undefined ? {} : { nativeAgent: event.nativeAgent }),
          ...(event.nativeSession === undefined ? {} : { nativeSession: event.nativeSession }),
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
    override async preStep(event: DshPreStepEvent, next: () => Promise<DshPreStepDecision>): Promise<DshPreStepDecision> {
      if (event.nativeAgent && delegation.isChild(event.nativeAgent)) return next()
      // The native chain owns admission and the original message ordering.
      // Run it before any Kiokuko storage or classification work so an
      // auxiliary database failure cannot delay or rewrite its decision.
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      if (event.nativeAgent && isSelectionBlocked(event.nativeAgent)) return { kind: 'reject' }
      const nativeMessages = Object.freeze([...(event.nativeMessages ?? [])])
      await captureInitialInput(event.sessionId, event.turn, nativeMessages)
      const humanPresent = nativeMessages.some(isHumanMessage) || downstream.messages.some(isHumanMessage)
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
        answerReview.humanInput(event.sessionId, event.turn)
        nativeDecision = { ...nativeDecision, messages: nativeDecision.messages.filter(message => objectRecord(objectRecord(message)?.source)?.form !== ANSWER_REVIEW_FORM) }
        cancelBoundarySession(event.sessionId)
        const previous = currentSession(event.sessionId)
        if (previous) ennoMemory.invalidate(previous.runId)
        const state = previous === undefined ? undefined : turnState.policyState(previous.runId)
        if (previous !== undefined) {
          try {
            await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
              if (state !== undefined) {
                const timestamp = now?.() ?? new Date().toISOString()
                supersedeOutboxAtOrBeforeRevisionInTransaction(database, event.sessionId, state.revision, timestamp)
                supersedeBoundaryJobsAtOrBeforeRevisionInTransaction(database, event.sessionId, state.revision, timestamp)
              }
              resetLoopGuardForUserInTransaction(database, {
                runId: previous.runId,
                dshSessionId: event.sessionId,
                resolution: 'manual_user',
                ...(now === undefined ? {} : { now: now() }),
              })
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
        const item = currentSession(event.sessionId)
        if (item !== undefined) {
          if (getSelection(item.runId)?.value.status === 'ready' || getSelection(item.runId)?.value.discussion) {
            const original = await runtime.withDatabase(db => unexecutedRunInput(db, item.runId, item.sessionId))
            const deliveredIds = new Set(sessionEventSource(event.nativeSession).snapshotEvents()
              .filter(e => e.type === 'user/message').map(e => objectRecord(e.data)?.id))
            const currentIds = new Set(nativeDecision.messages.map(m => objectRecord(m)?.id))
            const missing = original.filter(m => {
              const id = objectRecord(m)?.id
              return typeof id === 'string' && !deliveredIds.has(id) && !currentIds.has(id)
            })
            if (missing.length) nativeDecision = { ...nativeDecision, messages: [...missing, ...nativeDecision.messages] }
          }
          const humanMessages = [...new Map([...nativeMessages, ...nativeDecision.messages].filter(isHumanMessage)
            .map(message => [objectRecord(message)?.id ?? canonicalContentHash(message), message])).values()]
          const humanTask = humanPresent ? textFromMessages(humanMessages, event.task) : undefined
          if (humanTask !== undefined) item.memoryInput = humanTask
          await executionSupport.refresh({ ...executionBinding(item), ...(humanTask === undefined ? {} : {
            // Steering within a native turn must update optional conditions,
            // without changing the logical-turn intake/receipt identity.
            task: humanTask, humanInput: canonicalContentHash({ turn: event.turn, messages: humanMessages }),
          }) }, humanPresent)
          // Only an empty, automatic step can be deliberately paused. Human,
          // attachment and other pending inputs must never be consumed here.
          if (!humanPresent && event.nativeMessages?.length === 0 && nativeDecision.messages.every(message => {
            const source = objectRecord(objectRecord(message)?.source)
            return (source?.kind === 'runtime-context' || source?.kind === 'plugin' && source.plugin === '@deepseek-ai/dsh-system-prompt') && source.form === 'snapshot'
          })) {
            const paused = await executionSupport.pauseAtBoundary(event.sessionId, async (id, text) => {
              const session = event.nativeSession as { snapshotEvents?: () => readonly DshLogEvent[] } | undefined
              if (!session?.snapshotEvents || !sessions?.flush) throw new Error('Pause notice delivery unavailable')
              await runtime.withDatabase(db => saveSessionNotice(db, { id, runId: item.runId, sessionId: item.sessionId,
                rootPath: item.cwd, kind: 'status', text, anchorSeq: session.snapshotEvents!().at(-1)?.seq ?? 0 }))
              await sessions.flush(session)
              event.signal.throwIfAborted()
              // A human can arrive while the native log flush is in flight.
              const inbox = (event.nativeAgent as any)?.inbox
              if ([...(inbox?.nextStep ?? []), ...(inbox?.nextTurn ?? [])].some(isHumanMessage)) {
                throw new Error('Human input takes priority over exploration pause')
              }
            })
            if (paused) return { kind: 'reject' }
          }
        }
        if (item !== undefined && !getSelection(item.runId)?.value.discussion) await refreshEnnoMemory(item, event.signal)
        const messages = await contextMessages(event, nativeDecision.messages)
        return { ...nativeDecision, messages: [...executionSupport.projectMessages(event.sessionId, nativeDecision.messages), ...messages] }
      } catch (error) {
        if (error instanceof ExecutionSelectionPending) return { kind: 'reject' }
        if (!humanPresent && nativeMessages.some(message => objectRecord(objectRecord(message)?.source)?.form === ANSWER_REVIEW_FORM)) return { kind: 'reject' }
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
    true,
    akinatorMemoryConfig,
    decisions,
  )
  resumeExistingRun = async (event): Promise<DshIntakeGateResult | undefined> => runtime.withDatabase(async (database) => {
    const project = await resolveProjectWorkspaceReadOnly(database, event.cwd, { allowDirectory: true })
    if (project === undefined) return undefined
    const candidates = database.prepare(`
      SELECT lr.run_id AS runId, ec.orchestration_session_id AS orchestrationId
      FROM ledger_runs AS lr
      LEFT JOIN enno_contracts AS ec ON ec.run_id = lr.run_id
      LEFT JOIN dsh_exploration_states AS es ON es.run_id = lr.run_id
      LEFT JOIN dsh_execution_selections AS xs ON xs.run_id = lr.run_id
      WHERE lr.workspace = ? AND lr.dsh_session_id = ? AND lr.status = 'active'
        AND ((ec.repository_root = ? AND ec.status NOT IN ('completed', 'cancelled', 'blocked'))
          OR (ec.run_id IS NULL AND (json_extract(es.state_json, '$.paused') = 1 OR xs.run_id IS NOT NULL)))
      ORDER BY lr.created_at, lr.run_id LIMIT 2
    `).all<{ runId: string; orchestrationId: string | null }>(project.workspace, event.sessionId, project.repositoryRoot)
    if (candidates.length === 0) return undefined
    if (candidates.length !== 1) throw new KiokukoError('CONFLICT', 'Multiple active runs match this session; refusing to guess')
    const candidate = candidates[0]!
    const runId = candidate.runId
    const snapshot = candidate.orchestrationId === null ? undefined : readEnnoSnapshot(database, {
      runId, workspace: project.workspace, orchestrationId: candidate.orchestrationId,
    })
    if (snapshot && !event.signal.aborted && supersedesUnstartedEnno(event, stateForSnapshot(snapshot))) {
      terminalizeLedgerRunInTransaction(database, runId, 'cancelled')
      return undefined
    }
    const automaticMessage = event.nativeMessages?.find((message) => {
      const continuationId = pluginContinuationId(message)
      if (continuationId === undefined) return false
      const outbox = database.prepare(`
        SELECT message_form AS messageForm
          FROM dsh_continuation_outbox
         WHERE continuation_id = ?
      `).get<{ messageForm: 'continuation' | 'loop-recovery' }>(continuationId)
      return outbox === undefined ? !isLoopRecoveryMessage(message) : outbox.messageForm !== 'loop-recovery'
    })
    const automaticClaimId = automaticMessage === undefined ? undefined : pluginContinuationId(automaticMessage)
    const decision = snapshot ? decideDshContinuation(database, {
      dshSessionId: event.sessionId, cwd: event.cwd,
      ...(automaticClaimId === undefined ? {} : { claimId: automaticClaimId }),
    }, runId) : undefined
    if (decision && (!decision.continue || decision.runId !== runId)) {
      throw new KiokukoError('CONFLICT', decision.warning ?? 'The active run cannot be resumed by this DSH session')
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
      securityNotice: 'This resumed DSH run uses only current repository evidence and the current host capability catalog; previously delivered ordinary memory is not replayed implicitly. Active ennoMemory may make a new bounded selection under current authority.',
      ennoOduno: snapshot ? stateForSnapshot(snapshot) : inapplicableEnnoState(),
    }
    if (decision?.executionLease) turnState.stageLease(runId, decision.executionLease)
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
    if (!currentSession(sessionId) && boundSession && !delegation.isChild(payload.agent)) await answerReview.recover(payload.agent as ReviewAgent, async row => {
      await sessions?.flush?.(boundSession)
      await sessionMirror.checkpointAfterNativeFlush(boundSession as DshMirrorEventSession)
      await closeTurn({ runId: row.runId, status: row.status, ...(row.endSeq === undefined ? {} : { sourceEndSeq: row.endSeq }) })
    })
    const sourceStartSeq = dshTurnBoundarySeq(sessionEventSource(boundSession as object | undefined), payload.turn, 'start')
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
    const reviewing = !hasHumanInput(payload.messages) && payload.messages.some(message => objectRecord(objectRecord(message)?.source)?.form === ANSWER_REVIEW_FORM)
    const task = bound?.task ?? (reviewing && previous ? previous.task : textFromMessages(payload.messages, previous?.task))
    let profile = (() => {
      if (bound !== undefined) return bound.profileHints
      if (reviewing && previous) return previous.profileHints
      if (previous === undefined) return undefined
      const inferred = resolveGroundedIntakeProfile({ task, cwd }).profileHints.taskType
      const previousType = getSelection(previous.runId)?.value.discussion ? 'chat' : previous.prepared.intake.profile.taskType
      return inferred === null || previousType === 'chat' && inferred === 'chat' ? { taskType: previousType } : undefined
    })()
    if (!reviewing && bound === undefined && !delegation.isChild(payload.agent)) {
      const taskType = await classifyTask(decisions, dshTurnRequestId({ dshSessionId: sessionId, turn: payload.turn }), task, profile?.taskType, payload.signal)
      if (taskType) profile = { ...profile, taskType }
    }
    const lispCoding = native.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined
    if (lispCoding && !reviewing && bound === undefined && !previous?.prepared.ennoOduno.applicable && !delegation.isChild(payload.agent)) {
      const grounded = resolveGroundedIntakeProfile({ task, cwd, ...(profile === undefined ? {} : { profileHints: profile }) })
      const choice = await lispCoding.prepare({ agent: payload.agent, task, taskType: grounded.profileHints.taskType,
        turn: payload.turn, signal: payload.signal })
      profile = { ...profile, taskType: choice.taskType, ...(choice.clarification ? { constraints: choice.clarification } : {}) }
    }
    // Lisp changes the scoped tool surface. Bind capabilities only after its
    // explicit selection and activation, never mutate an already-bound catalog.
    const catalog = await capabilityCatalog(skills, tools, {
      agent: { id: payload.agent.id }, nativeAgent: payload.agent, cwd, signal: payload.signal,
    })
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
      ...(profile === undefined ? {} : { profileHints: profile }),
      capabilities: catalog,
      signal: payload.signal,
    }
  }
  return {
    gate,
    mapPreStep,
    clear: (): void => { continuedTurns.clear(); resumedTurns.clear() },
  }
}
