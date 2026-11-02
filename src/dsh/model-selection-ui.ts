import { HEAD_WORKER_LABEL, HEAD_WORKER_PRESET, headWorkerCandidates, validateHeadWorker, type HeadWorkerConfiguration } from './head-worker-configuration.js'
import type { DshUserQuestionAgent, DshUserQuestions } from './user-interaction.js'
import { explicitExecutionMode, type StoredExecutionSelection, type ExecutionSelection } from './execution-selection.js'
import { ModelBindingSchema, type ModelBinding, type ModelCatalogSnapshot, type ModelRoute, type DshModelCompatibility, type DshModelCatalog } from './model-configuration.js'

import { ExecutionSelectionPending } from './execution-pending.js'
export { ExecutionSelectionPending } from './execution-pending.js'

interface SelectionUiInput {
  readonly task: string
  readonly turn?: number
  readonly agent?: DshUserQuestionAgent
  readonly signal: AbortSignal
  readonly questions?: DshUserQuestions
  readonly llm?: DshModelCatalog
  readonly routes: readonly ModelRoute[]
  readonly compatibility?: DshModelCompatibility
  readonly savedHeadWorker?: HeadWorkerConfiguration
  readonly stored: StoredExecutionSelection
  readonly save: (revision: number, value: ExecutionSelection) => Promise<StoredExecutionSelection>
}
const BACK = '戻る', CANCEL = '取消・作業を保持', RELOAD = '一覧を再取得'
class SelectionDiscussion extends Error {
  constructor(readonly questionId: string, readonly text: string) { super('User requested discussion') }
}
async function ask(input: SelectionUiInput, id: string, question: string, choices: readonly string[], detail = ''): Promise<string> {
  if (!input.questions || input.signal.aborted) throw new ExecutionSelectionPending()
  let response
  try {
    response = await input.questions.ask({
      questions: [{ id, header: '実行方式とモデル', question, options: [...choices, CANCEL].map(label => ({ label })), detail }],
      ...(input.agent ? { agent: input.agent } : {}), signal: input.signal,
    })
    input.signal.throwIfAborted()
  } catch {
    // Native cancellation, missing UI and abort all leave the durable draft intact.
    throw new ExecutionSelectionPending()
  }
  const answer = response.answers[0]
  if (answer?.id !== id || answer.selected.length > 1) throw new ExecutionSelectionPending()
  if (answer.selected[0] === CANCEL) throw new ExecutionSelectionPending()
  const custom = answer.custom?.trim()
  const value = custom || answer.selected[0]
  if (!value) throw new ExecutionSelectionPending()
  if (!choices.includes(value)) {
    if (custom) throw new SelectionDiscussion(id, custom)
    throw new ExecutionSelectionPending()
  }
  return value
}
async function selectionCatalog(input: SelectionUiInput): Promise<ModelCatalogSnapshot> {
  if (!input.llm) throw new ExecutionSelectionPending()
  return await readModelCatalogSafely(input)
}
async function readModelCatalogSafely(input: SelectionUiInput): Promise<ModelCatalogSnapshot> {
  const { readModelCatalog } = await import('./model-configuration.js')
  return await readModelCatalog(input.llm!)
}
function modelLabel(catalog: ModelCatalogSnapshot, binding: ModelBinding): string {
  const provider = catalog.providers.find(p => p.id === binding.provider)
  const model = catalog.models.find(m => m.provider === binding.provider && m.id === binding.model)
  return `${provider?.name ?? binding.provider} [${binding.provider}] / ${model?.name ?? binding.model} [${binding.model}]`
}
/** A pair is adopted atomically after live validation; Back/Cancel does not mutate the existing draft. */
async function pickHeadWorker(input: SelectionUiInput): Promise<HeadWorkerConfiguration | undefined> {
  if (!input.llm) {
    throw new ExecutionSelectionPending()
  }
  while (true) {
    const catalog = await selectionCatalog(input)
    const candidates = await headWorkerCandidates(catalog, input.routes, input.compatibility)
    if (!candidates.heads.length || !candidates.workers.length) {
      const answer = await ask(input, 'head-worker-unavailable', 'このモデル構成は利用できません', [RELOAD, BACK], candidates.problems.join('\n'))
      if (answer === BACK) return undefined
      continue
    }
    const choose = async (role: 'head' | 'worker', bindings: ModelBinding[]) => {
      if (bindings.length === 1) return bindings[0]
      const labels = bindings.map(binding => modelLabel(catalog, binding))
      const answer = await ask(input, `head-worker-${role}`, `${role === 'head' ? 'ヘッド' : 'サブエージェント'}の接続を選択`, [...labels, BACK], '接続IDとモデルIDを確認してください。別の接続への自動切替は行いません。')
      return answer === BACK ? undefined : bindings[labels.indexOf(answer)]
    }
    const head = await choose('head', candidates.heads)
    if (!head) return undefined
    const worker = await choose('worker', candidates.workers)
    if (!worker) return undefined
    const pair = { preset: HEAD_WORKER_PRESET, head, worker }
    const answer = await ask(input, 'head-worker-review', HEAD_WORKER_LABEL, ['この構成で開始', BACK],
      [`ヘッド: ${modelLabel(catalog, head)}`, `サブエージェント: ${modelLabel(catalog, worker)}`,
        '候補の接続は未検証です。開始を確定した後に検証します。',
        '通常実行・Lispでは親と明示的に委譲した子に適用します。自動的な委譲は追加しません。',
        'この作業だけに保存します。既定値は Settings → Kiokuko Models から変更できます。'].join('\n'))
    if (answer === BACK) return undefined
    const problems = await validateHeadWorker(pair, input.llm!, input.routes, input.compatibility)
    if (!problems.length) return pair
    if (await ask(input, 'head-worker-unavailable', '接続またはモデルが変更されました。構成を選び直してください。', [RELOAD, BACK], problems.join('\n')) === BACK) return undefined
  }
}
export async function selectExecution(input: SelectionUiInput): Promise<StoredExecutionSelection> {
  let stored = input.stored
  try {
    return await selectExecutionChoices({ ...input, save: async (revision, value) => {
      if (input.signal.aborted) throw new ExecutionSelectionPending()
      stored = await input.save(revision, value)
      return stored
    } })
  } catch (error) {
    if (!(error instanceof SelectionDiscussion)) throw error
    if (input.signal.aborted) throw new ExecutionSelectionPending()
    return input.save(stored.revision, { ...stored.value, discussion: {
      questionId: error.questionId, text: error.text, turn: input.turn ?? 0,
    } })
  }
}

async function selectExecutionChoices(input: SelectionUiInput): Promise<StoredExecutionSelection> {
  let stored = input.stored
  const save = async (value: ExecutionSelection) => { stored = await input.save(stored.revision, value) }
  if (stored.value.status === 'ready' || stored.value.discussion) return stored
  const explicit = stored.value.mode === 'pending' ? explicitExecutionMode(input.task) : undefined
  while (true) {
    const mode = explicit ?? await ask(input, 'execution-mode', 'この作業をどう実行しますか？', ['通常実行', `通常実行: ${HEAD_WORKER_LABEL}`], '通常実行は現在のDSHモデルで進めます。記憶・Skill・権限判定・検証は維持します。')
    // Explicit intent is consumed once.
    if (explicit !== undefined && mode !== explicit) continue
    if (mode === `通常実行: ${HEAD_WORKER_LABEL}`) {
      const headWorker = await pickHeadWorker(input)
      if (!headWorker) continue
      await save({ mode: 'normal', status: 'ready', headWorker, ...(stored.value.ordinaryModel ? { ordinaryModel: stored.value.ordinaryModel } : {}) }); return stored
    }
    await save({ mode: 'normal', status: 'ready', ...(stored.value.ordinaryModel ? { ordinaryModel: stored.value.ordinaryModel } : {}) }); return stored
  }
}
