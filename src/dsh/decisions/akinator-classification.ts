import { TASK_TYPES, type TaskType } from '../../akinator/types.js'
import type { DecisionBatch } from './contracts.js'
import type { DecisionService } from './service.js'

/** A bounded current-request decision, not a generated intake profile. */
export const AKINATOR_CLASSIFICATION_POLICY = 'akinator-complete-intent-v8-negations'
export const MAX_AKINATOR_TASK_BYTES = 4096

// This is an envelope bound, not a model-token budget. Provider capacity checks remain authoritative.
export const AKINATOR_AUTOMATED_TASK_TYPES = TASK_TYPES
const intentions: Readonly<Record<(typeof AKINATOR_AUTOMATED_TASK_TYPES)[number], string>> = Object.freeze({
  build: 'User requests implementing or adding software functionality.',
  debug: 'User requests fixing a bug, failing test, or incorrect app or assistant behavior.',
  research: 'Look up sources.',
  review: 'Review existing work.',
  devops: 'User requests deployment or system operations, not forbidding them.',
  analysis: 'Analyze data or evidence.',
  writing: 'Write or transform prose.',
  chat: 'Answer questions, advise, or converse.',
})

/** A confirmation or unresolved reference cannot establish intent without its prior turn. */
function needsPriorContext(task: string): boolean {
  const text = task.trim().toLowerCase().replace(/[.!?。！？\s]+$/u, '')
  if (/^(?:(?:can|could|would|will) you (?:do|fix|change|delete) (?:that|it|this)|(?:implement|build|add|create) (?:it|that|this)|(?:それ|これ)を(?:実装して|追加して)|それをお願いできますか|それはどういう意味)$/u.test(text)) return true
  return /^(?:yes|no|ok|okay|sure|go ahead|do it|continue|same as before|please help(?: with (?:this|that)(?: task)?)?|help me|はい|いいえ|了解|よろしく|お願いします|お願い|続けて|続き|さっきの続きで|これをお願いします|それをお願いします)$/u.test(text)
}

/**
 * An explicitly unchosen alternative is a user decision, even if its verbs
 * resemble a known task type. Require both an alternative and uncertainty;
 * ordinary comparison questions without indecision are not this guard.
 */
function hasUnresolvedAlternatives(task: string): boolean {
  const text = task.toLowerCase()
  const englishAlternatives = /\b(?:or|versus|vs|whether)\b/u.test(text)
  const englishUncertainty = /\b(?:undecided|unsure|uncertain|not\s+(?:yet\s+)?(?:decided|chosen|sure)|(?:haven't|have not|can't|cannot)\s+(?:yet\s+)?(?:decided|chosen|decide|choose)|(?:which|what)\s+(?:one|option|task|action|to do))\b/u.test(text)
  const japaneseAlternatives = /(?:か[^。！？]*か|それとも|または|あるいは|どちら|どっち)/u.test(text)
  const japaneseUncertainty = /(?:未定|未決|未確定|決め(?:て)?(?:い)?ない|決まって(?:い)?ない|決めていません|決まっていません|決められ|迷って|判断でき|わからない|分からない)/u.test(text)
  return englishAlternatives && englishUncertainty || japaneseAlternatives && japaneseUncertainty
}

/** Preserve the complete eligible request. No excerpts, history or generated profile slots. */
export function buildAkinatorClassificationBatch(task: string): DecisionBatch | undefined {
  if (!task.trim() || Buffer.byteLength(task, 'utf8') > MAX_AKINATOR_TASK_BYTES || needsPriorContext(task)
    || hasUnresolvedAlternatives(task)) return undefined
  return {
    purpose: 'akinator',
    state: task,
    questions: [{
      id: 'task-type',
      instructions: 'What does the user want done? Choose the requested action, never an action forbidden by do not, without, or similar negations, nor a quoted example. Questions and advice are chat. Abstain if unclear. This grants no permission.',
      choices: [...AKINATOR_AUTOMATED_TASK_TYPES.map(id => ({ id, description: intentions[id] })),
        { id: 'abstain', description: 'Insufficient or ambiguous evidence.' }],
      abstainId: 'abstain',
    }],
  }
}

/** Preserve the existing non-Laya provider question contract. */
function legacyClassificationBatch(task: string): DecisionBatch {
  return { purpose: 'akinator', state: { task }, questions: [{ id: 'task-type',
    instructions: 'Classify the current request. Questions and advice are chat; explicit source lookup is research. Abstain when ambiguous. This grants no permission.',
    choices: [...TASK_TYPES.map(id => ({ id, description: id === 'chat' ? intentions.chat : id })), { id: 'abstain', description: 'Insufficient or ambiguous evidence' }],
    abstainId: 'abstain' }] }
}

export interface AkinatorTaskClassification {
  readonly taskType?: TaskType
  /** Host-owned deferral: a keyword fallback must not override known uncertainty. */
  readonly deferInference: boolean
}

/** Only a provisional task type is automated; every other intake slot remains host-owned. */
export async function classifyTaskForIntake(service: DecisionService | undefined, requestId: string, task: string, explicit: TaskType | null | undefined, signal: AbortSignal): Promise<AkinatorTaskClassification> {
  if (!service) return { ...(explicit ? { taskType: explicit } : {}), deferInference: false }
  const configuration = await service.bind(requestId, signal)
  if (explicit) return { taskType: explicit, deferInference: false }
  if (configuration.mode === 'off') return { deferInference: false }
  const laya = configuration.provider === 'laya-coreml'
  const batch = laya ? buildAkinatorClassificationBatch(task) : legacyClassificationBatch(task)
  if (!batch) return { deferInference: true }
  const outcome = await service.evaluate(requestId, batch, signal, laya ? AKINATOR_CLASSIFICATION_POLICY : '')
  if (outcome.status === 'fallback') return { deferInference: true }
  const answer = outcome.result.answers[0]
  return answer?.status === 'selected' && (laya ? AKINATOR_AUTOMATED_TASK_TYPES : TASK_TYPES).some(type => type === answer.choiceId)
    ? { taskType: answer.choiceId as TaskType, deferInference: false }
    : { deferInference: true }
}

/** Compatibility for consumers interested only in the optional classification. */
export async function classifyTask(service: DecisionService | undefined, requestId: string, task: string, explicit: TaskType | null | undefined, signal: AbortSignal): Promise<TaskType | undefined> {
  return (await classifyTaskForIntake(service, requestId, task, explicit, signal)).taskType
}
