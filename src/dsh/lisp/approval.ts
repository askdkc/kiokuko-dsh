import type { DshUserQuestions } from '../user-interaction.js'
export type Approval = { approved: true } | { approved: false; reason: 'declined' | 'cancelled' | 'timed_out' | 'unavailable' | 'invalid_answer' }

/** One concrete review; no timeout, UI failure or free text can grant authority. */
export async function confirm(questions: DshUserQuestions | undefined, agentId: string,
  question: Parameters<DshUserQuestions['ask']>[0]['questions'][0], signal: AbortSignal, timeoutMs = 300000): Promise<Approval> {
  if (signal.aborted) return { approved: false, reason: 'cancelled' }
  if (!questions) return { approved: false, reason: 'unavailable' }
  const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  let onAbort: (() => void) | undefined
  try {
    const answer = await Promise.race([questions.ask({ agent: { id: agentId }, signal: combined, questions: [question] }),
      new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); if (combined.aborted) onAbort(); else combined.addEventListener('abort', onAbort, { once: true }) })])
    if (combined.aborted) return { approved: false, reason: signal.aborted ? 'cancelled' : 'timed_out' }
    if (!answer) return { approved: false, reason: 'unavailable' }
    const response = answer.answers[0]
    if (answer.answers.length !== 1 || response?.id !== question.id || response.custom || response.selected.length !== 1) return { approved: false, reason: 'invalid_answer' }
    if (response.selected[0] === question.intent?.approve) return { approved: true }
    return { approved: false, reason: response.selected[0] === question.options?.[0]?.label ? 'declined' : 'invalid_answer' }
  } catch { return { approved: false, reason: signal.aborted ? 'cancelled' : timeout.signal.aborted ? 'timed_out' : 'unavailable' } }
  finally { clearTimeout(timer); if (onAbort) combined.removeEventListener('abort', onAbort) }
}
