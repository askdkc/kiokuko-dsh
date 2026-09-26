import type { DshCoreRuntime } from '../core-runtime.js'
import type { NativeAgent, NativeSessions } from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import type { createTurnState } from './turn-state.js'
import type { DshSessionLogMirror, DshMirrorEventSession } from '../session-log-mirror.js'
import type { DshMemoryFinalizer, DshSessionEventSource } from '../session-memory-finalizer.js'
import { dshTurnBoundarySeq } from '../session-memory-finalizer.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { ReviewAgent } from '../answer-review/contracts.js'
import type { AutoMemoryReviewCoordinator, ReviewNativeSession } from '../auto-memory-review.js'
import type { DshEnnoController } from '../enno-controller.js'
import type { DshEnnoMemoryRefresh } from '../enno-memory-refresh.js'
import type { DshExecutionSupport } from '../execution-support.js'
import type { DshIntakeGate } from '../intake-gate.js'
import type { StoredExecutionSelection } from '../execution-selection.js'
import type { EnnoOdunoState } from '../../enno-oduno/types.js'
import type { MemoryEvolutionConfig } from '../../memory/evolution/contracts.js'
import { memoryApplicationStatus } from '../../memory/application.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { LedgerStore } from '../../ledger/store.js'
import { terminalizeLedgerRunInTransaction } from '../../enno-oduno/store.js'
import { handoffReview } from '../../memory/review/store.js'
import { KiokukoError } from '../../errors.js'
import { DshRunLifecycle, type DshCloseIntent, type DshRunClose } from '../session-bridge.js'

interface LifecycleDependencies {
  readonly runtime: DshCoreRuntime
  readonly sessions: NativeSessions | undefined
  readonly sessionMirror: DshSessionLogMirror
  readonly memoryFinalizer: DshMemoryFinalizer
  readonly autoReview: AutoMemoryReviewCoordinator
  readonly answerReview: AnswerReviewCoordinator
  readonly ennoController: DshEnnoController
  readonly ennoMemory: DshEnnoMemoryRefresh
  readonly executionSupport: DshExecutionSupport
  readonly gate: DshIntakeGate
  readonly turnState: ReturnType<typeof createTurnState>
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly currentForAgentEvent: (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object) => TurnRecord | undefined
  readonly stateForRun: (database: any, item: TurnRecord) => EnnoOdunoState
  readonly deliverCompletionReport: (session: object | undefined) => Promise<void>
  readonly reviewBinding: (item: TurnRecord, session: object) => { workspace: string; runId: string; session: ReviewNativeSession; startSeq: number }
  readonly evolutionConfig: import('zod').z.infer<typeof MemoryEvolutionConfig>
  readonly clearToolRun: (runId: string) => void
  readonly sessionEventSource: (session: object | undefined) => DshSessionEventSource
}

export function createLifecycle(deps: LifecycleDependencies) {
  const { runtime, sessions, sessionMirror, memoryFinalizer, autoReview, answerReview, ennoController,
    ennoMemory, executionSupport, gate, turnState, currentSession, currentForAgentEvent,
    stateForRun, deliverCompletionReport, reviewBinding, evolutionConfig, clearToolRun,
    sessionEventSource } = deps
  const getSelection = deps.getSelection
  const resolveIdleClose = async (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object): Promise<DshCloseIntent | undefined> => {
    await deliverCompletionReport(nativeSession)
    const item = currentForAgentEvent(agentId, sessionId, undefined, nativeSession, nativeAgent)
    if (item === undefined || item.closed || executionSupport.paused(item.sessionId)) return undefined
    if (nativeAgent && answerReview.hold(nativeAgent as ReviewAgent)) return undefined
    const selection = getSelection(item.runId)?.value
    if (selection?.discussion) return undefined
    if (selection && (selection.status !== 'ready' && item.prepared.intake.profile.taskType !== 'chat' || item.failed && selection.mode === 'normal')) return undefined
    const state = await runtime.withDatabase((database) => stateForRun(database, item))
    if (state.status === 'cancelled') return { runId: item.runId, status: 'cancelled' }
    if (state.status === 'blocked' || state.nextAction === 'report_blocker') return { runId: item.runId, status: 'failed', terminalTurn: item.turn }
    // A chat run spans the quiet time between user messages. Enno's
    // inapplicable `complete` means that no orchestration is required for this
    // turn; it does not mean that the persistent conversation has ended.
    if (item.prepared.intake.profile.taskType === 'chat') return undefined
    if (state.status === 'completed' || state.nextAction === 'complete') {
      // A provider failure while wording the final response cannot undo
      // already verified completion. The durable host report covers it.
      return { runId: item.runId, status: 'completed', terminalTurn: item.turn }
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
    answerReview.cancel(sessionId)
    const item = currentSession(sessionId)
    if (item === undefined || item.closed || item.nativeSession !== nativeSession) return undefined
    if (executionSupport.paused(item.sessionId) || getSelection(item.runId)?.value.status !== undefined && getSelection(item.runId)?.value.status !== 'ready') {
      const end=await sessionMirror.latestEvent(sessionId,'turn/end',Number.MAX_SAFE_INTEGER)
      if(end)autoReview.notify(reviewBinding(item,nativeSession as ReviewNativeSession),end.seq,'boundary')
      return undefined
    }
    const state = await runtime.withDatabase((database) => stateForRun(database, item))
    if (state.status === 'completed') {
      await deliverCompletionReport(nativeSession)
      return { runId: item.runId, status: 'completed', terminalTurn: item.turn }
    }
    if (item.failed) return { runId: item.runId, status: 'failed', terminalTurn: item.turn }
    if (state.status === 'cancelled') return { runId: item.runId, status: 'cancelled' }
    if (state.status === 'blocked' || state.nextAction === 'report_blocker') return { runId: item.runId, status: 'failed', terminalTurn: item.turn }
    if (item.prepared.intake.profile.taskType === 'chat' || state.nextAction === 'complete') {
      return { runId: item.runId, status: 'completed', terminalTurn: item.turn }
    }
    return { runId: item.runId, status: 'cancelled' }
  }
  const closeRun = async (input: DshRunClose): Promise<void> => {
    if (input.status === 'completed' && !await runtime.withDatabase(db => memoryApplicationStatus(db, input.runId).ready)) input = { ...input, status: 'failed' }
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
      const failedExtractable = input.status === 'failed' && evolutionConfig.mode !== 'off' && input.sourceEndSeq !== undefined &&
        database.prepare('SELECT 1 FROM dsh_run_log_boundaries WHERE run_id=? AND workspace=? AND dsh_session_id=?').get(before.runId, before.workspace, before.dshSessionId) !== undefined
      if (input.status === 'failed' && !failedExtractable) database.prepare('INSERT OR IGNORE INTO memory_evolution_skips(run_id,workspace,reason) VALUES(?,?,?)')
        .run(before.runId, before.workspace, evolutionConfig.mode === 'off' ? 'disabled' : 'missing_log_boundary')
      if (input.status === 'completed' || failedExtractable) {
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
      handoffReview(database,input.runId,input.status)
    }))
    autoReview.worker.abort(input.runId)
    if (scheduled) {
      if (scheduledSessionId === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Completed run has no DSH session identity')
      await sessionMirror.markUnfinalized(scheduledSessionId)
      memoryFinalizer.kick()
    }
    const items = turnState.allTurns().filter((candidate) => candidate.runId === input.runId)
    for (const item of items) {
      ennoController.retire({
        ...(item.nativeAgent === undefined ? {} : { nativeAgent: item.nativeAgent }),
        ...(item.nativeSession === undefined ? {} : { nativeSession: item.nativeSession }),
      })
      if (item.nativeAgent) await answerReview.finish(item.nativeAgent as ReviewAgent)
      item.closed = true
      ennoMemory.clear(item.runId)
      executionSupport.clear(item.sessionId)
      gate.clearTurn(item.sessionId, item.turn)
    }
    turnState.releaseRun(input.runId)
    clearToolRun(input.runId)
  }
  const runLifecycle = new DshRunLifecycle({ closeRun })
  const failedBoundary = async (item: TurnRecord): Promise<{ sourceEndSeq?: number }> => {
    try {
      if (item.nativeSession === undefined || sessions?.flush === undefined) return {}
      await sessions.flush(item.nativeSession)
      await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession)
      return { sourceEndSeq: dshTurnBoundarySeq(sessionEventSource(item.nativeSession), item.turn, 'end') }
    } catch { return {} }
  }
  const retireSupersededRun = async (item: TurnRecord, status: 'completed' | 'failed' | 'cancelled'): Promise<void> => {
    if (status !== 'completed') {
      await runLifecycle.closeTurn({ runId: item.runId, status, ...(status === 'failed' ? await failedBoundary(item) : {}) })
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

  const closeRemainingRuns = async (pausedSessions: ReadonlySet<string>): Promise<unknown[]> => {
    const failures: unknown[] = []
  const remainingRuns = [...new Map(
    turnState.allTurns()
      .filter((item) => !item.closed && !pausedSessions.has(item.sessionId))
      .map((item) => [item.runId, item]),
  ).values()]
  for (const item of remainingRuns) {
    try {
      const selected = getSelection(item.runId)?.value
      if (selected) {
        const state = await runtime.withDatabase(db => stateForRun(db, item))
        if (selected.status !== 'ready'
          || selected.mode === 'enno' && !['completed', 'blocked', 'cancelled'].includes(state.status ?? '')
          || selected.mode === 'normal' && (item.failed || (item.nativeAgent as NativeAgent | undefined)?.status === 'running')) continue
      }
      let status: 'completed' | 'failed' | 'cancelled'
      if (item.prepared.intake.profile.taskType === 'chat') status = item.failed ? 'failed' : 'cancelled'
      else {
        const state = await runtime.withDatabase((database) => stateForRun(database, item))
        status = state.status === 'completed' || state.nextAction === 'complete'
          ? 'completed'
          : item.failed || state.status === 'blocked' || state.nextAction === 'report_blocker'
            ? 'failed'
            : 'cancelled'
      }
      if (status === 'completed') {
        await deliverCompletionReport(item.nativeSession)
        if (item.nativeSession === undefined || sessions?.flush === undefined) {
          throw new KiokukoError('CONFLICT', 'Completed DSH run requires its exact native session checkpoint')
        }
        await sessions.flush(item.nativeSession)
        await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession)
      }
      await runLifecycle.closeTurn({
        runId: item.runId,
        status,
        ...(status !== 'completed' ? status === 'failed' ? await failedBoundary(item) : {} : {
          sourceEndSeq: dshTurnBoundarySeq(sessionEventSource(item.nativeSession), item.turn, 'end'),
        }),
      })
    } catch (error) { failures.push(error) }
  }
    return failures
  }
  return { runLifecycle, resolveIdleClose, resolveSessionRunId, resolveSessionClose, retireSupersededRun, closeRemainingRuns }
}
