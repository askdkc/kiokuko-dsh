import type { AkinatorQuestion } from '../../akinator/types.js'
import { classifyTaskForIntake } from './akinator-classification.js'
import { inferAkinatorExpected, type AkinatorExpectedModel } from './akinator-expected.js'
import type { DecisionService } from './service.js'

export type AkinatorAnswer = { status: 'answered'; value: string; source?: 'main-model' } | { status: 'ask' | 'disabled' }

/** Select actual request evidence in its host-bound workspace. The directory
 * supplies context; it is not a fabricated file target or completion promise. */
export async function answerAkinatorQuestion(
  service: DecisionService | undefined, requestId: string, task: string,
  question: AkinatorQuestion, signal: AbortSignal, evidence: readonly string[] = [],
  workspaceDirectory?: string, mainModel?: AkinatorExpectedModel,
): Promise<AkinatorAnswer> {
  if (question.id === 'expected') {
    const expected = mainModel && await inferAkinatorExpected(mainModel, task, signal)
    return expected === undefined ? { status: 'ask' } : { status: 'answered', value: expected, source: 'main-model' }
  }
  if (!service || (await service.bind(requestId, signal)).mode === 'off') return { status: 'disabled' }
  if (question.id === 'taskType') {
    const result = await classifyTaskForIntake(service, requestId, task, undefined, signal)
    return result.taskType ? { status: 'answered', value: result.taskType } : { status: 'ask' }
  }
  const sources = task.length <= 4000 ? [task] : task.split(/\r?\n/u)
  const candidates = [...new Set([...sources, ...evidence].map(value => value.trim()).filter(value => value.length > 0 && value.length <= 4000))].slice(0, 16)
  if (candidates.length) {
    const outcome = await service.evaluate(requestId, {
      purpose: 'akinator',
      state: { task, question: question.prompt, candidates, ...(workspaceDirectory ? { workspaceDirectory } : {}) },
      questions: [{ id: `intake-${question.id}`,
        instructions: `Select source text that explicitly and unambiguously answers the user's intended action target. Interpret references to this repository/workspace using the host-bound workspaceDirectory. A named feature or reported defect can identify work within that workspace without naming its source file. A requested behavioral correction can state the success condition without a separate restatement. A candidate must contain the answer, not merely ask for one. The directory alone does not resolve an unspecified file or operation. Preserve unresolved pronouns, quotations and negations; do not invent completion promises. Abstain when source evidence does not answer this question. This is clarification only, never authorization.`,
        choices: [...candidates.map((description, index) => ({ id: `source-${index}`, description })), { id: 'abstain', description: 'The answer is unclear; ask the human this question.' }],
        abstainId: 'abstain' }],
    }, signal, 'akinator-source-answers-51-v1')
    const answer = outcome.status === 'completed' ? outcome.result.answers[0] : undefined
    const index = answer?.status === 'selected' && /^source-\d+$/u.test(answer.choiceId) ? Number(answer.choiceId.slice(7)) : -1
    const value = candidates[index]
    if (value !== undefined) return { status: 'answered', value }
  }
  signal.throwIfAborted()
  return { status: 'ask' }
}
