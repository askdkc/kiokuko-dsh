import type { SqliteDatabase } from '../../db/adapter.js'
import { readTaskSnapshot, type TaskLease } from '../task-state.js'
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
import { withImmediateTransaction } from '../../db/transaction.js'
import { LedgerStore } from '../../ledger/store.js'
import { terminalizeLedgerRunInTransaction } from '../../enno-oduno/store.js'
import { KiokukoError } from '../../errors.js'
import { saveTaskCompletionReceipt, taskCompletionBlocksClose } from '../task-completion.js'
import { readCodingWorkflow } from '../coding-workflow/store.js'
import { stopCodingWorkflow, synchronizeCodingWorkflow } from '../coding-workflow/service.js'
import { saveSessionNotice } from '../plugin-records.js'
import { canonicalContentHash } from '../../serialization/validate.js'
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
  readonly onRunClosed?: (runId: string, status: string, sessionId: string) => void
}

function currentCloseAuthority(database: SqliteDatabase, runId: string, authority?: TaskLease): boolean {
  if (!authority) return database.prepare('SELECT task_managed FROM ledger_runs WHERE run_id=?').get<{ task_managed: number }>(runId)?.task_managed !== 1
  if (authority.taskId !== runId) return false
  try {
    const current = readTaskSnapshot(database, authority)
    return current.revision === authority.revision && current.generation === authority.generation && !current.pendingStop
  } catch { return false }
}
function closeAuthority(item: TurnRecord): { authority?: TaskLease } { return item.authority ? { authority: item.authority } : {} }

export function createLifecycle(deps: LifecycleDependencies) {
  const { runtime, sessions, sessionMirror, autoReview, answerReview, ennoController,
    ennoMemory, executionSupport, gate, turnState, currentSession, currentForAgentEvent,
    stateForRun, deliverCompletionReport, reviewBinding, clearToolRun,
    sessionEventSource } = deps
  const getSelection = deps.getSelection
  const completionReady = async (item: TurnRecord): Promise<boolean> => runtime.withDatabase(database => {
    if (!currentCloseAuthority(database, item.runId, item.authority)) return false
    try {
      synchronizeCodingWorkflow(database,item.runId)
      const assessment = saveTaskCompletionReceipt(database, item.runId)
      if (!taskCompletionBlocksClose(assessment)) return true
      const unresolved = assessment.criteria.filter(criterion => criterion.state !== 'satisfied')
      const text = `完了条件の検証待ちです。未確認: ${unresolved.map(criterion => criterion.description).join(' / ').slice(0, 4000)}。task_completion status で根拠を確認し、検証方法を登録してください。`
      saveSessionNotice(database, { id: `completion-wait:${canonicalContentHash({ runId: item.runId, unresolved })}`,
        runId: item.runId, sessionId: item.sessionId, rootPath: item.cwd, kind: 'status', text, anchorSeq: 0 })
      return false
    } catch {
      // A missing or corrupt new completion assessment never grants an opted-in
      // enforce run a verified terminal state. Legacy/shadow close as before.
      return database.prepare('SELECT mode FROM dsh_completion_runs WHERE run_id = ?')
        .get<{ mode: string }>(item.runId)?.mode !== 'enforce'
    }
  })
  const resolveIdleClose = async (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object): Promise<DshCloseIntent | undefined> => {
    await deliverCompletionReport(nativeSession)
    const item = currentForAgentEvent(agentId, sessionId, undefined, nativeSession, nativeAgent)
    if (item === undefined || item.closed || executionSupport.paused(item.sessionId)) return undefined
    if (nativeAgent && answerReview.hold(nativeAgent as ReviewAgent)) return undefined
    const selection = getSelection(item.runId)?.value
    if (selection?.discussion) return undefined
    if (selection && (selection.status !== 'ready' && item.prepared.intake.profile.taskType !== 'chat' || item.failed && selection.mode === 'normal')) return undefined
    const state = await runtime.withDatabase((database) => stateForRun(database, item))
    const coding = await runtime.withDatabase(db=>readCodingWorkflow(db,item.runId))
    if(coding?.state==='cancelled'||coding?.state==='superseded')return {...closeAuthority(item),runId:item.runId,status:'cancelled',terminalTurn:item.turn}
    if (state.status === 'cancelled') return { ...closeAuthority(item), runId: item.runId, status: 'cancelled' }
    if (state.status === 'blocked' || state.nextAction === 'report_blocker') return { ...closeAuthority(item), runId: item.runId, status: 'failed', terminalTurn: item.turn }
    // A chat run spans the quiet time between user messages. Enno's
    // inapplicable `complete` means that no orchestration is required for this
    // turn; it does not mean that the persistent conversation has ended.
    if (item.prepared.intake.profile.taskType === 'chat') return undefined
    if (state.status === 'completed' || state.nextAction === 'complete') {
      if (!await completionReady(item)) return undefined
      // A provider failure while wording the final response cannot undo
      // already verified completion. The durable host report covers it.
      return { ...closeAuthority(item), runId: item.runId, status: 'completed', terminalTurn: item.turn }
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
      if (!await completionReady(item)) return undefined
      await deliverCompletionReport(nativeSession)
      return { ...closeAuthority(item), runId: item.runId, status: 'completed', terminalTurn: item.turn }
    }
    if (item.failed) return { ...closeAuthority(item), runId: item.runId, status: 'failed', terminalTurn: item.turn }
    if (state.status === 'cancelled') return { ...closeAuthority(item), runId: item.runId, status: 'cancelled' }
    if (state.status === 'blocked' || state.nextAction === 'report_blocker') return { ...closeAuthority(item), runId: item.runId, status: 'failed', terminalTurn: item.turn }
    if (item.prepared.intake.profile.taskType === 'chat' || state.nextAction === 'complete') {
      if (item.prepared.intake.profile.taskType !== 'chat' && !await completionReady(item)) return undefined
      return { ...closeAuthority(item), runId: item.runId, status: 'completed', terminalTurn: item.turn }
    }
    return { ...closeAuthority(item), runId: item.runId, status: 'cancelled' }
  }
  const closeRun = async (input: DshRunClose): Promise<void> => {
    let committedAuthority: TaskLease | undefined
    const committed = await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
      if (!currentCloseAuthority(database, input.runId, input.authority)) return false
      if (input.status === 'cancelled') stopCodingWorkflow(database, input.runId, 'cancelled')
      let completionBlocked: boolean
      try { completionBlocked = taskCompletionBlocksClose(saveTaskCompletionReceipt(database, input.runId)) }
      catch { completionBlocked = database.prepare('SELECT mode FROM dsh_completion_runs WHERE run_id=?').get<{mode:string}>(input.runId)?.mode === 'enforce' }
      if (input.status === 'completed' && completionBlocked) throw new KiokukoError('CONFLICT', 'Required task completion evidence is unresolved')
      const store = new LedgerStore(database)
      const before = store.readRun(input.runId)
      if (before === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Run close target does not exist')
      if (before.status === 'intake' || before.status === 'active') {
        terminalizeLedgerRunInTransaction(database, input.runId, input.status)
      } else if (before.status !== input.status) {
        throw new KiokukoError('CONFLICT', 'Run close status is immutable')
      }
      // Native completion and authority have been checked independently.
      // A missing optional memory range cannot change the observed task outcome.
      if (input.authority) {
        const closed = readTaskSnapshot(database, input.authority)
        committedAuthority = { ...input.authority, revision: closed.revision, generation: closed.generation }
      }
      return true
    }))
    if (!committed) return // An obsolete generation cannot finalize or retire its replacement.
    const reviewFinishes: Promise<void>[] = []
    // The DB callback may resume after another client reopened this same run.
    // Run-wide caches must be retired atomically with a fresh generation check.
    await runtime.withDatabase(database => {
      if (!currentCloseAuthority(database, input.runId, committedAuthority)) return
      try { autoReview.worker.abort(input.runId) } catch { /* Optional memory cleanup cannot retain a task owner. */ }
      const items = turnState.allTurns().filter(candidate => candidate.runId === input.runId
        && (!input.authority || candidate.authority?.sessionId === input.authority.sessionId && candidate.authority.generation === input.authority.generation))
      const committedSessionId = items[0]?.sessionId
      if (committedSessionId) try { deps.onRunClosed?.(input.runId, input.status, committedSessionId) } catch { /* optional memory observation */ }
      for (const item of items) {
        ennoController.retire({ ...(item.nativeAgent === undefined ? {} : { nativeAgent: item.nativeAgent }),
          ...(item.nativeSession === undefined ? {} : { nativeSession: item.nativeSession }) })
        if (item.nativeAgent) reviewFinishes.push(answerReview.finish(item.nativeAgent as ReviewAgent))
        item.closed = true
        try { ennoMemory.clear(item.runId) } catch { /* Optional memory cleanup cannot retain a task owner. */ }
        executionSupport.clear(item.sessionId)
        gate.clearTurn(item.sessionId, item.turn)
      }
      turnState.releaseRun(input.runId, input.authority)
      clearToolRun(input.runId)
    })
    await Promise.all(reviewFinishes)

  }
  const runLifecycle = new DshRunLifecycle({ closeRun })
  const optionalSourceBoundary = (item: TurnRecord): { sourceEndSeq?: number } => {
    try { return { sourceEndSeq: dshTurnBoundarySeq(sessionEventSource(item.nativeSession), item.turn, 'end') } }
    catch { return {} /* Incomplete source evidence stays unavailable to memory. */ }
  }
  const failedBoundary = async (item: TurnRecord): Promise<{ sourceEndSeq?: number }> => {
    try {
      if (item.nativeSession === undefined || sessions?.flush === undefined) return {}
      await sessions.flush(item.nativeSession)
      try { await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession) } catch { /* Optional mirror cannot veto native task closure. */ }
      return optionalSourceBoundary(item)
    } catch { return {} }
  }
  const retireSupersededRun = async (item: TurnRecord, status: 'completed' | 'failed' | 'cancelled'): Promise<void> => {
    if (status === 'completed' && !await completionReady(item)) status = 'cancelled'
    if (status !== 'completed') {
      await runLifecycle.closeTurn({ ...closeAuthority(item), runId: item.runId, status, ...(status === 'failed' ? await failedBoundary(item) : {}) })
      return
    }
    if (item.nativeSession === undefined || sessions?.flush === undefined) {
      throw new KiokukoError('CONFLICT', 'Completed DSH run requires its exact native session checkpoint')
    }
    await sessions.flush(item.nativeSession)
    try { await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession) } catch { /* Optional mirror cannot veto native task closure. */ }
    await runLifecycle.closeTurn({
      ...closeAuthority(item), runId: item.runId,
      status,
      ...optionalSourceBoundary(item),
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
        if (!await completionReady(item)) continue
        await deliverCompletionReport(item.nativeSession)
        if (item.nativeSession === undefined || sessions?.flush === undefined) {
          throw new KiokukoError('CONFLICT', 'Completed DSH run requires its exact native session checkpoint')
        }
        await sessions.flush(item.nativeSession)
        try { await sessionMirror.checkpointAfterNativeFlush(item.nativeSession as DshMirrorEventSession) } catch { /* Optional mirror cannot veto native task closure. */ }
      }
      await runLifecycle.closeTurn({
        ...closeAuthority(item), runId: item.runId,
        status,
        ...(status !== 'completed' ? status === 'failed' ? await failedBoundary(item) : {} : {
          ...optionalSourceBoundary(item),
        }),
      })
    } catch (error) { failures.push(error) }
  }
    return failures
  }
  return { runLifecycle, resolveIdleClose, resolveSessionRunId, resolveSessionClose, retireSupersededRun, closeRemainingRuns }
}
