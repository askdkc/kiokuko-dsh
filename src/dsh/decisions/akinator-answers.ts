import type { AkinatorQuestion } from '../../akinator/types.js'
import { classifyTaskForIntake } from './akinator-classification.js'
import type { DecisionService } from './service.js'

export type AkinatorAnswer = { status: 'answered'; value: string } | { status: 'ask' | 'disabled' }

/** Select only actual source text. The decision validates that it answers this
 * question; the cwd or a generic completion promise is never an answer. */
export async function answerAkinatorQuestion(
  service: DecisionService | undefined, requestId: string, task: string,
  question: AkinatorQuestion, signal: AbortSignal, evidence: readonly string[] = [],
): Promise<AkinatorAnswer> {
  if (!service || (await service.bind(requestId, signal)).mode === 'off') return { status: 'disabled' }
  if (question.id === 'taskType') {
    const result = await classifyTaskForIntake(service, requestId, task, undefined, signal)
    return result.taskType ? { status: 'answered', value: result.taskType } : { status: 'ask' }
  }
  const sources = task.length <= 4000 ? [task] : task.split(/\r?\n/u)
  const candidates = [...new Set([...sources, ...evidence].map(value => value.trim()).filter(value => value.length > 0 && value.length <= 4000))].slice(0, 16)
  if (!candidates.length) return { status: 'ask' }
  const outcome = await service.evaluate(requestId, {
    purpose: 'akinator',
    state: { task, question: question.prompt, candidates },
    questions: [{ id: `intake-${question.id}`,
      instructions: `Select source text that explicitly and unambiguously answers the user's ${question.id === 'target' ? 'intended action target' : 'success/completion criteria'}. A candidate must contain the answer, not merely ask for one. Do not treat a working directory, unresolved pronoun, quotation, negation or generic promise as a resolved answer. Abstain when source evidence does not answer this question. This is clarification only, never authorization.`,
      choices: [...candidates.map((description, index) => ({ id: `source-${index}`, description })), { id: 'abstain', description: 'The answer is unclear; ask the human this question.' }],
      abstainId: 'abstain' }],
  }, signal, 'akinator-source-answers-51-v1')
  if (outcome.status !== 'completed') return { status: 'ask' }
  const answer = outcome.result.answers[0]
  const index = answer?.status === 'selected' && /^source-\d+$/u.test(answer.choiceId) ? Number(answer.choiceId.slice(7)) : -1
  const value = candidates[index]
  return value === undefined ? { status: 'ask' } : { status: 'answered', value }
}
