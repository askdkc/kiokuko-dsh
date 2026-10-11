import type { LispOwner } from './contracts.js'
import type { DshUserQuestions } from '../user-interaction.js'
export type ApprovalMode = 'ask' | 'auto'
export interface LispApprovalPolicy {
  mode(): ApprovalMode
  writable(): boolean
  validate(agentId: string, owner?: LispOwner): void
  set(mode: ApprovalMode): Promise<void>
}
export type ApprovalQuestions = DshUserQuestions & { approvalPolicy?: LispApprovalPolicy; executionMode?:'development'|'protected' }
export const AUTO_APPROVE_LABEL = 'Auto-approve all Lisp actions for this profile and continue'
export type Approval = { approved: true; source?: 'manual' | 'profile' } | { approved: false; reason: 'declined' | 'cancelled' | 'timed_out' | 'unavailable' | 'invalid_answer' | 'policy_update_failed'; message?: string }

/** One concrete review; no timeout, UI failure or free text can grant authority. */
export async function confirm(questions: DshUserQuestions | undefined, identity: string | LispOwner,
  question: Parameters<DshUserQuestions['ask']>[0]['questions'][0], signal: AbortSignal, timeoutMs = 300000, destructive = false): Promise<Approval> {
  const agentId = typeof identity === 'string' ? identity : identity.agentId
  const owner = typeof identity === 'string' ? undefined : identity
  if (signal.aborted) return { approved: false, reason: 'cancelled' }
  const policy = (questions as ApprovalQuestions | undefined)?.approvalPolicy
  policy?.validate(agentId, owner)
  const development=(questions as ApprovalQuestions|undefined)?.executionMode==='development'
  if (development && !destructive || !development && policy?.mode()==='auto') return { approved: true, source: 'profile' }
  if (!questions) return { approved: false, reason: 'unavailable' }
  const canEnable = !development && policy?.writable()===true
  if (canEnable) question = { ...question, options: [...(question.options ?? []), { label: AUTO_APPROVE_LABEL }] }
  const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  let onAbort: (() => void) | undefined
  try {
    const aborted = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); if (combined.aborted) onAbort(); else combined.addEventListener('abort', onAbort, { once: true }) })
    const answer = await Promise.race([questions.ask({ agent: { id: agentId }, signal: combined, questions: [question] }), aborted])
    if (combined.aborted) return { approved: false, reason: signal.aborted ? 'cancelled' : 'timed_out' }
    if (!answer) return { approved: false, reason: 'unavailable' }
    const response = answer.answers[0]
    if (answer.answers.length !== 1 || response?.id !== question.id || response.custom || response.selected.length !== 1) return { approved: false, reason: 'invalid_answer' }
    if (canEnable && response.selected[0] === AUTO_APPROVE_LABEL) {
      try { await Promise.race([policy!.set('auto'), aborted]) }
      catch (error) { return { approved: false, reason: 'policy_update_failed', message: error instanceof Error ? error.message : String(error) } }
      if (combined.aborted) return { approved: false, reason: signal.aborted ? 'cancelled' : 'timed_out' }
      policy!.validate(agentId, owner)
      return { approved: true, source: 'profile' }
    }
    if (response.selected[0] === question.intent?.approve) { policy?.validate(agentId, owner); return policy ? { approved: true, source: 'manual' } : { approved: true } }
    return { approved: false, reason: response.selected[0] === question.options?.[0]?.label ? 'declined' : 'invalid_answer' }
  } catch { return { approved: false, reason: signal.aborted ? 'cancelled' : timeout.signal.aborted ? 'timed_out' : 'unavailable' } }
  finally { clearTimeout(timer); if (onAbort) combined.removeEventListener('abort', onAbort) }
}
