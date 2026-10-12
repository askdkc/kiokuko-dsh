import { executionClarification } from '../intake-clarification.js'
import { rebindRequestIntentDecision, type RequestIntentDecision, type RequestIntentContext, type RequestAction } from '../decisions/request-intent.js'
import type { TaskType } from '../../akinator/types.js'

/** Native admission owns interpretation. Only legacy direct callers infer from text. */
export function codingWorkRequested(task: string, intent?: RequestIntentDecision, taskType?: TaskType | null): boolean {
  return intent === undefined ? codingIntent(task) : intent.action === 'change' && taskType !== 'writing'
}

/** Effect categories are a tool contract, never another interpretation of the user. */
export function codingToolEffect(name: string): 'read' | 'change' | 'process' | 'unknown' {
  if (codingControlOrRead(name)) return 'read'
  if (['kioku_write', 'kioku_edit', 'kioku_remove', 'write', 'edit', 'delete', 'remove'].includes(name)) return 'change'
  if (['kioku_exec', 'bash', 'zsh', 'exec', 'run_code', 'lisp_eval', 'lisp_load', 'lisp_compile', 'lisp_run'].includes(name)) return 'process'
  return 'unknown'
}

/** Both native dispatch and the owned executor consume this same bound decision. */
export function executionRequestAction(decision: RequestIntentDecision | undefined, context: RequestIntentContext | undefined,
  name: string): RequestAction | undefined {
  if (!decision) return undefined // Legacy direct callers keep their existing workflow checks.
  const effect = codingToolEffect(name)
  if (effect === 'read') return decision.action // Evidence gathering cannot acquire effect authority.
  const intent = context && rebindRequestIntentDecision(decision, context)
  if (!intent || intent.relation === 'unknown' || intent.action === 'unknown')
    throw new Error('A current source-bound request interpretation is required before execution.')
  if (intent.action === 'answer' || intent.action === 'research'
    || intent.action === 'verify' && effect !== 'process')
    throw new Error('This request authorizes inspection or verification, not artifact changes. Native permissions remain in force.')
  return intent.action
}

/** An explicit README text edit stays on the document path unless code/config is also requested. */
export function documentEditIntent(task: string): boolean {
  if (!/\bREADME(?:\.(?:md|rst|txt))?\b/iu.test(task)
    || /(?:\.(?:[cm]?[jt]sx?|svelte|py|lisp|json|ya?ml|toml)\b|\b(?:code|runtime|config|behavior|function|api)\b|コード|挙動|関数|設定)/iu.test(task)
    || /(?:\b(?:do not|don't|never|explain|describe|what|why|how|should)\b|(?:修正|変更|編集)(?:しない|するな|すべき)|[?？]|^\s*[>"“「`~])/imu.test(task)) return false
  return /^(?:(?:please|can you|could you|would you|help me)\s+)?(?:edit|revise|fix|repair|modify|update|write|create|add)\b/iu.test(task.trim())
    || /(?:修正|変更|編集|追記)(?:して|してください|も実装して)/u.test(task)
}
/** Legacy document recovery may use a short, unambiguous human continuation. */
export function documentContinuation(task: string): boolean {
  return /^(?:(?:please\s+)?(?:continue|resume)|続けて(?:ください)?|続行してください)[.!。！]?$/iu.test(task.trim())
}

/** Conservative human intent evidence, independent of advisory task labels. */
export function codingIntent(task: string): boolean {
  let fence: string | undefined
  const lines: string[] = []
  for (const line of task.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue }
    if (!fence && !/^\s*(?:>|["“「]|(?:read|write) paths\s*:)/iu.test(line)) lines.push(line.trim())
  }
  const request = lines.join('\n')
  if (executionClarification(request)) return false
  if (documentEditIntent(request)) return false
  if (/\b(?:write|create|draft)\s+(?:an?\s+)?(?:email|letter|message|report|document|post)\b/iu.test(request)
    || /(?:案内文|メール|記事|文章|文書|レポート)を(?:書|作|保存)/u.test(request)) return false
  if (/(?:\b(?:do not|don't|never)\s+(?:implement|change|edit|fix|write|modify)|コード変更は行わない|(?:実装|変更|修正)(?:しない|するな|は不要))/iu.test(request)) return false
  if (/^(?:explain|describe|what|why|how|should\s+(?:we|i)|is\s+it|(?:can|could)\s+(?:this|it))\b/iu.test(request)
    || /(?:修正すべき|実装すべき|(?:説明|解説)(?:して|しろ)|(?:計画|プラン)(?:だけ|のみ)|(?:計画|プラン)を(?:作|立))/u.test(request)) return false
  return lines.some(line => /^(?:(?:please|can you|could you|would you|help me|i want you to)\s+)?(?:implement|fix|repair|add|create|build|refactor|update|modify|change|write)\b/iu.test(line)
    || /(?:実装して|実装しろ|修正して|直して|追加して|変更して|作って|作成して|更新して|リファクタリングして)/u.test(line))
}

/** Explicit continuation preserves the old task; a new action gets a new choice. */
export function codingContinuation(task: string): boolean {
  return /^(?:please\s+)?(?:continue|resume)(?:\s+(?:the|this|my))?\s+(?:(?:current|same|previous)\s+)?task(?:\s+without changing its scope)?[.!。！]?$/iu.test(task.trim())
    || /^(?:この|同じ|現在の|前の)?(?:タスク|作業)(?:を)?(?:再開|続行|継続)(?:して|してください)[。！!]?$/u.test(task.trim())
}

const readers = new Set(['read', 'glob', 'grep', 'skill', 'web_search', 'web_fetch', 'kioku_read', 'kioku_result',
  'task_memory_review', 'task_completion', 'coding_workflow', 'prepare_requested_work', 'ask_user_question',
  'coding_workflow_apply', 'coding_workflow_blocker',
  'exit_plan_mode', 'lisp_status', 'lisp_hot_status', 'lisp_describe', 'lisp_inspect', 'lisp_cancel', 'observation_read', 'enno_work_report',
  'enno_ideal_submit', 'enno_plan_submit', 'enno_plan_review', 'enno_finish', 'enno_meditation_submit', 'memory_checkpoint', 'curator_check', 'memory_explain'])
export function codingControlOrRead(name: string): boolean { return readers.has(name) }
export function codingControlCarrier(name: string, arguments_: unknown): boolean {
  const tool = codingLiteralCarrier(name, arguments_)
  return tool !== undefined && codingControlOrRead(tool)
}
export function codingLiteralCarrier(name: string, arguments_: unknown): string | undefined {
  if (name !== 'run_code' || !arguments_ || typeof arguments_ !== 'object') return undefined
  const code = (arguments_ as {code?:unknown}).code
  if (typeof code !== 'string') return undefined
  const source = code.trim()
  const match = source.startsWith('return JSON.stringify(')
    ? source.match(/^return JSON\.stringify\(await tools\.([a-z_]+)\((.*)\)\);?$/u)
    : source.match(/^return await tools\.([a-z_]+)\((.*)\);?$/u)
  if (!match) return undefined
  try { const input = JSON.parse(match[2]!); return input !== null && typeof input === 'object' && !Array.isArray(input) ? match[1] : undefined } catch { return undefined }
}
/** Extension authors may mark their pinned host definition as a read operation. */
export const CODING_READ_ONLY = Symbol.for('kiokuko.coding.read-only')
export function codingMutationTool(name: string): boolean {
  return /^(?:kioku_(?:write|edit|remove|exec)|lisp_(?!status|hot_status|inspect|cancel)|run_code|bash|zsh|exec|write|edit|delete|remove)/u.test(name)
}
