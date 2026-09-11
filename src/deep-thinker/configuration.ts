import { z } from 'zod'
import { modelBindingProblems, modelRoutesForCatalog, readModelCatalog, type DshModelCatalog, type DshModelCompatibility, type ModelCatalogSnapshot, type ModelRoute } from '../dsh/model-configuration.js'
import type { DshUserQuestions } from '../dsh/user-interaction.js'
import { DeepBudgetSchema, DeepConfigurationSchema, DEEP_ROLES, type DeepConfiguration, type DeepModel, type DeepBudget } from './core/contracts.js'
import { currentDeepModel } from './current-model.js'
import type { DeepStore } from './store.js'
import type { DeepNativeAgent } from './native-executor.js'

const labels = { planner: '分解', solver: '解決', critic: '検証', synthesizer: '集約' }
const CLOSED = '閉じる・下書きを保持'
const budgetLabels: Record<keyof DeepBudget, string> = { maxConcurrentAgents: '同時Agent数', maxDepth: '分解の深さ', maxNodes: '累積問題数', maxChildrenPerNode: '一度の分解数', maxReplansPerNode: '問題ごとの再分解回数', maxAgentJobs: 'Agentジョブ数', maxModelRequests: 'モデル要求数', maxTotalTokens: '総トークン数（推定）', maxOutputTokensPerRequest: '要求ごとの最大出力', maxActiveSeconds: '稼働時間（秒）' }
export class DeepConfigurationPending extends Error { constructor(message = '設定待ちです。入力と設定の下書きは保持しています。') { super(message) } }
export class DeepInteractionDismissed extends DeepConfigurationPending {}
export async function deepQuestion(questions: DshUserQuestions | undefined, agent: DeepNativeAgent, signal: AbortSignal, id: string, question: string, choices: readonly string[], detail = ''): Promise<string> {
  if (!questions) throw new DeepConfigurationPending('設定・復旧カードを表示するDSH機能がありません。入力は保持しています。')
  const response = await questions.ask({ agent, signal, questions: [{ id, header: 'Deep planning', question, detail, options: [...choices, CLOSED].map(label => ({ label })) }] })
  signal.throwIfAborted()
  const answer = response.answers[0]
  if (!answer) throw new DeepInteractionDismissed()
  if (answer.id !== id) throw new DeepConfigurationPending()
  const value = answer.custom?.trim() || answer.selected[0]
  const resolved = value && !choices.includes(value) && !answer.custom?.trim() && /^\d+$/u.test(value) ? [...choices, CLOSED][Number(value) - 1] : value
  if (!resolved || resolved === CLOSED) throw new DeepInteractionDismissed()
  return resolved
}
const DraftSchema = DeepConfigurationSchema.extend({ roles: DeepConfigurationSchema.shape.roles.partial() })
type Draft = z.infer<typeof DraftSchema>
interface Preferences { revision: number; configuration_json: string | null; draft_json: string | null }

export class DeepConfigurationUI {
  constructor(readonly store: DeepStore, readonly catalog: DshModelCatalog | undefined, readonly questions: DshUserQuestions | undefined,
    readonly routes: readonly ModelRoute[], readonly compatibility: DshModelCompatibility | undefined, readonly budget: DeepBudget) {}
  async problems(configuration: DeepConfiguration): Promise<string[]> {
    if (!this.catalog) return ['DSHのモデル一覧がありません']
    const catalog = await readModelCatalog(this.catalog)
    return modelBindingProblems(DEEP_ROLES.map(role => ({ label: labels[role], binding: configuration.roles[role] })), catalog,
      modelRoutesForCatalog(catalog, [...this.routes, ...configuration.routeBindings.filter(r => !this.routes.some(known => known.provider === r.provider))]), this.compatibility)
  }
  async resolve(workspace: string, agent: DeepNativeAgent): Promise<DeepConfiguration | null> {
    const saved = await this.store.database(db => db.prepare('SELECT configuration_json FROM dsh_deep_preferences WHERE workspace=?').get<{configuration_json:string|null}>(workspace))
    if (saved?.configuration_json) return DeepConfigurationSchema.parse(JSON.parse(saved.configuration_json))
    const binding = currentDeepModel(agent)
    if (!binding) return null
    const routes = this.catalog ? modelRoutesForCatalog(await readModelCatalog(this.catalog), this.routes) : this.routes
    const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, binding])), budget: this.budget,
      routeBindings: routes, localProviders: routes.filter(route => route.connection === 'local').map(route => route.provider) })
    return (await this.problems(configuration)).length ? null : configuration
  }
  async #save(workspace: string, revision: number, draft: Draft, apply: boolean): Promise<number> {
    return this.store.transaction(db => {
      db.prepare('INSERT OR IGNORE INTO dsh_deep_preferences(workspace) VALUES(?)').run(workspace)
      db.prepare('UPDATE dsh_deep_preferences SET draft_json=?,configuration_json=CASE WHEN ? THEN ? ELSE configuration_json END,revision=revision+1 WHERE workspace=? AND revision=?')
        .run(JSON.stringify(draft), apply ? 1 : 0, apply ? JSON.stringify(DeepConfigurationSchema.parse(draft)) : null, workspace, revision)
      if (db.prepare('SELECT changes() AS count').get<{count:number}>()?.count !== 1) throw new DeepConfigurationPending('別の画面でDeep設定が変わりました。再度設定を開いてください。')
      return revision + 1
    })
  }
  async configure(workspace: string, agent: DeepNativeAgent, signal: AbortSignal): Promise<DeepConfiguration> {
    if (!this.catalog) throw new DeepConfigurationPending('モデル一覧の機能がありません')
    const saved = await this.store.database(db => db.prepare('SELECT * FROM dsh_deep_preferences WHERE workspace=?').get<Preferences & Record<string, unknown>>(workspace))
    let revision = saved?.revision ?? 0
    let draft = DraftSchema.parse(saved?.draft_json ? JSON.parse(saved.draft_json) : saved?.configuration_json ? JSON.parse(saved.configuration_json) : await this.resolve(workspace, agent) ?? { roles: {}, budget: this.budget })
    while (true) {
      const catalog = await readModelCatalog(this.catalog)
      const complete = DeepConfigurationSchema.safeParse(draft)
      const problems = complete.success ? await this.problems(complete.data) : ['四つの役割にモデルを設定してください']
      const roleChoices = DEEP_ROLES.map(role => `${labels[role]}: ${draft.roles[role] ? `${draft.roles[role]!.provider} / ${draft.roles[role]!.model}` : '未設定'}`)
      const choice = await deepQuestion(this.questions, agent, signal, 'deep-configuration', 'Deepのモデルと予算', [...roleChoices, '予算を編集', ...(complete.success && !problems.length ? ['保存'] : [])],
        `同じworkspaceの今後の開始に適用します。予約・実行中の構成は自動変更しません。\n${problems.join('\n')}\n${(Object.keys(budgetLabels) as (keyof DeepBudget)[]).map(key => `${budgetLabels[key]}: ${draft.budget[key]}`).join('\n')}\nトークン数は推定を含みます。provider内部の再送や料金の厳密な上限は保証しません。`)
      if (choice === '保存' && complete.success && !(await this.problems(complete.data)).length) {
        const routes = modelRoutesForCatalog(catalog, [...this.routes, ...complete.data.routeBindings])
        draft = { ...complete.data, routeBindings: routes, localProviders: routes.filter(r => r.connection === 'local').map(r => r.provider) }
        revision = await this.#save(workspace, revision, draft, true)
        return DeepConfigurationSchema.parse(draft)
      }
      if (choice === '予算を編集') {
        const limits = budgetLabels
        const keys = Object.keys(limits) as (keyof DeepBudget)[], choices = keys.map(key => `${limits[key]}: ${draft.budget[key]}`)
        const selected = await deepQuestion(this.questions, agent, signal, 'deep-budget-field', '変更する上限を選択', [...choices, '戻る'])
        const key = keys[choices.indexOf(selected)]; if (!key) continue
        const raw = await deepQuestion(this.questions, agent, signal, 'deep-budget-value', `${limits[key]}の上限`, [String(draft.budget[key])], '自由入力で整数を指定できます。上限を増やすと処理時間・費用が増える可能性があります。')
        try { if (!/^\d+$/u.test(raw)) continue; draft = { ...draft, budget: DeepBudgetSchema.parse({ ...draft.budget, [key]: Number(raw) }) } }
        catch { continue }
      } else {
        const role = DEEP_ROLES[roleChoices.indexOf(choice)]
        if (!role) continue
        const selected = await this.#pickModel(agent, signal, catalog, labels[role], Object.values(draft.roles)[0])
        if (!selected) continue
        // The catalog selection already contains the exact native provider/model.
        // DSH owns its transport and authentication; do not ask the user to restate them.
        draft = { ...draft, roles: { ...draft.roles, [role]: selected } }
      }
      revision = await this.#save(workspace, revision, draft, false)
    }
  }
  async #pickModel(agent: DeepNativeAgent, signal: AbortSignal, catalog: ModelCatalogSnapshot, role: string, copy?: DeepModel): Promise<DeepModel | undefined> {
    let query = '', page = 0
    while (true) {
      const matches = catalog.models.filter(m => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(query))
      const models = matches.slice(page * 20, (page + 1) * 20), labels = models.map(m => `${m.provider} / ${m.name} [${m.id}]`)
      const choice = await deepQuestion(this.questions, agent, signal, 'deep-role-model', `${role}のモデル`, [...labels, ...(copy ? ['設定済みの役割からコピー'] : []), ...(page ? ['前のページ'] : []), ...(matches.length > (page + 1) * 20 ? ['次のページ'] : []), '戻る'], '自由入力で接続ID・モデルID・名前を検索できます。')
      if (choice === '戻る') return undefined
      if (choice === '前のページ') { page--; continue }
      if (choice === '次のページ') { page++; continue }
      if (choice === '設定済みの役割からコピー' && copy) return { ...copy }
      const model = models[labels.indexOf(choice)]
      if (model) return { provider: model.provider, model: model.id }
      query = choice.toLowerCase(); page = 0
    }
  }
}
