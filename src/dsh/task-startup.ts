import { canonicalContentHash } from '../serialization/validate.js'
import { abortable } from './http-json.js'
import { LispCodingCancelled } from './coding-question.js'
import { codingContinuation } from './coding-workflow/intent.js'
import { dshTurnRequestId } from './intake-profile-resolver.js'
import { ExecutionSelectionPending } from './execution-pending.js'
import type { DshUserQuestions } from './intake-questions.js'
import { selectedDecisionSettings, type DecisionConfiguration } from './decisions/config.js'
import type { DecisionService } from './decisions/service.js'
import type { LispCodingInput, LispCodingService } from './lisp/coding-choice.js'
import { applyStartupDefault, isStartupDefault, startupOptionLabel, stripRecommendedSuffix, type StartupDefaults } from './startup-defaults.js'

export type TaskStartupChoice = NonNullable<DecisionConfiguration['startup']>
export const TASK_STARTUP_OPTIONS = [
  'decision ON / Lisp ON', 'decision ON / Lisp OFF',
  'decision OFF / Lisp ON', 'decision OFF / Lisp OFF', '取消・作業を保持',
] as const
/** Index of the cancel option; each earlier index encodes one ON/OFF pair. */
const CANCEL_INDEX = 4
export function parseTaskStartupAnswer(response: unknown, questionId: string): TaskStartupChoice | undefined {
  const answers = (response as any)?.answers
  if (!Array.isArray(answers) || answers.length !== 1 || answers[0]?.id !== questionId) return undefined
  const a = answers[0]
  if (!Array.isArray(a.selected) || a.selected.length > 1 || !a.selected.every((s: unknown) => typeof s === 'string')
    || a.custom !== undefined && typeof a.custom !== 'string') return undefined
  if (!a.selected.length && !a.custom?.trim()) return { decision: false, lisp: false, cancelled: true }
  // The Web UI appends the preset marker for its recommendation; it is presentation only.
  const text = stripRecommendedSuffix(a.custom?.trim() || a.selected[0])
  const index = /^[1-5]$/.test(text)
    ? Number(text) - 1
    : (TASK_STARTUP_OPTIONS as readonly string[]).indexOf(text)
  return index < 0 ? undefined : index === CANCEL_INDEX ? { decision: false, lisp: false, cancelled: true }
    : { decision: index < 2, lisp: index % 2 === 0 }
}
function continuation(task: string): boolean {
  return codingContinuation(task) || /^(?:continue|resume|keep going|続けて(?:ください)?|続行(?:して)?|再開(?:して)?)[.!。！]?$/iu.test(task.trim())
}

/** One pre-assembly choice, stored in existing immutable decision bindings. No execution authority is created. */
export class TaskStartup {
  private readonly active = new WeakMap<object, { key: string; controller: AbortController; pending: Promise<void> }>()
  private readonly last = new Map<string, { id: string; config: DecisionConfiguration }>()
  constructor(private readonly host: {
    decisions: DecisionService; questions?: DshUserQuestions
    root(agent: LispCodingInput['agent']): string
    lisp(): LispCodingService | undefined
    /** Configured preselection for the card; absent marks no option. */
    defaults?(): StartupDefaults
  }) {}
  prepare(input: LispCodingInput & { sessionId: string; clarificationFrom?: { turn: number; task: string } }): Promise<void> {
    const root = this.host.root(input.agent)
    const prefix = `task-startup:${canonicalContentHash([input.sessionId, root])}:`
    const turn = String(input.turn).padStart(16, '0')
    const key = `${prefix}${turn}:${canonicalContentHash(input.task)}`
    const old = this.active.get(input.agent)
    if (old?.key === key) return old.pending
    old?.controller.abort()
    const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal])
    const pending = this.choose({ ...input, signal }, key, prefix, `${prefix}${turn}:`)
    this.active.set(input.agent, { key, controller, pending })
    void pending.catch(error => {
      if (this.active.get(input.agent)?.pending === pending && error?.code !== 'ASK_CANCELLED') this.active.delete(input.agent)
    })
    return pending
  }
  private async choose(input: LispCodingInput & { sessionId: string; clarificationFrom?: { turn: number; task: string } }, key: string, prefix: string, before: string): Promise<void> {
    const { decisions } = this.host, lisp = this.host.lisp()
    const current = () => {
      input.signal.throwIfAborted()
      if (`task-startup:${canonicalContentHash([input.sessionId, this.host.root(input.agent)])}:` !== prefix
        || ((input.agent as any).session?.id ?? input.sessionId) !== input.sessionId) throw new LispCodingCancelled('Task startup identity changed')
    }
    input.signal.throwIfAborted()
    const requestId = dshTurnRequestId({ dshSessionId: input.sessionId, turn: input.turn })
    let receipt = await decisions.readStartup(key)
    if (!receipt?.startup) {
      const configured = await decisions.startupConfiguration()
      // Only the intake's native-answer path supplies this exact original key.
      // Reuse its immutable mode binding, not the latest unrelated session task.
      const from = input.clarificationFrom
      const prior = from && Number.isSafeInteger(from.turn) && from.turn >= 1 && from.turn < input.turn
        ? await decisions.readStartup(`${prefix}${String(from.turn).padStart(16, '0')}:${canonicalContentHash(from.task)}`)
        : undefined
      const config = await decisions.readStartup(requestId) ?? prior ?? configured
      let choice: TaskStartupChoice | undefined = prior?.startup ?? configured.startup
      if (!choice && continuation(input.task)) {
        const previous = this.last.get(prefix)
        const rows = previous && previous.id < before ? [previous] : await decisions.startupBefore(prefix, before)
        // Ambiguous same-turn generations cannot donate a choice to another task.
        if (rows[0]?.config.startup && (!rows[1] || rows[0].id.split(':')[2] !== rows[1].id.split(':')[2])) {
          choice = rows[0].config.startup
          const manual = lisp?.manualOverride?.(input.agent)
          if (manual && !choice.cancelled) choice = { ...choice, lisp: manual.choice === 'yes' }
        }
      }
      const defaults = this.host.defaults?.() ?? { decision: 'ask' as const, lisp: 'ask' as const }
      const options = TASK_STARTUP_OPTIONS.map((label, index) => ({
        label: startupOptionLabel(label, index < CANCEL_INDEX && isStartupDefault(defaults, index)),
      }))
      if (!choice && this.host.questions) {
        const response = await abortable(this.host.questions.ask({ agent: input.agent, signal: input.signal, questions: [{
          id: key, header: 'Kiokuko · 作業開始', question: 'この作業で decision と Lisp を使いますか？',
          detail: `既定の選択を付けただけです。この作業では自由に変更できます。decision: ${config.provider} / ${selectedDecisionSettings(config)?.model ?? '未設定'}。未認証時に他へ切り替えません。Lisp の通常の権限・承認・Stop は維持します。取消・Skip は作業を保持して中止します。`,
          options,
        }] }), input.signal).catch(error => {
          if (error?.code === 'ASK_CANCELLED' && !input.signal.aborted) return { answers: [{ id: key, selected: [] }] }
          throw error
        })
        choice = parseTaskStartupAnswer(response, key)
        if (!choice) throw new ExecutionSelectionPending('Invalid decision/Lisp startup answer; no work started')
      }
      if (!choice) {
        // Headless cannot ask: the configured default decides, and an explicit
        // manual Lisp preference still wins because it was a human command.
        // Module availability never implicitly turns Lisp on.
        const manual = await lisp?.manualSelected?.(input.agent) === true
        choice = config.startup ?? {
          decision: applyStartupDefault(defaults.decision, config.mode !== 'off'),
          lisp: applyStartupDefault(defaults.lisp, manual),
        }
      }
      current()
      receipt = await decisions.bindStartup(key, choice, input.signal, config)
    }
    current()
    const choice = receipt.startup!
    this.last.set(prefix, { id: key, config: receipt })
    if (this.last.size > 128) this.last.delete(this.last.keys().next().value!)
    if (choice.cancelled) { lisp?.cancelled?.(input.agent, input.task); throw new LispCodingCancelled('Task startup cancelled; work retained') }
    await decisions.bindStartup(requestId, choice, input.signal, receipt).catch(error=>{
      if(error?.code==='DECISION_INVALID_INPUT')throw new ExecutionSelectionPending('This request already has an immutable decision binding. Start a new request to change decision mode; the existing backend was not substituted.')
      throw error
    })
    current()
    if (lisp?.selectTask) await lisp.selectTask(input, choice.lisp ? 'yes' : 'no', key)
    else if (choice.lisp) throw new ExecutionSelectionPending('Selected Lisp runtime is unavailable; choice retained')
    current()
  }
}
