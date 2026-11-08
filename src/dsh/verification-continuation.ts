import { withImmediateTransaction } from '../db/transaction.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { continuationMessage, continuationProgress } from './continuation-evidence.js'
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

export function isVerificationContinuation(message: any): boolean {
  return message?.source?.kind === KIOKUKO_DSH_SOURCE_KIND &&
    message.source.name === 'completion-verification'
}

/** A previously reserved wake belongs to this task and the immediate next turn. */
export function acceptsVerificationContinuation(message: any, lease: TaskLease, turn: number): boolean {
  return isVerificationContinuation(message) && message.id === claimId(lease, turn - 1)
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
      authorizeTaskLease(db, authority)
      const assessment = assessTaskCompletion(db, authority.taskId)
      if (!assessment.evidenceRequired || assessment.verified ||
        assessment.managedOperationsReady === false || assessment.nativeChildrenPending) return
      const actionable = assessment.criteria.some(criterion => criterion.state !== 'satisfied' &&
        !['no_binding', 'binding_not_approved', 'criterion_changed', 'unsupported_completion_method'].includes(criterion.reason))
      if (!actionable) return

      const id = claimId(authority, turn)
      const claim = withImmediateTransaction(db, () => {
        const decision = claimAutomaticContinuationInTransaction(db, {
          claimId: id,
          runId: authority.taskId,
          dshSessionId: authority.sessionId,
          instructionDigest: canonicalContentHash('verify the current requested outcome'),
          progressDigest: continuationProgress(db, authority.taskId, authority.repositoryRoot, assessment),
        })
        if (decision.decision === 'blocked') {
          saveSessionNotice(db, {
            id: `completion-blocked:${id}`,
            runId: authority.taskId,
            sessionId: authority.sessionId,
            rootPath: authority.repositoryRoot,
            kind: 'status',
            text: '完了条件の検証が残っています。同じ結果が続いたため、自動での再試行を終了しました。',
            anchorSeq: 0,
          })
        }
        return decision
      })
      // The claim reserves one native delivery. A crash at the inbox boundary
      // leaves an uncertain reservation, which must never be sent a second time.
      if (!canWake() || claim.replayed || (claim.decision !== 'deliver' && claim.decision !== 'replan')) return
      const message = continuationMessage(id, claim.decision === 'deliver'
        ? 'The current request is still open. Use task_completion status to find the missing verification. Establish current host-observed evidence using the selected route, or explain the specific obstacle if verification cannot run.'
        : 'The previous verification attempt did not change the observed result. Try a different authorized check for the same request. If no check can run, report which condition is unverified and why.')
      agent.followup!({ ...message, source: { ...message.source, name: 'completion-verification' } })
    })
  } finally {
    dispose()
  }
}
