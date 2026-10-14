/** Narrow missing-scope checks, not an intent classifier or an authorization grant. */
import { rebindRequestIntentDecision } from './decisions/request-intent.js'
const continuationReference = /^(?:yes|no|ok|okay|sure|go ahead|do it|continue|same as before|はい|いいえ|了解|お願いします|お願い|続けて|続き|さっきの続きで)$/iu
function normalizedTask(task: string): string { return task.trim().replace(/[?？。.!！\s]+$/u, '') }
export function isContinuationReference(task: string): boolean { return continuationReference.test(normalizedTask(task)) }

export function executionClarification(task: string, intent?: import('./decisions/request-intent.js').RequestIntentDecision,
  context?: import('./decisions/request-intent.js').RequestIntentContext): string | undefined {
  const text = normalizedTask(task)
  const englishReference = /^(?:(?:please|can you|could you|would you|will you)\s+)?(?:do|fix|repair|change|delete|remove|erase|send|deploy|run|search|research|fetch|look up)\s+(?:it|this|that|these|those)(?:\s+(?:one|ones|file|files|thing|things))?(?:\s+please)?$/iu
  const japaneseReference = /^(?:これ|それ|あれ|ここ|そこ|あそこ|こちら|そちら)(?:の(?:ファイル|内容|データ))?(?:を|は)?(?:消して|削除して|消去して|変更して|直して|修正して|送って|送信して|実行して|デプロイして|検索して|調べて|調査して|取得して|お願い)(?:ください|下さい|くれる|くれますか|もらえる|もらえますか|できますか|してもいい|できる)?$/u
  const bound = intent && context?.task === task ? rebindRequestIntentDecision(intent, context) : undefined
  const resolvedContinuation = isContinuationReference(text) && bound?.relation === 'same_scope_continuation'
    && bound.action !== 'unknown' && bound.action !== 'answer' && (!!context?.activeGoal || !!context?.activeTask?.request)
  const resolvedReference = bound && bound.relation !== 'unknown' && bound.action !== 'unknown' && bound.action !== 'answer'
    && (bound.relation === 'same_scope_continuation' && (!!context?.activeGoal?.target || !!context?.activeTask?.request) || bound.evidence.proposalRefs.length > 0)
  if ((englishReference.test(text) || japaneseReference.test(text)) && !resolvedReference
    || isContinuationReference(text) && !resolvedContinuation) {
    return 'The original request does not identify the action target. Ask which concrete file, item, recipient or operation the user means before preparing work; do not substitute the current directory as the target.'
  }
  const alternatives = /\b(?:or|versus|vs|whether)\b/iu.test(text)
    && /\b(?:undecided|unsure|uncertain|not\s+(?:yet\s+)?(?:decided|chosen|sure)|(?:haven\x27t|have not|can\x27t|cannot)\s+(?:yet\s+)?(?:decided|chosen|decide|choose))\b/iu.test(text)
    || /(?:か[^。！？]*か|それとも|または|あるいは|どちら|どっち)/u.test(text)
      && /(?:未定|未決|未確定|決め(?:て)?(?:い)?ない|決まって(?:い)?ない|決められ|迷って|判断でき|わからない|分からない)/u.test(text)
  if (alternatives) return 'The user has not chosen between the requested alternatives. Discuss or ask which concrete action to take before preparing execution; an advisory task type cannot make that decision.'
  return undefined
}
