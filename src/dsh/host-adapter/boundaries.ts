import type { Context } from '@deepseek-ai/cordis'
import type { DshCoreRuntime } from '../core-runtime.js'
import { onNativeEvent } from './native-events.js'
import type { NativeAgent, NativeAgents, NativeSessions, NativeSkills, NativeTools } from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import type { DshSkillPrompts } from '../skill-prompts.js'
import type { DshIntakeGate, DshCapabilityReadContext } from '../intake-gate.js'
import type { DshExecutionSupport } from '../execution-support.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { ReviewAgent } from '../answer-review/contracts.js'
import type { DshSessionLogMirror, DshMirrorEventSession } from '../session-log-mirror.js'
import type { DshRunLifecycle } from '../session-bridge.js'
import { dshTurnBoundarySeq, type DshSessionEventSource } from '../session-memory-finalizer.js'
import { DshBoundaryWorker } from '../boundary-worker.js'
import { DshCompletionReporter } from '../completion-report.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { projectDshContext } from '../context-projection.js'
import { replacePendingOutboxMessageInTransaction, type DshBoundaryJob } from '../turn-process.js'
import { claimAutomaticContinuationInTransaction } from '../loop-guard.js'
import { continuationMessage, continuationProgress } from '../continuation-evidence.js'
import { assessTaskCompletion } from '../task-completion.js'
import { saveSessionNotice } from '../plugin-records.js'
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
  readonly gate: DshIntakeGate
  readonly executionSupport: DshExecutionSupport
  readonly answerReview: AnswerReviewCoordinator
  readonly sessionMirror: DshSessionLogMirror
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<unknown>
  readonly closeTurn: DshRunLifecycle['closeTurn']
  readonly sessionEventSource: (session: object | undefined) => DshSessionEventSource
}

export function createBoundaries(deps: BoundaryDependencies) {
  const { isGenericNativeChild } = deps
  const { ctx, runtime, now, agents, sessions, skills, tools, gate, executionSupport,
    answerReview, sessionMirror, currentSession,
    capabilityCatalog, closeTurn, sessionEventSource } = deps
  const boundaryAgents = new Map<string, object>()
  const reportBlocked = (item: TurnRecord, id: string, reason: string) =>
    runtime.withDatabase(database => saveSessionNotice(database, {
      id: `continuation-blocked:${id}`,
      runId: item.runId,
      sessionId: item.sessionId,
      rootPath: item.cwd,
      kind: 'status',
      text: reason,
      anchorSeq: 0,
    }))

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
    process: async (job: DshBoundaryJob) => {
      const item = currentSession(job.dshSessionId)
      if (item?.closed || item?.runId !== undefined && item.runId !== job.runId) return { kind: 'superseded' }
      if (item === undefined || item.turn < job.nativeTurn) throw Object.assign(
        new Error('kiokuko-dsh boundary job is waiting for its exact live run binding'),
        { code: 'BOUNDARY_BINDING_UNAVAILABLE' })
      if (job.kind.startsWith('retry_')) {
        return { kind: 'completed', nextKind: 'delivery' }
      }
      if (job.kind === 'ask_akinator') {
        await reportBlocked(item, job.jobId, 'The previous continuation could not pass validation. The affected operation remains pending.')
        return { kind: 'blocked' }
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
    beforeDelivery: async (job, outbox) => {
      const item = currentSession(job.dshSessionId)
      if (item === undefined) throw Object.assign(
        new Error('kiokuko-dsh delivery is waiting for its exact live run binding'),
        { code: 'BOUNDARY_BINDING_UNAVAILABLE' })
      if (item.closed || item.runId !== job.runId) return 'superseded'
      if (executionSupport.paused(item.sessionId)) return 'waiting_user'
      if (outbox.messageForm === 'loop-recovery') return 'deliver'
      const decision = await runtime.withDatabase(database => withImmediateTransaction(database, () => {
        const assessment = assessTaskCompletion(database, item.runId)
        if (assessment.managedOperationsReady === false || assessment.nativeChildrenPending) return 'blocked'
        const claim = claimAutomaticContinuationInTransaction(database, {
          claimId: canonicalContentHash({ policy: 2, id: outbox.continuationId }),
          runId: item.runId,
          dshSessionId: item.sessionId,
          instructionDigest: canonicalContentHash(outbox.message),
          progressDigest: continuationProgress(database, item.runId, item.repositoryRoot, assessment),
          ...(now === undefined ? {} : { now: now() }),
        })
        if (claim.decision === 'replan') {
          replacePendingOutboxMessageInTransaction(database, job.receiptId,
            continuationMessage(outbox.continuationId, 'The previous continuation did not change the observed result. Inspect the current evidence and try a different authorized approach. Report what remains incomplete if no independent work is possible.'),
            'continuation', now?.() ?? new Date().toISOString())
        }
        return claim.decision
      }))
      if (decision === 'deliver' || decision === 'replan') return 'deliver'
      if (decision === 'blocked')
        await reportBlocked(item, job.jobId, 'Automatic continuation is pending because the observed result did not change or an earlier operation is unsettled.')
      return decision === 'wait_user' ? 'waiting_user' : decision
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
    onBlocked: async (job, error) => {
      const item = currentSession(job.dshSessionId)
      if (item === undefined || item.closed || item.runId !== job.runId) return false
      const reason = error instanceof Error ? error.message : String(error)
      await reportBlocked(item, job.jobId, `Continuation delivery is pending. ${reason.slice(0, 2000)}`)
      return false
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
    clear: () => boundaryAgents.clear(),
  }
}
