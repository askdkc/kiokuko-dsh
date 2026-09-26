import type { Context } from '@deepseek-ai/cordis'
import type { DshCoreRuntime } from '../core-runtime.js'
import { onNativeEvent } from './native-events.js'
import type { NativeAgent, NativeAgents, NativeSessions, NativeSkills, NativeTools } from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import { policyState } from './turn-state.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { DshUserQuestions } from '../user-interaction.js'
import type { DshIntakeGate, DshCapabilityReadContext } from '../intake-gate.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'
import type { DshEnnoDelegation } from '../enno-delegation.js'
import type { DshExecutionSupport } from '../execution-support.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { ReviewAgent } from '../answer-review/contracts.js'
import type { DshSessionLogMirror, DshMirrorEventSession } from '../session-log-mirror.js'
import type { DshAdvisoryRunner } from '../advisory-runner.js'
import type { DshRunLifecycle } from '../session-bridge.js'
import { dshTurnBoundarySeq, type DshSessionEventSource } from '../session-memory-finalizer.js'
import { DshConfirmationController, DshEnnoController, type DshTurnStoppingEvent } from '../enno-controller.js'
import { abortable, DshBoundaryWorker } from '../boundary-worker.js'
import { DshCompletionReporter } from '../completion-report.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { readEnnoSnapshot } from '../../enno-oduno/store.js'
import { answerEnno, prepareEnnoVerification, stateForSnapshot, type EnnoOperationResponse } from '../../enno-oduno/service.js'
import type { EnnoNextAction, EnnoOdunoState } from '../../enno-oduno/types.js'
import type { DshAdvisoryRoundResult } from '../advisory-runner.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { selectDshDirectiveSources, injectDshContext } from '../context-injection.js'
import { projectDshDirective } from '../directive-projection.js'
import { projectDshContext } from '../context-projection.js'
import { refreshDshSkillSnapshots } from '../skill-snapshot.js'
import { verificationBoundaryKey } from '../verification-identity.js'
import { readPendingOutbox, readTurnSeal, replacePendingOutboxMessageInTransaction, type DshBoundaryJob } from '../turn-process.js'
import { claimAutomaticContinuationInTransaction, claimBoundaryEffectInTransaction, claimLoopRecoveryQuestionInTransaction, ennoInstructionDigest, resetBoundaryEffectGuardInTransaction, resetLoopGuardForUserInTransaction } from '../loop-guard.js'
import { boundaryFailureCopy } from '../user-interaction.js'
import { KiokukoError } from '../../errors.js'

interface BoundaryDependencies {
  readonly ctx: Context
  readonly runtime: DshCoreRuntime
  readonly now: (() => string) | undefined
  readonly agents: NativeAgents | undefined
  readonly sessions: NativeSessions | undefined
  readonly skills: NativeSkills | undefined
  readonly tools: NativeTools | undefined
  readonly userQuestions: DshUserQuestions | undefined
  readonly gate: DshIntakeGate
  readonly delegation: DshEnnoDelegation
  readonly executionSupport: DshExecutionSupport
  readonly answerReview: AnswerReviewCoordinator
  readonly sessionMirror: DshSessionLogMirror
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly currentForAgentEvent: (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object) => TurnRecord | undefined
  readonly stateForRun: (database: any, item: TurnRecord) => EnnoOdunoState
  readonly systemSkillsFor: (agent: object) => ReadonlySet<string> | undefined
  readonly getSkillPrompts: () => DshSkillPrompts
  readonly refreshEnnoMemory: (item: TurnRecord, signal: AbortSignal) => Promise<void>
  readonly confirmationAnswerer: ConstructorParameters<typeof DshConfirmationController>[0]['answerer'] | undefined
  readonly assertTurnBoundary: (event: DshTurnStoppingEvent) => Promise<unknown>
  readonly advisoryRunner: DshAdvisoryRunner
  readonly submitAdvisory: (result: DshAdvisoryRoundResult, input: { readonly event: DshTurnStoppingEvent; readonly state: EnnoOdunoState }) => Promise<EnnoOdunoState>
  readonly advisoryEvidenceFor: (item: TurnRecord, state: EnnoOdunoState) => Promise<{ readonly phase: DshAdvisoryRoundResult['phase']; readonly contributions: DshAdvisoryRoundResult['contributions'] } | undefined>
  readonly applyPolicy: ReturnType<typeof import('./turn-state.js').createTurnState>['applyPolicy']
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<DshCapabilityCatalog>
  readonly closeTurn: DshRunLifecycle['closeTurn']
  readonly sessionEventSource: (session: object | undefined) => DshSessionEventSource
  readonly boundedUtf8Text: (value: string, bytes: number) => string
  readonly boundedMessageText: (value: unknown) => string | undefined
  readonly recoveryMessage: (id: string, answer: string) => unknown
  readonly continuationMessage: (id: string, nextAction: EnnoNextAction) => unknown
}

export function createBoundaries(deps: BoundaryDependencies) {
  const { ctx, runtime, now, agents, sessions, skills, tools, userQuestions, gate, delegation, executionSupport,
    answerReview, sessionMirror, currentSession, currentForAgentEvent, stateForRun, systemSkillsFor,
    refreshEnnoMemory, confirmationAnswerer, assertTurnBoundary, advisoryRunner, submitAdvisory,
    advisoryEvidenceFor, applyPolicy, capabilityCatalog, closeTurn, sessionEventSource,
    boundedUtf8Text, boundedMessageText, recoveryMessage, continuationMessage } = deps
  const getSkillPrompts = deps.getSkillPrompts
  const boundaryAgents = new Map<string, object>()
  const boundarySignals = new Map<string, AbortSignal>()
  const boundaryEvent = (item: TurnRecord, signal = boundarySignals.get(item.sessionId) ?? new AbortController().signal) => ({
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
  const askForRecoveryInstruction = async (input: {
    readonly item: TurnRecord
    readonly questionId: string
    readonly title: string
    readonly detail: string
    readonly header?: string
  }): Promise<string | undefined> => {
    const agent = input.item.nativeAgent ?? agents?.get(input.item.agentId)
    const signal = boundarySignals.get(input.item.sessionId) ?? new AbortController().signal
    if (userQuestions === undefined || agent === undefined) return undefined
    try {
      const result = await abortable(userQuestions.ask({
        questions: [{
          id: input.questionId,
          header: input.header ?? 'Kiokuko stopped',
          question: input.title,
          detail: input.detail,
        }],
        agent,
        signal,
      }), signal)
      signal.throwIfAborted()
      const answer = result.answers[0]
      if (answer === undefined || answer.id !== input.questionId) return undefined
      const value = answer.custom?.trim() || answer.selected[0]?.trim()
      return value === undefined || value.length === 0 ? undefined : boundedUtf8Text(value, 8 * 1024)
    } catch {
      signal.throwIfAborted()
      // A broken/dismissed question surface must never become another retry
      // loop. The durable waiting_user state remains the recovery boundary.
      return undefined
    }
  }
  const loopRecoveryDetail = (snapshot: ReturnType<typeof readEnnoSnapshot>, state: EnnoOdunoState, reason: string, recoveryInstruction?: string): string => {
    const workUnitId = state.directive?.workUnit?.id ?? null
    const workUnit = workUnitId === null
      ? null
      : snapshot.workUnits.find((candidate) => candidate.workUnit.id === workUnitId) ?? null
    const latestVerifier = snapshot.finalEvidence.at(-1)
    return [
      `Host status: phase=${snapshot.status}; nextAction=${state.nextAction}; role=${state.currentRole ?? 'none'}.`,
      `Revision=${snapshot.revision}; mutationRevision=${snapshot.mutationRevision}; attempts=${snapshot.attempts}/${snapshot.contract.maxAttempts}.`,
      workUnit === null
        ? 'WorkUnit: none.'
        : `WorkUnit ${workUnit.workUnit.id}: ${workUnit.workUnit.objective} (status=${workUnit.status}, attempts=${workUnit.attemptCount}).`,
      latestVerifier === undefined
        ? 'Latest verifier: none.'
        : `Latest verifier ${latestVerifier.verifier.id}: ${latestVerifier.status}.`,
      reason,
      recoveryInstruction ?? 'Enter the actual current handling status and the concrete instruction to execute next. If work should stop, say so explicitly.',
    ].join('\n')
  }
  const guardBoundaryEffect = async (item: TurnRecord, job: DshBoundaryJob): Promise<boolean> => {
    const guarded = await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      const snapshot = readEnnoSnapshot(database, {
        runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
      })
      const state = stateForSnapshot(snapshot)
      const claim = claimBoundaryEffectInTransaction(
        database,
        job,
        ennoInstructionDigest(snapshot, state.directive),
        now?.() ?? new Date().toISOString(),
      )
      return { snapshot, state, claim }
    }))
    if (guarded.claim.decision === 'deliver') return true
    const answer = await askForRecoveryInstruction({
      item,
      questionId: `effect-${job.jobId.slice(0, 16)}`,
      title: 'Kiokuko stopped before a fourth stateful boundary operation without progress.',
      detail: loopRecoveryDetail(
        guarded.snapshot,
        guarded.state,
        `${job.kind} completed or was re-entered three times without authoritative Enno progress.`,
      ),
    })
    if (answer === undefined) {
      await sessionMirror.markWaitingUser(item.sessionId)
      return false
    }
    await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      resetBoundaryEffectGuardInTransaction(database, job, now?.() ?? new Date().toISOString())
      resetLoopGuardForUserInTransaction(database, {
        runId: item.runId,
        dshSessionId: item.sessionId,
        resolution: 'manual_user',
        ...(now === undefined ? {} : { now: now() }),
      })
    }))
    return true
  }
  const confirmBoundary = async (item: TurnRecord, state: EnnoOdunoState): Promise<'submitted' | 'dismissed'> => {
    const originalConfirmation = state.directive?.userFacingConfirmation
    const conditions = executionSupport.confirmation(item.sessionId, state.contractRevision ?? 0)
    const confirmation = originalConfirmation === undefined ? undefined : {
      ...originalConfirmation, ...(conditions.length ? { executionConditions: conditions } : {}),
    }
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
        event.signal.throwIfAborted()
        response = await runtime.withDatabase((database) => answerEnno(database, {
          runId: item.runId,
          workspace: item.workspace,
          orchestrationId: item.orchestrationId,
          expectedRevision: answer.expectedRevision,
          idempotencyKey: `dsh-confirm:${canonicalContentHash({ runId: item.runId, revision: answer.expectedRevision, action: answer.action, requestedChanges: answer.requestedChanges ?? null })}`,
          action: answer.action,
          ...(answer.requestedChanges === undefined ? {} : { requestedChanges: answer.requestedChanges }),
        }))
        if (answer.action === 'approve') await executionSupport.approve(item.sessionId, answer.expectedRevision)
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
    applyPolicy(item.runId, next)
    return 'submitted'
  }
  const injectBoundaryContext = async (item: TurnRecord, state: EnnoOdunoState): Promise<void> => {
    const event = boundaryEvent(item)
    await assertTurnBoundary(event)
    if (state.directive === null) throw new Error('kiokuko-dsh boundary context has no directive')
    await refreshEnnoMemory(item, event.signal)
    const selection = selectDshDirectiveSources(state.directive)
    const exactNativeAgent = item.nativeAgent as { readonly inject?: (message: unknown) => void } | undefined
    const agent = exactNativeAgent === undefined ? agents?.get(item.agentId) : exactNativeAgent
    if (agent?.inject === undefined) throw new Error('kiokuko-dsh native agent injection is unavailable')
    const projectedDirective = projectDshDirective({ nextAction: state.nextAction, directive: state.directive })
    const advisoryEvidence = await advisoryEvidenceFor(item, state)
    const messages = await injectDshContext({
      skillPrompts: getSkillPrompts(),
      systemSkillNames: systemSkillsFor(item.nativeAgent ?? agent ?? {}) ?? new Set(),
      prepared: item.prepared,
      task: item.task,
      routeSkillNames: selection.routeSkillNames,
      expertRefs: selection.expertRefs,
      ...(projectedDirective === null ? {} : { directive: projectedDirective }),
      ...(advisoryEvidence === undefined ? {} : { advisoryEvidence }),
      runtime,
      soulInSystemPrompt: ctx.get('systemPrompt', false) !== undefined,
      userTaskInConversation: true,
    })
    event.signal.throwIfAborted()
    const pending = (agent as { readonly inbox?: { readonly nextStep?: readonly unknown[] } }).inbox?.nextStep ?? []
    refreshDshSkillSnapshots(messages, sessionEventSource(item.nativeSession), systemSkillsFor(item.nativeAgent ?? agent ?? {}))
    for (const message of projectDshContext(messages, sessionEventSource(item.nativeSession), pending)) {
      agent.inject(message)
    }
  }
  const runFinalVerificationBoundary = async (item: TurnRecord): Promise<void> => {
    await assertTurnBoundary(boundaryEvent(item))
    const state = await readBoundaryState(item)
    if (state.contractRevision === null) throw new Error('kiokuko-dsh verification revision is unavailable')
    const response = await runtime.withDatabase((database) => {
      const snapshot = readEnnoSnapshot(database, {
        runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
      })
      return prepareEnnoVerification(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
        expectedRevision: snapshot.revision,
        idempotencyKey: verificationBoundaryKey(snapshot),
      })
    })
    item.prepared = { ...item.prepared, ennoOduno: response.ennoOduno }
    const next = policyState(response.ennoOduno, item, item.sessionId)
    applyPolicy(item.runId, next)
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
    requestLoopRecovery: async ({ event, state, automaticCount }) => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) return undefined
      const snapshot = await runtime.withDatabase((database) => readEnnoSnapshot(database, {
        runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
      }))
      const answer = await askForRecoveryInstruction({
        item,
        questionId: `legacy-loop-${item.runId.slice(0, 12)}`,
        title: 'Kiokuko stopped before a fourth identical automatic continuation.',
        detail: loopRecoveryDetail(
          snapshot,
          state,
          `The legacy turn controller continued the same instruction ${automaticCount} times without authoritative Enno progress.`,
        ),
      })
      if (answer === undefined) await sessionMirror.markWaitingUser(item.sessionId)
      return answer
    },
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
    ...(now === undefined ? {} : { now: now }),
    bindNativeAgent: (sessionId, nativeAgent) => {
      const item = currentSession(sessionId)
      if (item !== undefined && item.nativeAgent !== undefined && item.nativeAgent !== nativeAgent) {
        throw new Error('kiokuko-dsh boundary agent identity changed')
      }
      boundaryAgents.set(sessionId, nativeAgent)
    },
    process: async (job: DshBoundaryJob, signal) => {
      boundarySignals.set(job.dshSessionId, signal)
      const item = currentSession(job.dshSessionId)
      if (item === undefined || item.closed || item.runId !== job.runId || item.turn < job.nativeTurn) {
        throw new Error('kiokuko-dsh boundary job has no exact live run binding')
      }
      if ((job.kind === 'confirmation' || job.kind === 'final_verification' || job.kind === 'advisory')
        && !await guardBoundaryEffect(item, job)) {
        return { kind: 'waiting_user' }
      }
      if (job.kind.startsWith('retry_')) {
        return { kind: 'completed', nextKind: 'delivery' }
      }
      if (job.kind === 'ask_akinator') {
        const snapshot = await runtime.withDatabase((database) => readEnnoSnapshot(database, {
          runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
        }))
        const state = stateForSnapshot(snapshot)
        const pending = await runtime.withDatabase((database) => readPendingOutbox(database, item.sessionId)
          .find((candidate) => candidate.receiptId === job.receiptId))
        const validationFact = boundedMessageText(pending?.message)
        const answer = await askForRecoveryInstruction({
          item,
          questionId: `validation-${job.receiptId.slice(0, 16)}`,
          title: 'Kiokuko validation repeatedly failed and needs your instruction.',
          detail: loopRecoveryDetail(
            snapshot,
            state,
            validationFact ?? 'The same validation constraint was rejected repeatedly.',
          ),
        })
        if (answer === undefined) {
          await sessionMirror.markWaitingUser(item.sessionId)
          return { kind: 'waiting_user' }
        }
        await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          resetLoopGuardForUserInTransaction(database, {
            runId: item.runId,
            dshSessionId: item.sessionId,
            resolution: 'manual_user',
            ...(now === undefined ? {} : { now: now() }),
          })
          const outbox = readPendingOutbox(database, item.sessionId).find((candidate) => candidate.receiptId === job.receiptId)
          if (outbox !== undefined) {
            replacePendingOutboxMessageInTransaction(
              database,
              job.receiptId,
              recoveryMessage(outbox.continuationId, answer),
              'loop-recovery',
              now?.() ?? new Date().toISOString(),
            )
          }
        }))
        return { kind: 'completed', nextKind: 'delivery' }
      }
      if (job.kind === 'classify_boundary') {
        const state = await readBoundaryState(item)
        if (state.status === 'completed' || state.status === 'blocked' || state.status === 'cancelled'
          || state.nextAction === 'complete' || state.nextAction === 'report_blocker') {
          const hostTerminal = await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
            // Host-only verification can terminate without a model phase
            // receipt. Bind its report to the causal receipt before retiring
            // the continuation, so an idle session cannot hide the result.
            const seal = readTurnSeal(database, job.dshSessionId, job.nativeTurn)
            const needsReport = (state.status === 'blocked' || state.status === 'completed')
              && seal?.nextAction !== 'complete' && seal?.nextAction !== 'report_blocker'
            if (needsReport) {
              database.prepare(`INSERT OR IGNORE INTO dsh_completion_reports
                (run_id, receipt_id, dsh_session_id, native_turn) VALUES (?, ?, ?, ?)`)
                .run(job.runId, job.receiptId, job.dshSessionId, job.nativeTurn)
            }
            database.prepare(`UPDATE dsh_continuation_outbox SET status = 'superseded', updated_at = ? WHERE receipt_id = ? AND status IN ('pending', 'dispatched')`)
              .run(now?.() ?? new Date().toISOString(), job.receiptId)
            return needsReport
          }))
          if (hostTerminal) await deliverCompletionReport(item.nativeSession)
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
        const result = await advisoryRunner.run({ directive, signal })
        signal.throwIfAborted()
        await submitAdvisory(result, { event: boundaryEvent(item), state })
        return { kind: 'completed', nextKind: 'classify_boundary' }
      }
      if (job.kind === 'context') {
        const state = await readBoundaryState(item)
        await assertTurnBoundary(boundaryEvent(item))
        if (state.directive === null) throw new Error('kiokuko-dsh boundary context has no directive')
        // The worker can finish before the causal native turn ends. Injecting
        // next-step context here would reopen that sealed turn. The admitted
        // next turn projects its current directive, Skills and memory through
        // CapturingGate.preStep, after binding its new native turn identity.
        await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          const outbox = readPendingOutbox(database, item.sessionId).find((candidate) => candidate.receiptId === job.receiptId)
          if (outbox !== undefined) replacePendingOutboxMessageInTransaction(
            database,
            job.receiptId,
            continuationMessage(outbox.continuationId, state.nextAction),
            'continuation',
          )
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
    beforeDelivery: async (job, outbox, signal) => {
      boundarySignals.set(job.dshSessionId, signal)
      if (outbox.messageForm === 'loop-recovery') return 'deliver'
      const item = currentSession(job.dshSessionId)
      if (item === undefined || item.closed || item.runId !== job.runId) return 'superseded'
      if (executionSupport.paused(item.sessionId)) return 'waiting_user'
      const guarded = await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
        const snapshot = readEnnoSnapshot(database, {
          runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
        })
        const state = stateForSnapshot(snapshot)
        const claim = claimAutomaticContinuationInTransaction(database, {
          claimId: outbox.continuationId,
          runId: item.runId,
          dshSessionId: item.sessionId,
          instructionDigest: ennoInstructionDigest(snapshot, state.directive),
          ...(now === undefined ? {} : { now: now() }),
        })
        const shouldAsk = claim.decision === 'wait_user'
          && claimLoopRecoveryQuestionInTransaction(
            database,
            claim.claimId,
            now?.() ?? new Date().toISOString(),
          )
        return { snapshot, state, claim, shouldAsk }
      }))
      if (guarded.claim.decision === 'deliver') return 'deliver'
      if (!guarded.shouldAsk) {
        await sessionMirror.markWaitingUser(item.sessionId)
        return 'waiting_user'
      }
      const answer = await askForRecoveryInstruction({
        item,
        questionId: `loop-${guarded.claim.claimId.slice(0, 16)}`,
        title: 'Kiokuko stopped before a fourth identical automatic continuation.',
        detail: loopRecoveryDetail(
          guarded.snapshot,
          guarded.state,
          [
            `The same instruction was automatically continued ${guarded.claim.ordinal - 1} times without authoritative Enno progress.`,
            boundedMessageText(outbox.message),
          ].filter((value): value is string => value !== undefined).join('\n'),
        ),
      })
      if (answer === undefined) {
        await sessionMirror.markWaitingUser(item.sessionId)
        return 'waiting_user'
      }
      await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
        resetLoopGuardForUserInTransaction(database, {
          runId: item.runId,
          dshSessionId: item.sessionId,
          resolution: 'user_answer',
          claimId: guarded.claim.claimId,
          ...(now === undefined ? {} : { now: now() }),
        })
        replacePendingOutboxMessageInTransaction(
          database,
          job.receiptId,
          recoveryMessage(outbox.continuationId, answer),
          'loop-recovery',
          now?.() ?? new Date().toISOString(),
        )
      }))
      return 'deliver'
    },
    dispatch: async (job, outbox) => {
      const item = currentSession(job.dshSessionId)
      const nativeAgent = (boundaryAgents.get(job.dshSessionId) ?? agents?.get(job.dshSessionId)) as NativeAgent | undefined
      if ((item !== undefined && (item.closed || item.runId !== job.runId)) || nativeAgent?.followup === undefined) {
        throw new Error('kiokuko-dsh native boundary delivery agent is unavailable')
      }
      nativeAgent.followup(outbox.message)
    },
    onWaitingUser: async (job, error, signal) => {
      boundarySignals.set(job.dshSessionId, signal)
      const item = currentSession(job.dshSessionId)
      if (item === undefined || item.closed || item.runId !== job.runId) return false
      await sessionMirror.markWaitingUser(item.sessionId)
      const snapshot = await runtime.withDatabase((database) => readEnnoSnapshot(database, {
        runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId,
      }))
      const copy = boundaryFailureCopy(snapshot.userFacingLanguage)
      const answer = await askForRecoveryInstruction({
        item,
        questionId: `boundary-${job.jobId.slice(0, 16)}`,
        header: copy.header,
        title: copy.title,
        detail: loopRecoveryDetail(
          snapshot,
          stateForSnapshot(snapshot),
          `Last boundary error: ${(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
          copy.recoveryInstruction,
        ),
      })
      if (answer === undefined) return false
      await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
        resetLoopGuardForUserInTransaction(database, {
          runId: item.runId,
          dshSessionId: item.sessionId,
          resolution: 'manual_user',
          ...(now === undefined ? {} : { now: now() }),
        })
        const outbox = readPendingOutbox(database, item.sessionId).find((candidate) => candidate.receiptId === job.receiptId)
        if (outbox !== undefined) {
          replacePendingOutboxMessageInTransaction(
            database,
            job.receiptId,
            recoveryMessage(outbox.continuationId, answer),
            'loop-recovery',
            now?.() ?? new Date().toISOString(),
          )
        }
        database.prepare(`
          UPDATE dsh_boundary_jobs
             SET status = 'pending', attempt_count = 0, available_at = ?,
                 last_error_code = NULL, last_error_message = NULL, updated_at = ?
           WHERE job_id = ? AND status = 'waiting_user'
        `).run(now?.() ?? new Date().toISOString(), now?.() ?? new Date().toISOString(), job.jobId)
      }))
      return true
    },
  })

  const completionReporter = new DshCompletionReporter(runtime, async session => {
    if (sessions?.flush === undefined) throw new Error('Native report flush is unavailable')
    await sessions.flush(session)
  })
  const deliverCompletionReport = async (session: object | undefined): Promise<void> => {
    if (session !== undefined && typeof (session as { append?: unknown }).append === 'function') {
      await completionReporter.deliver(session as Parameters<DshCompletionReporter['deliver']>[0])
    }
  }
  const rehydrateBoundarySession = async (nativeAgent: NativeAgent): Promise<void> => {
    if (nativeAgent.session?.snapshotEvents && agents?.get(nativeAgent.id) === nativeAgent && sessions?.get(nativeAgent.session.id) === nativeAgent.session) await answerReview.recover(nativeAgent as ReviewAgent, async row => {
      await sessions?.flush?.(nativeAgent.session!)
      await sessionMirror.checkpointAfterNativeFlush(nativeAgent.session as DshMirrorEventSession)
      await closeTurn({ runId: row.runId, status: row.status, ...(row.endSeq === undefined ? {} : { sourceEndSeq: row.endSeq }) })
    })
    const nativeSession = nativeAgent.session ?? sessions?.get(nativeAgent.id)
    const sessionId = nativeSession?.id
    const cwd = nativeSession?.header?.cwd
    if (sessionId === undefined || cwd === undefined || typeof nativeSession?.snapshotEvents !== 'function') return
    if (nativeAgent.status === 'running') return
    await deliverCompletionReport(nativeSession)
    const terminal = await runtime.withDatabase(database => database.prepare(`
      SELECT report.run_id AS runId, report.native_turn AS nativeTurn, contract.status
      FROM dsh_completion_reports AS report JOIN ledger_runs AS run ON run.run_id = report.run_id
      JOIN enno_contracts AS contract ON contract.run_id = report.run_id
      WHERE report.dsh_session_id = ? AND report.status = 'delivered' AND run.status = 'active'
        AND contract.status IN ('completed', 'blocked', 'cancelled')
    `).all<{ runId: string; nativeTurn: number; status: string }>(sessionId))
    for (const restored of terminal) {
      if (currentSession(sessionId)?.runId === restored.runId) continue
      const end = dshTurnBoundarySeq(nativeSession as DshSessionEventSource, restored.nativeTurn, 'end')
      if (end === undefined) continue
      await closeTurn({ runId: restored.runId,
        status: restored.status === 'completed' ? 'completed' : restored.status === 'cancelled' ? 'cancelled' : 'failed',
        sourceEndSeq: end,
      })
    }
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
  const boundarySessionStartDisposer = onNativeEvent(ctx, 'agent/session-start', (payload: { agent: NativeAgent }) => {
    if (delegation.isChild(payload.agent)) return
    void rehydrateBoundarySession(payload.agent).catch(() => {
      // Durable jobs remain retryable. A later pre-step/status kick retries
      // once the exact live Agent and its capabilities are available.
    })
  })
  for (const nativeAgent of agents?.list?.() ?? []) {
    void rehydrateBoundarySession(nativeAgent).catch(() => undefined)
  }

  return {
    boundaryWorker,
    ennoController,
    deliverCompletionReport,
    boundarySessionStartDisposer,
    clear: () => { boundaryAgents.clear(); boundarySignals.clear() },
  }
}
