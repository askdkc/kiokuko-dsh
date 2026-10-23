import type { DshUserQuestions } from './intake-questions.js'

/** A settled ask is never pending. Hiding a named DSH card leaves ask unresolved. */
export type LispCodingQuestionResult =
  | { status: 'answered'; choice: 'yes' | 'no'; answerRef: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: string }

export class LispCodingCancelled extends Error {
  readonly code = 'ASK_CANCELLED'
  constructor(message = 'Lisp choice cancelled; this implementation attempt stopped and work is retained.') { super(message) }
}
export function parseLispCodingChoice(answer: { selected?: readonly string[]; custom?: string }): 'yes' | 'no' | 'cancelled' | undefined {
  if (answer.selected !== undefined && !Array.isArray(answer.selected) || (answer.selected?.length ?? 0) > 1) return undefined
  const text = (answer.custom?.trim() || answer.selected?.[0] || '').trim().normalize('NFKC')
  if (/^(?:1|使う|yes|use lisp|Lispモードを使う\(通常実行\))$/iu.test(text)) return 'yes'
  if (/^(?:2|使わない|no|do not use lisp|Lispモードを使わない)$/iu.test(text)) return 'no'
  if (/^(?:3|取消|キャンセル|cancel|取消・作業を保持)$/iu.test(text)) return 'cancelled'
  // DSH's submitted Skip has an empty selected array. Missing/malformed answers
  // are unavailable, not a user cancellation. Panel hide never settles ask.
  if (answer.selected?.length === 0 && !answer.custom?.trim()) return 'cancelled'
  return undefined
}
export function normalizeLispCodingAnswer(response: unknown, questionId: string): LispCodingQuestionResult {
  const answers = (response as any)?.answers
  if (!Array.isArray(answers) || answers.length !== 1 || answers[0]?.id !== questionId)
    return { status: 'unavailable', reason: 'Answer does not match the active question' }
  const answer = answers[0]
  if (!Array.isArray(answer.selected) || !answer.selected.every((v: unknown) => typeof v === 'string')
    || answer.custom !== undefined && typeof answer.custom !== 'string') return { status: 'unavailable', reason: 'Malformed answer' }
  const choice = parseLispCodingChoice(answer)
  return choice === 'cancelled' ? { status: 'cancelled', reason: 'User cancelled or skipped this question' }
    : choice ? { status: 'answered', choice, answerRef: `userQuestions:${questionId}` }
    : { status: 'unavailable', reason: 'Invalid Lisp choice' }
}
export async function askLispCodingQuestion(questions: DshUserQuestions | undefined, request: Parameters<DshUserQuestions['ask']>[0]): Promise<LispCodingQuestionResult> {
  if (!questions) return { status: 'unavailable', reason: 'Question service is unavailable' }
  try { return normalizeLispCodingAnswer(await questions.ask(request), request.questions[0].id) }
  catch (error) {
    if ((error as { code?: unknown })?.code === 'ASK_CANCELLED') return { status: 'cancelled', reason: 'User cancelled the question' }
    if (request.signal?.aborted) return { status: 'cancelled', reason: 'Request was aborted' }
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}
