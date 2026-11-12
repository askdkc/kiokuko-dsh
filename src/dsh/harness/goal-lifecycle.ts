import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { memoryFailureDiagnostic } from '../memory-failure.js'
import { isRequestInput } from '../request-input.js'

/** Optional public Goal capability; profiles without Goals need no dependency. */
interface GoalService {
  get(agent: Agent): { id: string; revision: number; phase: string } | undefined
  clear(agent: Agent, ref: { id: string; revision: number }): unknown
}

/** Retire only a recorded completion, using the domain's revision fence and
 * durable tombstone. A turn ending by itself is never proof of goal success. */
export function clearCompletedGoal(ctx: Context, agent: Agent): void {
  const goals = ctx.get('goals', false) as Partial<GoalService> | undefined
  if (typeof goals?.get !== 'function' || typeof goals.clear !== 'function') return
  try {
    const current = goals.get(agent)
    if (current?.phase === 'complete') goals.clear(agent, { id: current.id, revision: current.revision })
  } catch (error) {
    // A stale ref or unavailable projection must not discard a newer goal or
    // prevent ordinary human input. Keep the failure visible; never force clear.
    ctx.logger.warn(`Kiokuko could not retire a completed goal: ${memoryFailureDiagnostic(error).message}`)
  }
}

/** Native Goal admission rejects spent reservations assuming they have already
 * left the inbox. Kiokuko retains claims until admission: discard only these
 * rejected automatic carriers, never the human input sharing their step. */
export function discardRejectedGoalRounds(agent: Agent, messages: readonly UserMessage[]): boolean {
  const rejected = messages.filter(message => {
    // Goal is an optional plugin's source augmentation, not a required peer.
    const source: { readonly kind: string } = message.source
    return source.kind === 'goal' && isRequestInput(message)
  })
  if (!rejected.length) return false
  for (const message of rejected) {
    if ([...agent.inbox.nextTurn, ...agent.inbox.nextStep].includes(message)) agent.inbox.remove(message.id)
  }
  // The native driver may also restore injected context. Preserve it, but it
  // must remain parked rather than start a new model turn on its own.
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.some(isRequestInput)
}
