import { KiokukoError } from '../errors.js'

export { createDshIntakeAnswerer } from './intake-questions.js'
export type { DshUserQuestionRequest, DshUserQuestionAgent, DshUserQuestionOption, DshUserQuestionAnswer, DshUserQuestions, DshIntakeAnswerer } from './intake-questions.js'
import type { DshUserQuestions, DshUserQuestionAgent } from './intake-questions.js'

/** Internal host failures are not missing task requirements. Keep recovery explicit. */
export function boundaryFailureCopy(language: 'en' | 'ja' | undefined, attempts = 3, retryable = true) {
  const repeated = attempts >= 3
  return language === 'ja' ? {
    header: 'Kiokukoが停止しました',
    title: repeated ? 'Kiokukoの内部処理が3回失敗したため、自動処理を停止しました。'
      : 'Kiokukoの内部処理を安全に続けられないため、自動処理を停止しました。',
    recoveryInstruction: retryable
      ? 'これは依頼内容が不足しているという意味ではありません。下記の内部エラーの原因を解消した後、行った対処と「再試行」を明記してください。「続行」だけでは再実行しません。原因が未解消なら再び停止する可能性があります。空欄・取消では停止したままです。'
      : 'この失敗は同じ入力で自動再試行できません。権限・整合性・未対応操作など原因を確認してください。入力だけで元の操作を再開しません。',
  } : {
    header: 'Kiokuko stopped',
    title: repeated ? 'Kiokuko stopped after three internal processing failures.'
      : 'Kiokuko stopped because the internal operation cannot safely continue.',
    recoveryInstruction: retryable
      ? 'This does not mean your task description is incomplete. After resolving the internal error below, describe the correction and explicitly say retry. Continue alone will not replay the operation. An empty answer or cancellation leaves processing stopped.'
      : 'This operation cannot safely replay with the same input. Inspect the permission, integrity, or unsupported-operation cause. An answer alone does not resume the operation.',
  }
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message)
}

export { conflict as dshUserQuestionConflict }

/** Adapt one explicit user-question answer to a single selection. */
export async function requireSingleSelection(
  service: DshUserQuestions,
  input: { readonly questionId: string; readonly question: string; readonly detail?: string },
  agent?: DshUserQuestionAgent,
  signal?: AbortSignal,
): Promise<string> {
  const result = await service.ask({
    questions: [{
      id: input.questionId,
      question: input.question,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    }],
    ...(agent === undefined ? {} : { agent }),
    ...(signal === undefined ? {} : { signal }),
  })
  const answer = result.answers[0]
  if (answer === undefined || answer.id !== input.questionId) conflict('Answer does not match the current request')
  const selected = answer.selected[0]?.trim()
  if (!selected) conflict('A single selection is required')
  return selected
}
