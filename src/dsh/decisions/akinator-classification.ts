import { TASK_TYPES, type TaskType } from '../../akinator/types.js'
import type { DecisionBatch } from './contracts.js'
import type { DecisionService } from './service.js'

/** A bounded current-request decision, not a generated intake profile. */
export const AKINATOR_CLASSIFICATION_POLICY = 'akinator-direct-intent-v6-coding'
export const MAX_AKINATOR_TASK_BYTES = 512

export const AKINATOR_AUTOMATED_TASK_TYPES = ['build', 'debug', 'research', 'writing', 'chat'] as const satisfies readonly TaskType[]
const intentions: Readonly<Record<(typeof AKINATOR_AUTOMATED_TASK_TYPES)[number], string>> = Object.freeze({
  build: 'Implement or add software functionality.',
  debug: 'Diagnose or fix a software bug.',
  research: 'Look up sources.',
  writing: 'Write or transform prose.',
  chat: 'Answer questions, advise, or converse.',
})

/** A confirmation or unresolved reference cannot establish intent without its prior turn. */
function needsPriorContext(task: string): boolean {
  const text = task.trim().toLowerCase().replace(/[.!?。！？\s]+$/u, '')
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

const JAPANESE_DIRECT_ACTION = '(?:調べて|調査して|比較して|探して|要約して|執筆して|書いて|まとめて|翻訳して|書き直して|修正して|直して|診断して|実装して|追加して|作成して|開発して|構築して)'
const JAPANESE_COMBINED_ACTIONS = new RegExp(`(?:${JAPANESE_DIRECT_ACTION}|実装して|追加して|作成して|開発して|構築して|レビューして|検証して|確認して|デプロイして|集計して|分析して|運用して)(?=.{0,128}${JAPANESE_DIRECT_ACTION})`, 'u')
const JAPANESE_REQUEST_END = new RegExp(`${JAPANESE_DIRECT_ACTION}(?:ください|下さい)?[。.!！\\s]*$`, 'u')

/**
 * A deliberately narrow admission contract: one short, direct request without
 * quotation, source material, negation or combined actions. This does not assign
 * a task type. Unrecognized wording is left to the ordinary user question.
 */
function isDirectSingleRequest(task: string): boolean {
  const text = task.trim()
  if (/[\n\r"'`“”‘’「」『』:：;；?？]/u.test(text) || /[.!。！]\s*\S/u.test(text)) return false
  if (/\b(?:not|never|without|no|and|then|or|but|instead|unless|either|while|after|before)\b/iu.test(text)) return false
  if (/(?:ない|ません|せず|禁止|不要|それとも|または|あるいは|か[^。！？]*か)/u.test(text)) return false
  if (JAPANESE_COMBINED_ACTIONS.test(text)) return false
  return /^(?:please\s+)?(?:build|implement|add|create|fix|debug|diagnose|resolve|repair|investigate|research|find|look up|compare|write|draft|compose|rewrite|translate|summari[sz]e)\b/iu.test(text)
    || JAPANESE_REQUEST_END.test(text)
}

/** Risk admission runs before either punctuation path. This is not an intent classifier. */
function hasUnresolvedExecutionScope(task: string): boolean {
  const text = task.trim()
  // Unsupported or target-free actions cannot gain admission by adding a question mark.
  if (/(?:レビューして|デプロイして|運用して)/u.test(text)
    || /^(?:(?:please|can you|could you|would you|will you)\s+)?(?:deploy|release|review|delete|remove|send)\b/iu.test(text)) return true
  // New build wording needs an explicit target; references still require intake.
  if (/^(?:(?:please|can you|could you|would you|will you)\s+)?(?:build|implement|add|create)(?:\s+(?:it|this|that))?[?？。.!！\s]*$/iu.test(text)
    || /^(?:(?:これ|それ|あれ)(?:を)?)?(?:実装して|追加して|作成して|開発して|構築して)(?:ください|下さい|くれますか)?[?？。.!！\s]*$/u.test(text)) return true
  const japaneseActions = text.match(/(?:調べて|調査して|比較して|探して|要約して|執筆して|書いて|まとめて|翻訳して|書き直して|修正して|直して|診断して|実装して|追加して|作成して|開発して|構築して|レビューして|検証して|確認して|デプロイして|集計して|分析して|運用して)/gu)
  if ((japaneseActions?.length ?? 0) > 1) return true
  if (/\b(?:and|then|after|before|but|or)\s+(?:(?:please|also)\s+)?(?:fix|debug|repair|investigate|research|find|look up|write|draft|translate|summari[sz]e|build|implement|add|create|deploy|release|review|delete|remove|send)\b/iu.test(text)) return true
  if (/\b(?:not|never|don't|do not)\s+(?:fix|build|implement|change|deploy|send|delete|remove)\b/iu.test(text)
    || /(?:変更せず|直さず|修正せず)/u.test(text)) return true
  return /^(?:(?:can|could|would|will) you (?:do|fix|change|delete) (?:that|it|this)|それをお願いできますか|それはどういう意味)[?？。.!！\s]*$/iu.test(text)
}

/** Admit a bounded question to the model; punctuation alone never assigns chat. */
function isDirectSingleQuestion(task: string): boolean {
  const text = task.trim()
  if (/[\n\r"'`“”‘’「」『』:：;；]/u.test(text) || /[.!。！]\s*\S/u.test(text)) return false
  return /^[^?？]*[?？][。.!！\s]*$/u.test(text)
    || /(?:か|かな|教えて(?:ください|下さい)?)[。.!！\s]*$/u.test(text) && !/[?？]/u.test(text)
}

/** Preserve the complete eligible request. No excerpts, history or generated profile slots. */
export function buildAkinatorClassificationBatch(task: string): DecisionBatch | undefined {
  if (!task.trim() || Buffer.byteLength(task, 'utf8') > MAX_AKINATOR_TASK_BYTES || needsPriorContext(task)
    || hasUnresolvedAlternatives(task) || hasUnresolvedExecutionScope(task) || !(isDirectSingleRequest(task) || isDirectSingleQuestion(task))) return undefined
  return {
    purpose: 'akinator',
    state: task,
    questions: [{
      id: 'task-type',
      instructions: 'Choose intent; abstain if unclear or unsupported.',
      choices: [...AKINATOR_AUTOMATED_TASK_TYPES.map(id => ({ id, description: intentions[id] })),
        { id: 'abstain', description: 'Review, deploy, analyze, or unclear.' }],
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
