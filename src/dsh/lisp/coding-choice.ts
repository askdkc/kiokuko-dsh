import { normalizeTaskType } from '../../akinator/domain.js'
import { TASK_TYPES, type TaskType } from '../../akinator/types.js'
import { ExecutionSelectionPending } from '../execution-pending.js'
import { createDshIntakeAnswerer, type DshUserQuestionAgent, type DshUserQuestions } from '../intake-questions.js'
import { LISP_CODING_SERVICE } from '../lisp-service-key.js'
import { codingIntent } from '../coding-workflow/intent.js'

export { LISP_CODING_SERVICE }
export interface LispCodingInput {
  agent: DshUserQuestionAgent; turn: number; task: string; taskType: TaskType | null; signal: AbortSignal
}
export interface LispCodingResult { taskType: TaskType; clarification?: string }
export interface LispCodingService {
  prepare(input: LispCodingInput): Promise<LispCodingResult>
  prepareNative?(input: LispCodingInput): Promise<void>
  answered?(agent: DshUserQuestionAgent, task: string, choice: 'yes'|'no', answerRef: string): void
  choiceFor?(agent: DshUserQuestionAgent, task: string): { choice: 'yes'|'no'; answerRef: string } | undefined
  enabled(agent: DshUserQuestionAgent): boolean
  discussing(agent: DshUserQuestionAgent): boolean
  activate?(agent: DshUserQuestionAgent): Promise<void>
  exclude?(agent: DshUserQuestionAgent): Promise<void>
}

/** Legacy standalone adapter; production coding choices live in the workflow store before binding its tool catalog. */
export function createLispCodingChoice(input: {
  optional?:boolean
  questions?: DshUserQuestions
  enabled(agent: DshUserQuestionAgent): boolean
  decided(agent: DshUserQuestionAgent): Promise<boolean>
  decline(agent: DshUserQuestionAgent): Promise<void>
  enable(agent: DshUserQuestionAgent): Promise<void>
}): LispCodingService {
  const turns = new WeakMap<object, { turn: number; task: string; result: Promise<LispCodingResult> }>()
  const discussions = new WeakSet<object>()
  const conversations = new WeakSet<object>()
  const taskChoices = new WeakMap<object, string>()
  const prepare = async (request: LispCodingInput): Promise<LispCodingResult> => {
    request.signal.throwIfAborted()
    let taskType = request.taskType ?? (conversations.has(request.agent) ? 'chat' : null)
    if (taskType === null) {
      if (!input.questions) throw new ExecutionSelectionPending()
      taskType = normalizeTaskType(await createDshIntakeAnswerer(input.questions).ask({
        id: 'taskType', prompt: '今回は何をしてほしいですか？', options: [...TASK_TYPES], required: true,
      }, request.signal, request.agent))
    }
    request.signal.throwIfAborted()
    if (taskType === 'chat') conversations.add(request.agent)
    else conversations.delete(request.agent)
    if (taskType !== 'build' && taskType !== 'debug') return { taskType }
    if (!codingIntent(request.task)) return { taskType: 'chat' }
    if (taskChoices.get(request.agent) === request.task && input.enabled(request.agent)) {
      try { await input.enable(request.agent) } catch(error) { if(!input.optional)throw error }
      request.signal.throwIfAborted()
      discussions.delete(request.agent)
      return { taskType }
    }
    const decided = await input.decided(request.agent)
    request.signal.throwIfAborted()
    if (decided && taskChoices.get(request.agent) === request.task) { discussions.delete(request.agent); return { taskType } }
    if (!input.questions) throw new ExecutionSelectionPending()
    const use = 'Lispモードを使う（通常実行）', skip = 'Lispモードを使わない', cancel = '取消・作業を保持'
    const response = await input.questions.ask({ agent: request.agent, signal: request.signal, questions: [{
      id: 'lisp-coding-mode', header: 'コーディングの準備', question: 'コーディングにLispモードを使いますか？',
      detail: 'このタスクで Lisp を使うか選んでください。通常の開発環境と既存の権限・承認を使います。未回答では実装を開始しません。',
      options: [use, skip, cancel].map(label => ({ label })),
    }] })
    request.signal.throwIfAborted()
    const answer = response.answers[0]
    if (!answer) throw new ExecutionSelectionPending()
    if (answer.id !== 'lisp-coding-mode' || answer.selected.length > 1 || answer.selected[0] === cancel) throw new ExecutionSelectionPending()
    const custom = answer.custom?.trim()
    const value = custom || answer.selected[0]
    const choice = /^\d+$/u.test(value ?? '') ? [use, skip, cancel][Number(value) - 1] : value
    if (!choice || choice === cancel) throw new ExecutionSelectionPending()
    if (choice === use) { taskChoices.set(request.agent, request.task); await input.enable(request.agent) }
    else if (choice === skip) { await input.decline(request.agent); taskChoices.set(request.agent, request.task) }
    else if (custom) {
      discussions.add(request.agent)
      return { taskType: 'chat', clarification: custom }
    }
    else throw new ExecutionSelectionPending()
    request.signal.throwIfAborted()
    discussions.delete(request.agent)
    return { taskType }
  }
  return {
    enabled: input.enabled,
    activate: input.enable,
    exclude: input.decline,
    discussing: agent => discussions.has(agent),
    prepare(request) {
      const previous = turns.get(request.agent)
      if (previous?.turn === request.turn && previous.task === request.task) {
        return previous.result
      }
      const result = prepare(request).catch(error => {
        throw error instanceof ExecutionSelectionPending ? error : new ExecutionSelectionPending(error instanceof Error ? error.message : String(error))
      })
      turns.set(request.agent, { turn: request.turn, task: request.task, result })
      return result
    },
  }
}
