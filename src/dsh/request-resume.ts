import { canonicalContentHash } from '../serialization/validate.js'
import { taskCanExecute } from './task-state.js'
import { bindMainModelRequestIntent, rebindRequestIntentDecision, requestIntentIsUnresolved,
  requestIntentReferenceIds, type RequestIntentContext, type RequestIntentDecision } from './decisions/request-intent.js'

/** Revalidate unchanged scope after a host-committed resume. No previous digest or
 * execution lease is copied; the ordinary preparation/permission path still runs. */
export function revalidateResumedRequest(decision: RequestIntentDecision | undefined,
  before: RequestIntentContext, after: RequestIntentContext): RequestIntentDecision | undefined {
  const prior = before.activeTask, current = after.activeTask
  const bound = rebindRequestIntentDecision(decision, before)
  if (!bound || requestIntentIsUnresolved(bound) || bound.relation !== 'same_scope_continuation' ||
    bound.taskOperation || !prior || !current || prior.pendingStop || current.pendingStop || !taskCanExecute(current) ||
    current.revision !== prior.revision + 1 || current.generation !== prior.generation + 1) return undefined
  const identity = (task: typeof prior) => [task.taskId, task.runId, task.sessionId, task.repositoryRoot, task.type, task.request]
  if (canonicalContentHash(identity(prior)) !== canonicalContentHash(identity(current))) return undefined
  const { activeTask: _beforeTask, ...beforeScope } = before
  const { activeTask: _afterTask, ...afterScope } = after
  if (canonicalContentHash(beforeScope) !== canonicalContentHash(afterScope)) return undefined
  const selected = new Set(bound.evidence.proposalRefs.map(proposal =>
    `proposal:${canonicalContentHash([proposal.id, proposal.revision, proposal.digest])}`))
  const rebound = bindMainModelRequestIntent({ relation: bound.relation, action: bound.action, changeScope: bound.changeScope,
    evidenceRefs: requestIntentReferenceIds(after).filter(ref => !ref.startsWith('proposal:') || selected.has(ref)) }, after)
  return rebound ? { ...rebound, source: bound.source, providerSent: bound.providerSent } : undefined
}
