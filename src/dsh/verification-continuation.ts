import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { continuationMessage, continuationProgress } from './continuation-evidence.js'
import { readCodingWorkflow } from './coding-workflow/store.js'
import type { DshCoreRuntime } from './core-runtime.js'
import { claimAutomaticContinuationInTransaction } from './loop-guard.js'
import { observeNativeUserCancellation } from './native-cancellation-observer.js'
import { saveSessionNotice } from './plugin-records.js'
import { KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'
import { assessTaskCompletion } from './task-completion.js'
import { authorizeTaskLease, type TaskLease } from './task-state.js'

interface VerificationAgent {
  status?: string
  cancel?: (...args: any[]) => unknown
  followup?: (message: any) => void
  inbox?: { nextTurn: readonly unknown[]; nextStep: readonly unknown[] }
}

function claimId(lease: TaskLease, turn: number): string {
  return canonicalContentHash({ kind: 'completion-verification', lease, turn })
}

const verificationInstruction = canonicalContentHash('verify the current requested outcome')
const verificationWakeLimit = 2

export function isVerificationContinuation(message: any): boolean {
  return message?.source?.kind === KIOKUKO_DSH_SOURCE_KIND &&
    message.source.name === 'completion-verification'
}

/** A previously reserved wake belongs to this task and the immediate next turn. */
export function acceptsVerificationContinuation(message: any, lease: TaskLease, turn: number): boolean {
  return isVerificationContinuation(message) && message.id === claimId(lease, turn - 1)
}

/** Native admission is positive delivery evidence; absence of a message is not. */
export function observeVerificationContinuation(db: SqliteDatabase, message: any, lease: TaskLease, turn: number): void {
  if (!acceptsVerificationContinuation(message, lease, turn)) return
  withImmediateTransaction(db, () => {
    authorizeTaskLease(db, lease)
    db.prepare(`UPDATE dsh_loop_guard_claims SET verification_delivery_phase='observed'
      WHERE claim_id=? AND run_id=? AND dsh_session_id=? AND verification_delivery_phase IN ('dispatching','dispatched')`)
      .run(message.id, lease.taskId, lease.sessionId)
  })
}

export async function continueVerification(input: {
  runtime: DshCoreRuntime
  agent: VerificationAgent
  authority: TaskLease
  turn: number
  current: () => boolean
}): Promise<void> {
  const { runtime, agent, authority, turn } = input
  if (typeof agent.cancel !== 'function' || typeof agent.followup !== 'function' || !agent.inbox) return
  let cancelled = false
  const canWake = () => !cancelled && input.current() && agent.status === 'idle' &&
    agent.inbox!.nextTurn.length === 0 && agent.inbox!.nextStep.length === 0
  if (!canWake()) return
  const dispose = observeNativeUserCancellation(agent, () => { cancelled = true })
  try {
    await runtime.withDatabase(db => {
      if (!canWake()) return
      const id = claimId(authority, turn)
      const claim = withImmediateTransaction(db, () => {
        authorizeTaskLease(db, authority)
        const assessment = assessTaskCompletion(db, authority.taskId)
        if (!assessment.evidenceRequired || assessment.verified ||
          assessment.managedOperationsReady === false || assessment.nativeChildrenPending) return
        const workflow = readCodingWorkflow(db, authority.taskId)
        if (workflow?.blocker || workflow?.pendingScopeChange) return
        const actionable = assessment.criteria.some(criterion => criterion.state !== 'satisfied' &&
          !['no_binding', 'binding_not_approved', 'criterion_changed', 'unsupported_completion_method'].includes(criterion.reason))
        if (!actionable) return
        const decision = claimAutomaticContinuationInTransaction(db, {
          claimId: id,
          runId: authority.taskId,
          dshSessionId: authority.sessionId,
          instructionDigest: verificationInstruction,
          progressDigest: continuationProgress(db, authority.taskId, authority.repositoryRoot, assessment),
          deliveryLimit: verificationWakeLimit,
        })
        if (!decision.replayed && ['deliver', 'replan'].includes(decision.decision)) {
          db.prepare(`UPDATE dsh_loop_guard_claims SET verification_delivery_phase='reserved' WHERE claim_id=?`).run(id)
        }
        if (decision.decision === 'blocked') {
          saveSessionNotice(db, {
            id: `completion-retries-ended:${canonicalContentHash({ runId: authority.taskId, sessionId: authority.sessionId, generation: decision.generation })}`,
            runId: authority.taskId,
            sessionId: authority.sessionId,
            rootPath: authority.repositoryRoot,
            kind: 'status',
            text: '完了条件の検証が残っています。自動再試行を終了しました。作業は保持されています。',
            anchorSeq: 0,
          })
        }
        return decision
      })
      // Only a persisted, definitely unsent reservation may be recovered. Commit
      // dispatching before crossing the native boundary: a throw or crash there
      // is an unknown outcome, never evidence that automatic resend is safe.
      if (!claim || !canWake() || (claim.decision !== 'deliver' && claim.decision !== 'replan')) return
      const dispatch = withImmediateTransaction(db, () => {
        authorizeTaskLease(db, authority)
        return db.prepare(`UPDATE dsh_loop_guard_claims SET verification_delivery_phase='dispatching'
          WHERE claim_id=? AND verification_delivery_phase='reserved' AND resolution IS NULL
            AND generation=(SELECT generation FROM dsh_loop_guard_states WHERE run_id=? AND dsh_session_id=?)
          RETURNING claim_id`).get(id, authority.taskId, authority.sessionId)
      })
      if (!dispatch) return
      const message = continuationMessage(id, claim.decision === 'deliver'
        ? 'The current request is still open. Use task_completion status to find the missing verification. Establish current host-observed evidence using the selected route, or explain the specific obstacle if verification cannot run.'
        : 'The previous verification attempt did not change the observed result. Try a different authorized check for the same request. If no check can run, report which condition is unverified and why.')
      agent.followup!({ ...message, source: { ...message.source, name: 'completion-verification' } })
      db.prepare(`UPDATE dsh_loop_guard_claims SET verification_delivery_phase='dispatched'
        WHERE claim_id=? AND verification_delivery_phase='dispatching'`).run(id)
    })
  } finally {
    dispose()
  }
}
