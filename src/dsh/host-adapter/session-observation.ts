import { projectModelBinding } from '../model-auto/policy.js'
import { humanInput } from '../../memory/review/evidence.js'
import { hasHumanInput } from '../answer-review/contracts.js'
import { type ReviewNativeSession } from '../auto-memory-review.js'
import { executionObservation } from '../evolution-observation.js'
import { saveEvolutionObservation } from '../plugin-records.js'
import { isModelAvailabilityFailure } from '../model-routing.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { type DshLogEvent } from '../session-memory-finalizer.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { resolveProjectWorkspaceReadOnly } from '../../memory/workspaces.js'
import { enqueueUnsubmittedTurn, markOutboxObservedInTransaction } from '../turn-process.js'
import { backupInputClaimInTransaction, readInputClaim, markClaimProgressInTransaction, settleInputClaimInTransaction, takeRecoverableInputClaimInTransaction } from '../input-claim.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SqliteDatabase } from '../../db/adapter.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshEnnoMemoryRefresh } from '../enno-memory-refresh.js'
import type { AnswerReviewCoordinator } from '../answer-review/coordinator.js'
import type { AutoMemoryReviewCoordinator } from '../auto-memory-review.js'
import type { RoutableAgent } from '../model-routing.js'
import type { DshSessionLogMirror } from '../session-log-mirror.js'
import type { DshExecutionSupport } from '../execution-support.js'
import type { ModelAutoCoordinator } from '../model-auto/coordinator.js'
import type { EvolutionConfig } from '../../memory/evolution/contracts.js'
import type { EnnoOdunoState } from '../../enno-oduno/types.js'
import type { DshUserQuestionAgent } from '../user-interaction.js'
import type { TurnRecord } from './turn-state.js'
import { onNativeEvent } from './native-events.js'
import type { NativeAgent } from './native-events.js'

interface ObservationDependencies {
  readonly ctx: Context
  readonly ennoMemory: DshEnnoMemoryRefresh
  readonly evolutionConfig: EvolutionConfig
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly currentForAgentEvent: (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object) => TurnRecord | undefined
  readonly answerReview: AnswerReviewCoordinator
  readonly markModelUnavailable: (agent: RoutableAgent) => Promise<void>
  readonly recordManualChange: (sessionId: string, pending: Promise<void>) => void
  readonly modelAuto: ModelAutoCoordinator
  readonly root: string
  readonly autoReview: AutoMemoryReviewCoordinator
  readonly reviewBinding: (item: TurnRecord, session: object) => { workspace: string; runId: string; session: ReviewNativeSession; startSeq: number }
  readonly sessionMirror: DshSessionLogMirror
  readonly executionSupport: DshExecutionSupport
  readonly kickBoundary: (sessionId: string, agent: DshUserQuestionAgent | undefined) => void
  readonly stateForRun: (database: SqliteDatabase, item: TurnRecord) => EnnoOdunoState
  readonly objectRecord: (value: unknown) => Record<string, unknown> | undefined
  readonly isHumanMessage: (value: unknown) => boolean
  readonly eventContinuationId: (value: unknown) => string | undefined
}

export function createSessionObservation(runtime: DshCoreRuntime) {
  const memoryCalls = new WeakMap<object, Map<string, { name: string; runId: string; agent: object; turn: number; seq: number }>>()
  const inMemoryClaims = new Map<string, {
    messages: readonly unknown[]
    providerStarted: boolean
    sideEffectStarted: boolean
    recovered: boolean
  }>()
  const captureInitialInput = async (sessionId: string, turn: number, messages: readonly unknown[]): Promise<void> => {
    const key = `${sessionId}\u0000${turn}`
    let initial = inMemoryClaims.get(key)
    if (!initial) {
      if (messages.length === 0) return
      initial = { messages: Object.freeze([...messages]), providerStarted: false, sideEffectStarted: false, recovered: false }
      inMemoryClaims.set(key, initial)
    }
    // Inbox claims are step-local. Preserve the first turn input and monotonic
    // execution flags across assembly, pre-step, steering, and plugin reload.
    const snapshot = initial
    try {
      const stored = await runtime.withDatabase(database => withImmediateTransaction(database, () => (
        readInputClaim(database, sessionId, turn) ?? backupInputClaimInTransaction(database, {
          dshSessionId: sessionId, nativeTurn: turn, messages: snapshot.messages,
        })
      )))
      snapshot.messages = stored.messages
      snapshot.providerStarted ||= stored.providerStarted
      snapshot.sideEffectStarted ||= stored.sideEffectStarted
      snapshot.recovered ||= stored.recoveryCount !== 0 || (stored.status !== 'claimed' && stored.status !== 'recoverable')
    } catch {
      // Auxiliary persistence cannot veto native assembly or admission. The
      // original process-local snapshot still covers a pre-provider failure.
    }
  }
  const install = ({
    ctx, ennoMemory, evolutionConfig, currentSession, currentForAgentEvent,
    answerReview, markModelUnavailable, recordManualChange, modelAuto, root,
    autoReview, reviewBinding, sessionMirror, executionSupport, kickBoundary,
    stateForRun, objectRecord, isHumanMessage, eventContinuationId,
  }: ObservationDependencies) => {
  const observationDisposer = onNativeEvent(ctx, 'tools/result', (execution: any, result: unknown) => {
    try {
      if (ennoMemory.enabled && execution.parent === undefined) {
        const agent = execution.agent, session = agent?.session, item = session ? currentSession(session.id) : undefined
        const calls = session ? memoryCalls.get(session) : undefined
        const call = calls?.get(execution.callId)
        calls?.delete(execution.callId)
        if (item && !item.closed && item.nativeAgent === agent && item.nativeSession === session && call
          && call.runId === item.runId && call.agent === agent && call.turn === item.turn && call.name === execution.name) {
          ennoMemory.observeResult(item.runId, agent, session, item.repositoryRoot, result)
        }
      }
      if (evolutionConfig.mode === 'off' || execution.parent !== undefined) return
      const agent = execution.agent, session = agent?.session, item = session ? currentSession(session.id) : undefined
      if (!item || item.closed || item.nativeAgent !== agent || item.nativeSession !== session || typeof session.eventAt !== 'function' || !Number.isSafeInteger(session.seq)) return
      let call: any
      // Bound lookup even in million-event sessions. Missing correlation stays unknown.
      for (let seq=session.seq-1;seq>=Math.max(0,session.seq-4096);seq--) {
        const event=session.eventAt(seq)
        if (event?.type==='tool/call' && event.data?.callId===execution.callId) {call=event;break}
      }
      if (!call || call.data.name !== execution.name || call.data.turn !== item.turn) return
      const observation = executionObservation({runId:item.runId,workspace:item.workspace,sessionId:item.sessionId},execution.callId,call.seq,result)
      // Enqueued before turn completion; the finalizer reads the same queue.
      // Native logs cannot safely carry external event types on supported DSH.
      if (observation) void runtime.withDatabase(db => saveEvolutionObservation(db, observation)).catch(() => {
        // Missing proof remains unknown and cannot veto native tool completion.
      })
    } catch { /* optional evidence never changes native tool completion */ }
  })
  const errorDisposer = onNativeEvent(ctx, 'agent/error', (event: { agent: { id: string; session?: { id: string }; sessionId?: string }; error?: unknown }) => {
    if (event.agent.session?.id) answerReview.cancel(event.agent.session.id)
    const item = currentForAgentEvent(event.agent.id, event.agent.session?.id ?? event.agent.sessionId, undefined, event.agent.session, event.agent)
    if (item !== undefined) item.failed = true
    if (isModelAvailabilityFailure(event.error)) void markModelUnavailable(event.agent).catch(() => {
      // Keep the in-memory reselect fence if durable storage is unavailable.
    })
  })
  const sessionEventDisposer = onNativeEvent(ctx, 'session/event', (session: { id: string }, event: { type?: unknown; seq?: unknown; data?: unknown }) => {
    const item = currentSession(session.id)
    if (event.type === 'model/selection' && typeof event.seq === 'number') {
      const selected = projectModelBinding(event.data)
      if (selected) {
        const change = modelAuto.manual(session.id, event.seq, selected)
        recordManualChange(session.id, change)
        void change.catch(() => {})
      }
    }
    if (event.type === 'request/header' && item) {
      const config = objectRecord(objectRecord(event.data)?.header)?.config
      const selected = projectModelBinding(config)
      if (selected) void modelAuto.requestHeader(session.id, item.runId, selected).catch(() => {})
    }
    if (event.type === 'user/message' && hasHumanInput([event.data])) answerReview.humanInput(session.id, objectRecord(event.data)?.turn as number | undefined)
    if(event.type==='user/message'&&typeof event.seq==='number'){
      const input=humanInput(event as DshLogEvent)
      if(input)void runtime.withDatabase(db=>resolveProjectWorkspaceReadOnly(db,root,{allowDirectory:true})).then(project=>project?autoReview.acceptInput(project.workspace,session.id,input.text):undefined).catch(()=>undefined)
    }
    const data = objectRecord(event.data)
    const eventTurn = typeof data?.turn === 'number' && Number.isSafeInteger(data.turn) ? data.turn : item?.turn
    if (ennoMemory.enabled && item && item.nativeSession === session && event.type === 'user/message' && isHumanMessage(event.data)) {
      ennoMemory.invalidate(item.runId)
    }
    const ownsTurn = item !== undefined && !item.closed && eventTurn === item.turn && typeof event.type === 'string'
    if (ennoMemory.enabled && ownsTurn && item.nativeSession === session && item.nativeAgent && event.type === 'tool/call'
      && data?.turn === item.turn && Number.isSafeInteger(event.seq) && typeof data?.callId === 'string' && typeof data.name === 'string'
      && !/^(?:enno_|oduno_|kiokuko|deep_)/u.test(data.name)) {
      let calls = memoryCalls.get(session)
      if (!calls) { calls = new Map(); memoryCalls.set(session, calls) }
      if (calls.size >= 256) calls.delete(calls.keys().next().value!)
      calls.set(data.callId, { name: data.name, runId: item.runId, agent: item.nativeAgent, turn: item.turn, seq: event.seq as number })
    }
    if(event.type==='turn/end'&&typeof event.seq==='number'&&item?.nativeSession===session&&!item.closed) autoReview.notify(reviewBinding(item,session),event.seq)
    const claimKey = `${session.id}\u0000${eventTurn}`
    const fallback = ownsTurn ? inMemoryClaims.get(claimKey) : undefined
    const providerStarted = event.type === 'request/header' || event.type === 'request/context'
      || event.type === 'assistant/chunk' || event.type === 'assistant/message'
    const sideEffectStarted = event.type === 'tool/call'
    // Observe execution synchronously, before the mirror can yield or fail.
    // A later step/end callback must never see an earlier execution as unstarted.
    if (fallback) {
      fallback.providerStarted ||= providerStarted
      fallback.sideEffectStarted ||= sideEffectStarted
    }
    // This observer is deliberately fire-and-contain. DSH persistence and the
    // model turn must never depend on Kiokuko claim bookkeeping.
    void (async () => {
      if (typeof event.type === 'string' && typeof event.seq === 'number') {
        try { await sessionMirror.observe(session.id, event as DshLogEvent) } catch { /* claim bookkeeping remains independent */ }
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
      if (!ownsTurn || item === undefined) return
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
      let durableUnavailable = true
      try {
        const settled = await runtime.withDatabase((database) => withImmediateTransaction(database, () => {
          // Earlier observer writes may still be pending. Persist all execution
          // already observed locally before deciding whether replay is safe.
          markClaimProgressInTransaction(database, {
            dshSessionId: item.sessionId, nativeTurn: item.turn,
            providerStarted: fallback?.providerStarted === true, sideEffectStarted: fallback?.sideEffectStarted === true,
          })
          return settleInputClaimInTransaction(database, {
            dshSessionId: item.sessionId,
            nativeTurn: item.turn,
            turnEndedWithError,
          })
        }))
        durableRecoverable = settled?.status === 'recoverable'
        durableUnavailable = settled === undefined
      } catch {
        // Fall through to the process-local decision.
      }
      const locallyRecoverable = turnEndedWithError
        && fallback !== undefined
        && !fallback.providerStarted
        && !fallback.sideEffectStarted
        && !fallback.recovered
      const steer = (item.nativeAgent as { steer?: (message: unknown) => void } | undefined)?.steer
      const recoveryAllowed = (fallback === undefined || locallyRecoverable)
        && (durableRecoverable || durableUnavailable && locallyRecoverable)
      if (recoveryAllowed && steer !== undefined) {
        let messages: readonly unknown[] | undefined
        // Reserve locally before awaiting the durable consumer; duplicate end
        // notifications cannot enqueue the same input again.
        if (fallback) fallback.recovered = true
        if (durableRecoverable) {
          try {
            const claim = await runtime.withDatabase((database) => withImmediateTransaction(database, () => (
              takeRecoverableInputClaimInTransaction(database, item.sessionId, item.turn)
            )))
            messages = claim?.messages
          } catch {
            // Use the exact in-memory batch if the durable consumer failed.
            messages = fallback?.messages
          }
        } else {
          messages = fallback?.messages
        }
        if (messages !== undefined && messages.length > 0) {
          for (const message of messages) steer(message)
        }
      }
      if (!turnEndedWithError || !recoveryAllowed) inMemoryClaims.delete(claimKey)
      if (reason?.kind === 'completed' && item.prepared.ennoOduno.applicable && !executionSupport.paused(item.sessionId)) {
        await runtime.withDatabase(database => {
          const state = stateForRun(database, item)
          if (state.nextAction === 'complete' || state.nextAction === 'report_blocker'
            || state.status === 'cancelled' || state.contractRevision === null) return
          const phase = state.nextAction === 'submit_ideal' ? 'ideal'
            : state.nextAction === 'review_plan' || state.nextAction === 'submit_plan' || state.nextAction === 'ask_user_confirmation' ? 'planning'
            : state.nextAction === 'execute_work_unit' ? 'work_unit'
            : state.nextAction === 'submit_meditation' ? 'meditation' : 'final_review'
          const operation = phase === 'ideal' ? 'ideal_submit' : phase === 'planning' ? 'plan_submit'
            : phase === 'work_unit' ? 'work_report' : phase === 'meditation' ? 'meditation_submit' : 'finish'
          enqueueUnsubmittedTurn(database, {
            runId: item.runId, dshSessionId: item.sessionId, nativeTurn: item.turn,
            phase, operation, contractRevision: state.contractRevision,
            ...(state.directive?.workUnit?.id === undefined ? {} : { workUnitId: state.directive.workUnit.id }),
            inputDigest: canonicalContentHash({ nextAction: state.nextAction, source: 'unsubmitted_turn' }),
            idempotencyKey: `dsh-unsubmitted:${item.turn}`, nextAction: state.nextAction,
          })
        })
      }
      kickBoundary(item.sessionId, item.nativeAgent)
    })().catch(() => {
      // Observe-only DSH listeners must never veto the native event.
    })
  })
  const reviewIdleDisposer=onNativeEvent(ctx, 'agent/idle',(agent:NativeAgent)=>{
    const session=agent.session as ReviewNativeSession|undefined
    const item=session?currentSession(session.id):undefined
    if(item&&session&&item.nativeSession===session&&!item.closed) void sessionMirror.latestEvent(session.id,'turn/end',Number.MAX_SAFE_INTEGER).then(end=>{if(end)autoReview.notify(reviewBinding(item,session),end.seq)}).catch(()=>undefined)
  })
    return {
      disposeError: (): void => { errorDisposer?.() },
      disposeSession: (): void => { sessionEventDisposer?.() },
      disposeIdle: (): void => { reviewIdleDisposer?.() },
      disposeResult: (): void => { observationDisposer() },
    }
  }
  return { captureInitialInput, install, clear: (): void => { inMemoryClaims.clear() } }
}
