import { abortable } from './boundary-worker.js'
import { AgenticReplayError, type DshAgenticReplayBinding, type WithAgenticReplayIndex } from './agenticreplay-types.js'
import type { DshUserQuestionAgent, DshUserQuestions } from './user-interaction.js'

interface ChoiceEntry {
  choice?: boolean | undefined
  error?: string
  loaded?: Promise<void>
  pending?: Promise<void>
  controller: AbortController
  revision: number
  attempted: boolean
  writes: Promise<void>
}

/**
 * One recording decision per session, with explicit commands superseding pending answers.
 * Without a saved choice, `askOnStart` decides between asking the human and recording
 * directly; the default asks, so only explicit configuration authorizes capture silently.
 */
export class DshAgenticReplaySessionChoices {
  readonly #entries = new Map<string, ChoiceEntry>()
  #closed = false
  constructor(private readonly withIndex: WithAgenticReplayIndex, private readonly questions?: DshUserQuestions,
    private readonly askOnStart = true) {}
  #entry(binding: DshAgenticReplayBinding): ChoiceEntry {
    const key = JSON.stringify([binding.sessionId, binding.workspaceRoot, binding.sessionCwd, binding.storeRoot])
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { controller: new AbortController(), revision: 0, attempted: false, writes: Promise.resolve() }
      this.#entries.set(key, entry)
    }
    return entry
  }
  allows(binding: DshAgenticReplayBinding): boolean { return !this.#closed && this.#entry(binding).choice === true }
  async #load(binding: DshAgenticReplayBinding, entry: ChoiceEntry): Promise<void> {
    if (!entry.loaded) {
      const revision = entry.revision
      entry.loaded = this.withIndex(store => store.recordingChoice(binding)).then(choice => {
        if (entry.revision === revision) entry.choice = choice
      }).catch(() => {
        entry.error = 'recording_choice_persistence_failed'
        throw new AgenticReplayError(entry.error)
      })
    }
    await entry.loaded
  }
  async status(binding: DshAgenticReplayBinding) {
    const entry = this.#entry(binding)
    try { await this.#load(binding, entry) } catch { /* Report degradation without blocking status. */ }
    return { sessionRecording: entry.choice === undefined ? 'awaiting_choice' : entry.choice ? 'enabled' : 'disabled',
      ...(entry.error ? { selectionError: entry.error } : {}) }
  }
  async set(binding: DshAgenticReplayBinding, enabled: boolean): Promise<void> {
    if (this.#closed) throw new AgenticReplayError('recording_host_closed')
    const entry = this.#entry(binding), revision = ++entry.revision
    entry.controller.abort()
    entry.attempted = true
    // Neither a pending enable nor a failed disable may admit observations.
    entry.choice = false
    const write = entry.writes.then(async () => {
      if (this.#closed) throw new AgenticReplayError('recording_host_closed')
      await this.withIndex(store => store.saveRecordingChoice(binding, enabled))
      if (entry.revision === revision && !this.#closed) { entry.choice = enabled; delete entry.error }
    }).catch(() => {
      if (entry.revision === revision) entry.error = 'recording_choice_persistence_failed'
      throw new AgenticReplayError('recording_choice_persistence_failed')
    })
    entry.writes = write.catch(() => undefined)
    entry.loaded = entry.writes
    await write
  }
  prepare(binding: DshAgenticReplayBinding, agent: DshUserQuestionAgent, signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
    const entry = this.#entry(binding)
    if (entry.pending) return entry.pending
    entry.pending = (async () => {
      try {
        await this.#load(binding, entry)
        if (this.#closed || entry.choice !== undefined || entry.attempted || signal.aborted || !isCurrent()) return
        entry.attempted = true
        // A saved choice wins; otherwise configuration decides between recording and asking.
        if (!this.askOnStart) { await this.set(binding, true); return }
        if (!this.questions) { entry.error = 'recording_question_unavailable'; return }
        const revision = entry.revision
        const combined = AbortSignal.any([signal, entry.controller.signal])
        const id = 'kioku-agenticreplay-recording'
        const result = await abortable(this.questions.ask({
          agent, signal: combined, questions: [{ id, header: 'AgenticReplay · 詳細ログ',
            question: 'このチャットの詳細ログを記録しますか？',
            detail: 'モデルの応答やツールの実行結果をローカルに保存し、後で確認・HTML出力できます。本文を含み、秘密情報の除去は完全ではありません。記録しなくても作業は進められます。後から /kioku-agenticreplay start・stop で変更できます。',
            options: [{ label: '記録する', description: 'この選択以降の動作を記録します。' },
              { label: '記録しない', description: '詳細ログを作らずに続行します。' }] }],
        }), combined)
        if (combined.aborted || this.#closed || entry.revision !== revision || !isCurrent()) return
        const answer = result.answers[0]
        if (answer?.id !== id || answer.selected.length > 1) return
        const value = (answer.custom?.trim() || answer.selected[0] || '').normalize('NFKC')
        if (value === '記録する' || value === '1') await this.set(binding, true)
        else if (value === '記録しない' || value === '2') await this.set(binding, false)
      } catch {
        // Dismissed or unavailable questions and failed persistence never record or veto work.
        if (!signal.aborted && !entry.controller.signal.aborted) entry.error ??= 'recording_question_unavailable'
      }
    })().finally(() => { delete entry.pending })
    return entry.pending
  }
  forget(binding: DshAgenticReplayBinding): void {
    const entry = this.#entry(binding)
    entry.revision++
    entry.controller.abort()
    this.#entries.delete(JSON.stringify([binding.sessionId, binding.workspaceRoot, binding.sessionCwd, binding.storeRoot]))
  }
  async shutdown(): Promise<void> {
    this.#closed = true
    const entries = [...this.#entries.values()]
    for (const entry of entries) entry.controller.abort()
    await Promise.all(entries.flatMap(entry => [entry.pending, entry.writes, entry.loaded?.catch(() => undefined)]))
    this.#entries.clear()
  }
}
