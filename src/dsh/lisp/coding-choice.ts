import { normalizeTaskType } from '../../akinator/domain.js'
import { TASK_TYPES, type TaskType } from '../../akinator/types.js'
import { ExecutionSelectionPending } from '../model-selection-ui.js'
import { createDshIntakeAnswerer, type DshUserQuestionAgent, type DshUserQuestions } from '../user-interaction.js'

export const LISP_CODING_SERVICE = 'kiokukoLispCoding'
export interface LispCodingInput {
  agent: DshUserQuestionAgent; turn: number; task: string; taskType: TaskType | null; signal: AbortSignal
}
export interface LispCodingResult { taskType: TaskType; clarification?: string }
export interface LispCodingService {
  prepare(input: LispCodingInput): Promise<LispCodingResult>
  enabled(agent: DshUserQuestionAgent): boolean
  discussing(agent: DshUserQuestionAgent): boolean
}

/** Resolve intent and the session's Lisp choice before binding its tool catalog. */
export function createLispCodingChoice(input: {
  questions?: DshUserQuestions
  enabled(agent: DshUserQuestionAgent): boolean
  decided(agent: DshUserQuestionAgent): Promise<boolean>
  decline(agent: DshUserQuestionAgent): Promise<void>
  enable(agent: DshUserQuestionAgent): Promise<void>
}): LispCodingService {
  const turns = new WeakMap<object, { turn: number; task: string; result: Promise<LispCodingResult> }>()
  const discussions = new WeakSet<object>()
  const prepare = async (request: LispCodingInput): Promise<LispCodingResult> => {
    request.signal.throwIfAborted()
    let taskType = request.taskType
    if (taskType === null) {
      if (!input.questions) throw new ExecutionSelectionPending()
      taskType = normalizeTaskType(await createDshIntakeAnswerer(input.questions).ask({
        id: 'taskType', prompt: '今回は何をしてほしいですか？', options: [...TASK_TYPES], required: true,
      }, request.signal, request.agent))
    }
    if (taskType !== 'build' && taskType !== 'debug') return { taskType }
    if (input.enabled(request.agent)) {
      await input.enable(request.agent)
      request.signal.throwIfAborted()
      discussions.delete(request.agent)
      return { taskType }
    }
    const decided = await input.decided(request.agent)
    request.signal.throwIfAborted()
    if (decided) { discussions.delete(request.agent); return { taskType } }
    if (!input.questions) throw new ExecutionSelectionPending()
    const use = 'Lispモードを使う（通常実行）', skip = 'Lispモードを使わない', cancel = '取消・作業を保持'
    const response = await input.questions.ask({ agent: request.agent, signal: request.signal, questions: [{
      id: 'lisp-coding-mode', header: 'コーディングの準備', question: 'コーディングにLispモードを使いますか？',
      detail: 'Lispを使うと、計算やファイル操作を保護されたCommon Lisp環境で行います。起動後はLisp用ツールで通常実行します。役小角を使う場合は「使わない」を選んでください。選択はこのセッションで保持します。自由入力で相談や訂正もできます。',
      options: [use, skip, cancel].map(label => ({ label })),
    }] })
    request.signal.throwIfAborted()
    const answer = response.answers[0]
    if (answer.id !== 'lisp-coding-mode' || answer.selected.length > 1 || answer.selected[0] === cancel) throw new ExecutionSelectionPending()
    const custom = answer.custom?.trim()
    const value = custom || answer.selected[0]
    const choice = /^\d+$/u.test(value ?? '') ? [use, skip, cancel][Number(value) - 1] : value
    if (!choice || choice === cancel) throw new ExecutionSelectionPending()
    if (choice === use) await input.enable(request.agent)
    else if (choice === skip) await input.decline(request.agent)
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
    discussing: agent => discussions.has(agent),
    prepare(request) {
      const previous = turns.get(request.agent)
      if (previous?.turn === request.turn) {
        if (previous.task !== request.task) return Promise.reject(new ExecutionSelectionPending())
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
