import type { Context } from '@deepseek-ai/cordis'
import type { DshCoreRuntime } from '../core-runtime.js'
import { onNativeEvent } from './native-events.js'
import type { NativeAgent, NativeAgents, NativeSessions, NativeSkills, NativeTools } from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { DshUserQuestions } from '../user-interaction.js'
import type { DshIntakeGate, DshCapabilityReadContext } from '../intake-gate.js'
import type { DshExecutionSupport } from '../execution-support.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { ReviewAgent } from '../answer-review/contracts.js'
import type { DshSessionLogMirror, DshMirrorEventSession } from '../session-log-mirror.js'
import type { DshRunLifecycle } from '../session-bridge.js'
import { dshTurnBoundarySeq, type DshSessionEventSource } from '../session-memory-finalizer.js'
import { abortable, DshBoundaryWorker } from '../boundary-worker.js'
import { DshCompletionReporter } from '../completion-report.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { projectDshContext } from '../context-projection.js'
import { readPendingOutbox, replacePendingOutboxMessageInTransaction, retryableBoundaryErrorCode, type DshBoundaryJob } from '../turn-process.js'
import { claimAutomaticContinuationInTransaction, claimLoopRecoveryQuestionInTransaction, resetLoopGuardForUserInTransaction } from '../loop-guard.js'
import { boundaryFailureCopy } from '../user-interaction.js'
import { KiokukoError } from '../../errors.js'
import { isNativeSubagent } from '../native-subagent.js'

interface BoundaryDependencies {
  readonly isGenericNativeChild: (agent: NativeAgent) => boolean
  readonly ctx: Context
  readonly runtime: DshCoreRuntime
  readonly now: (() => string) | undefined
  readonly agents: NativeAgents | undefined
  readonly sessions: NativeSessions | undefined
  readonly skills: NativeSkills | undefined
  readonly tools: NativeTools | undefined
  readonly userQuestions: DshUserQuestions | undefined
  readonly gate: DshIntakeGate
  readonly executionSupport: DshExecutionSupport
  readonly answerReview: AnswerReviewCoordinator
  readonly sessionMirror: DshSessionLogMirror
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<unknown>
  readonly closeTurn: DshRunLifecycle['closeTurn']
  readonly sessionEventSource: (session: object | undefined) => DshSessionEventSource
  readonly boundedUtf8Text: (value: string, bytes: number) => string
  readonly boundedMessageText: (value: unknown) => string | undefined
  readonly recoveryMessage: (id: string, answer: string) => unknown
}

export function createBoundaries(deps: BoundaryDependencies) {
  const { isGenericNativeChild } = deps
  const { ctx, runtime, now, agents, sessions, skills, tools, userQuestions, gate, executionSupport,
    answerReview, sessionMirror, currentSession,
    capabilityCatalog, closeTurn, sessionEventSource,
    boundedUtf8Text, boundedMessageText, recoveryMessage } = deps
  const boundaryAgents = new Map<string, object>()
  const boundarySignals = new Map<string, AbortSignal>()

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
  const recoveryDetail = (reason: string, recoveryInstruction?: string): string => [
    reason,
    recoveryInstruction ?? 'Enter the actual current handling status and the concrete instruction to execute next. If work should stop, say so explicitly.',
  ].join('\n')

  const boundaryWorker = new DshBoundaryWorker({
    runtime,
    shouldProcessSession: sessionId => {
      const agent = (boundaryAgents.get(sessionId) ?? agents?.get(sessionId)) as NativeAgent | undefined
      if (agent !== undefined) return !isGenericNativeChild(agent)
      const session = sessions?.get(sessionId)
      return session === undefined || !isNativeSubagent({ session })
    },
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
      if (item?.closed || item?.runId !== undefined && item.runId !== job.runId) return { kind: 'superseded' }
      if (item === undefined || item.turn < job.nativeTurn) throw Object.assign(
        new Error('kiokuko-dsh boundary job is waiting for its exact live run binding'),
        { code: 'BOUNDARY_BINDING_UNAVAILABLE' })
      if (job.kind.startsWith('retry_')) {
        return { kind: 'completed', nextKind: 'delivery' }
      }
      if (job.kind === 'ask_akinator') {
        const pending = await runtime.withDatabase((database) => readPendingOutbox(database, item.sessionId)
          .find((candidate) => candidate.receiptId === job.receiptId))
        const validationFact = boundedMessageText(pending?.message)
        const answer = await askForRecoveryInstruction({
          item,
          questionId: `validation-${job.receiptId.slice(0, 16)}`,
          title: 'Kiokuko validation repeatedly failed and needs your instruction.',
          detail: recoveryDetail(validationFact ?? 'The same validation constraint was rejected repeatedly.'),
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
      if (job.kind === 'classify_boundary' || job.kind === 'confirmation' || job.kind === 'final_verification' || job.kind === 'advisory') {
        // Orchestration removed: these durable kinds have no producer anymore.
        // Supersede their causal outbox so an idle session cannot replay them.
        await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          database.prepare(`UPDATE dsh_continuation_outbox SET status = 'superseded', updated_at = ? WHERE receipt_id = ? AND status IN ('pending', 'dispatched')`)
            .run(now?.() ?? new Date().toISOString(), job.receiptId)
        }))
        return { kind: 'superseded' }
      }
      if (job.kind === 'context') {
        await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          database.prepare(`UPDATE dsh_continuation_outbox SET status = 'superseded', updated_at = ? WHERE receipt_id = ? AND status IN ('pending', 'dispatched')`)
            .run(now?.() ?? new Date().toISOString(), job.receiptId)
        }))
        return { kind: 'superseded' }
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
      const item = currentSession(job.dshSessionId)
      if (item === undefined) throw Object.assign(
        new Error('kiokuko-dsh delivery is waiting for its exact live run binding'),
        { code: 'BOUNDARY_BINDING_UNAVAILABLE' })
      if (item.closed || item.runId !== job.runId) return 'superseded'
      if (outbox.messageForm === 'loop-recovery') return 'deliver'
      if (executionSupport.paused(item.sessionId)) return 'waiting_user'
      const guarded = await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
        const claim = claimAutomaticContinuationInTransaction(database, {
          claimId: outbox.continuationId,
          runId: item.runId,
          dshSessionId: item.sessionId,
          instructionDigest: canonicalContentHash(boundedMessageText(outbox.message) ?? 'continuation'),
          ...(now === undefined ? {} : { now: now() }),
        })
        const shouldAsk = claim.decision === 'wait_user'
          && claimLoopRecoveryQuestionInTransaction(
            database,
            claim.claimId,
            now?.() ?? new Date().toISOString(),
          )
        return { claim, shouldAsk }
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
        detail: recoveryDetail([
          `The same instruction was automatically continued ${guarded.claim.ordinal - 1} times without progress.`,
          boundedMessageText(outbox.message),
        ].filter((value): value is string => value !== undefined).join('\n')),
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
      if (!item || item.closed || item.runId !== job.runId || nativeAgent?.session?.id !== job.dshSessionId
        || item.nativeAgent !== undefined && item.nativeAgent !== nativeAgent || nativeAgent?.followup === undefined) {
        throw new KiokukoError('CONFLICT', 'kiokuko-dsh native boundary delivery has no exact live run and agent binding')
      }
      nativeAgent.followup(outbox.message)
    },
    onWaitingUser: async (job, error, signal) => {
      boundarySignals.set(job.dshSessionId, signal)
      const item = currentSession(job.dshSessionId)
      if (item === undefined || item.closed || item.runId !== job.runId) return false
      await sessionMirror.markWaitingUser(item.sessionId)
      const failureCode = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code : 'BOUNDARY_JOB_FAILED'
      const retryable = retryableBoundaryErrorCode(failureCode)
      const copy = boundaryFailureCopy(undefined, job.attemptCount, retryable)
      const answer = await askForRecoveryInstruction({
        item,
        questionId: `boundary-${job.jobId.slice(0, 16)}`,
        header: copy.header,
        title: copy.title,
        detail: recoveryDetail(
          `Last boundary error: ${(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
          copy.recoveryInstruction,
        ),
      })
      if (answer === undefined) return false
      // A user message cannot repair an integrity/permission fault or make an
      // unsupported stage executable. Only a named transient may be retried.
      if (!retryable || !/(?:retry|recovered|再試行|解消|修復)/iu.test(answer)) return false
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
           WHERE job_id = ? AND status = 'waiting_user' AND last_error_code = ?
        `).run(now?.() ?? new Date().toISOString(), now?.() ?? new Date().toISOString(), job.jobId, failureCode)
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
    if (isGenericNativeChild(nativeAgent)) return
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
      SELECT report.run_id AS runId, report.native_turn AS nativeTurn, run.status
      FROM dsh_completion_reports AS report JOIN ledger_runs AS run ON run.run_id = report.run_id
      WHERE report.dsh_session_id = ? AND report.status = 'delivered' AND run.status = 'active'
    `).all<{ runId: string; nativeTurn: number; status: string }>(sessionId))
    for (const restored of terminal) {
      if (currentSession(sessionId)?.runId === restored.runId) continue
      const end = dshTurnBoundarySeq(nativeSession as DshSessionEventSource, restored.nativeTurn, 'end')
      if (end === undefined) continue
      await closeTurn({ runId: restored.runId, status: 'completed', sourceEndSeq: end })
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
    } as never)
    await gate.prepare({
      agent: { id: nativeAgent.id }, nativeAgent, sessionId, nativeSession,
      turn: first.nativeTurn, step: 1, task: first.task, cwd, capabilities: catalog,
      sourceStartSeq: dshTurnBoundarySeq(nativeSession as DshSessionEventSource, first.nativeTurn, 'start'),
      signal: new AbortController().signal,
    } as never)
    boundaryWorker.kick(sessionId, nativeAgent)
  }
  const boundarySessionStartDisposer = onNativeEvent(ctx, 'agent/session-start', (payload: { agent: NativeAgent }) => {
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
    deliverCompletionReport,
    boundarySessionStartDisposer,
    clear: () => { boundaryAgents.clear(); boundarySignals.clear() },
  }
}
