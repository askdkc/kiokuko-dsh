import type { AkinatorQuestion } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'
import type { ConfirmationBasis, UserFacingConfirmation, UserFacingConfirmationAction, UserFacingLanguage } from '../enno-oduno/types.js'
import { renderPlanStartRecovery, type PlanStartRecovery } from '../enno-oduno/plan-recovery.js'
import type { TaskType } from '../akinator/types.js'

const INTAKE_CHOICES: Record<TaskType, DshUserQuestionOption> = {
  build: { label: '実装・変更', description: 'ファイルを変更してほしい。例：「検索機能を追加して」「READMEを短くして」' },
  debug: { label: '不具合の調査・修正', description: '動かない原因や直し方を扱う。例：「起動エラーを直して」「テスト失敗の原因を調べて」' },
  research: { label: '情報を調べる', description: '情報収集や比較をしてほしい。例：「このライブラリの使い方を調べて」' },
  review: { label: 'レビュー', description: '変更せずに問題点を確認してほしい。例：「この差分のバグや危険な点を指摘して」' },
  devops: { label: '環境・運用', description: '実行環境や配備の作業。例：「CIを設定して」「デプロイ失敗を調べて」' },
  writing: { label: '文章を作る', description: '文章そのものを回答してほしい。例：「メールの下書きを書いて」「この文を翻訳して」' },
  analysis: { label: '分析する', description: 'データやログから傾向・意味を読み取る。例：「このCSVの売上傾向を分析して」' },
  chat: { label: '質問・相談・会話', description: '作業を開始せずに話したい。例：「このコードを説明して」「方針を相談したい」' },
}

function intakePresentation(question: AkinatorQuestion) {
  if (question.id === 'taskType') return {
    header: 'Kiokuko · 作業の選択',
    question: '今回は何をしてほしいですか？',
    detail: '各選択肢の例を参考に、いちばん近いものを1つ選んでください。迷う場合は「質問・相談・会話」で相談できます。ファイルを編集する依頼は「実装・変更」、回答として文章を受け取る依頼は「文章を作る」が目安です。\n\n番号を自由入力してEnterでも回答できます。選択肢にない場合は、してほしいことを自由に入力してください。',
    ...(question.options === null ? {} : { options: question.options.map(label => INTAKE_CHOICES[label as TaskType] ?? { label }) }),
  }
  return {
    question: question.prompt,
    detail: question.id === 'target'
      ? '例：「このリポジトリ全体」「src/login.ts」「ログイン画面」「本番API」。分かる範囲で対象の名前やパスを入力してください。'
      : '例：「ログインに成功し、関連テストが通る」「READMEが導入手順だけになる」「原因と修正案が分かる」。作業がどうなれば完了かを入力してください。',
    ...(question.options === null ? {} : { options: question.options.map(label => ({ label })) }),
  }
}

export interface DshUserQuestionRequest {
  readonly questions: readonly [{
    readonly id: string
    readonly question: string
    readonly detail?: string
    readonly header?: string
    readonly options?: readonly DshUserQuestionOption[]
    readonly multiSelect?: boolean
    readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  }]
  readonly agent?: DshUserQuestionAgent
  readonly signal?: AbortSignal
}

/** Exact live DSH agent identity used to route a question to its scoped UI answerer. */
export interface DshUserQuestionAgent {
  readonly id: string
}

/** Native dsh-user-questions option shape. */
export interface DshUserQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface DshUserQuestionAnswer {
  readonly answers: readonly [{ readonly id: string; readonly selected: readonly string[]; readonly custom?: string }]
}

export interface DshUserQuestions {
  ask(request: DshUserQuestionRequest): Promise<DshUserQuestionAnswer>
}

export interface DshIntakeAnswerer {
  ask(question: AkinatorQuestion, signal?: AbortSignal, agent?: DshUserQuestionAgent): Promise<string>
}

export interface DshConfirmationAnswer {
  readonly action: UserFacingConfirmationAction
  readonly requestedChanges?: string
}

export interface DshConfirmationAnswerer {
  ask(confirmation: UserFacingConfirmation, signal?: AbortSignal, agent?: DshUserQuestionAgent): Promise<DshConfirmationAnswer>
}

/** Internal host failures are not missing task requirements. Keep recovery explicit. */
export function boundaryFailureCopy(language: UserFacingLanguage) {
  return language === 'ja' ? {
    header: 'Kiokukoが停止しました',
    title: 'Kiokukoの内部処理が3回失敗したため、自動処理を停止しました。',
    recoveryInstruction: 'これは依頼内容が不足しているという意味ではありません。下記の内部エラーの原因を解消してから再開する必要があります。既に行った対処と再開の指示、または停止の指示を入力してください。原因が未解消なら、再開しても同じエラーで停止する可能性があります。空欄・取消では停止したままになります。',
  } : {
    header: 'Kiokuko stopped',
    title: 'Kiokuko stopped after three internal processing failures.',
    recoveryInstruction: 'This does not mean your task description is incomplete. Resolve the internal error below before retrying. Describe any corrective action already taken and whether to resume or stop. Retrying without resolving the cause may fail again. An empty answer or cancellation leaves processing stopped.',
  }
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message)
}

/** Adapt the dsh user-question service to one exact Akinator question at a time. */
export function createDshIntakeAnswerer(service: DshUserQuestions): DshIntakeAnswerer {
  return {
    async ask(question, signal, agent) {
      const presentation = intakePresentation(question)
      const result = await service.ask({
        questions: [{
          id: question.id,
          ...presentation,
        }],
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })
      const answer = result.answers[0]
      if (answer === undefined || answer.id !== question.id) conflict('User answer does not match the current Akinator question')
      const value = answer.custom?.trim() || answer.selected[0]?.trim()
      // DSH preserves the Web UI's "Skip this question" action as an empty
      // single-question answer. Skipping task classification means the user
      // wants an ordinary conversation, not an invalid task type.
      if (!value && question.id === 'taskType') return 'chat'
      if (!value) conflict('Akinator requires a non-empty user answer')
      if (question.options !== null) {
        const normalized = value.normalize('NFKC')
        if (/^\d+$/u.test(normalized)) {
          const option = question.options[Number(normalized) - 1]
          if (option === undefined) conflict(`選択肢の番号は1〜${question.options.length}で入力してください。`)
          return option
        }
        const displayIndex = presentation.options?.findIndex(option => option.label === value) ?? -1
        if (displayIndex >= 0) return question.options[displayIndex]!
      }
      return value
    },
  }
}

interface ConfirmationLabels {
  readonly summary: string
  readonly scope: string
  readonly exclusions: string
  readonly completion: string
  readonly skills: string
  readonly workItems: string
  readonly finalChecks: string
  readonly attemptLimit: string
  readonly basis: string
  readonly paths: string
  readonly dependsOn: string
  readonly doneWhen: string
  readonly checks: string
  readonly expertise: string
  readonly commandKind: string
  readonly directory: string
  readonly timeout: string
  readonly required: string
  readonly optional: string
  readonly referenceOnly: string
  readonly available: string
  readonly purposes: string
  readonly maximumAttempts: string
  readonly none: string
  readonly question: string
  readonly approveDescription: string
  readonly cancelDescription: string
  readonly basisNames: Readonly<Record<ConfirmationBasis, string>>
  readonly purposeNames: Readonly<Record<string, string>>
}

const CONFIRMATION_LABELS = {
  en: {
    summary: 'Summary', scope: 'Scope', exclusions: 'Exclusions', completion: 'Completion criteria',
    skills: 'Skills', workItems: 'Work items', finalChecks: 'Final checks', attemptLimit: 'Attempt limit',
    basis: 'Basis', paths: 'Paths', dependsOn: 'Depends on', doneWhen: 'Done when', checks: 'Checks',
    expertise: 'Expertise', commandKind: 'Type', directory: 'Directory', timeout: 'Timeout', required: 'required',
    optional: 'optional', referenceOnly: 'reference only', available: 'available', purposes: 'Purposes',
    maximumAttempts: 'Maximum attempts', none: 'None',
    question: 'Review the proposed plan and choose an action.',
    approveDescription: 'Approve this exact plan and start the first work item.',
    cancelDescription: 'Cancel this Enno plan without starting implementation.',
    basisNames: { user: 'User', repository: 'Repository', proposal: 'Proposal' },
    purposeNames: {},
  },
  ja: {
    summary: '概要', scope: '対象範囲', exclusions: '対象外', completion: '完了条件',
    skills: '使用するスキル', workItems: '作業項目', finalChecks: '最終確認', attemptLimit: '試行上限',
    basis: '根拠', paths: '対象', dependsOn: '依存', doneWhen: '完了条件', checks: '確認',
    expertise: '専門観点', commandKind: '種別', directory: '実行場所', timeout: 'タイムアウト', required: '必須',
    optional: '任意', referenceOnly: '参照のみ', available: '利用可能', purposes: '用途',
    maximumAttempts: '最大試行回数', none: 'なし',
    question: '提案された計画を確認し、操作を選択してください。',
    approveDescription: 'この計画を承認し、最初の作業項目を開始します。',
    cancelDescription: '実装を開始せず、このEnno計画を取り消します。',
    basisNames: { user: 'ユーザー指定', repository: 'リポジトリ', proposal: '提案' },
    purposeNames: {
      planning: '計画', implementation: '実装', ui: 'UI', testing: 'テスト', review: 'レビュー', operations: '運用',
    },
  },
} as const satisfies Record<UserFacingLanguage, ConfirmationLabels>

function escapeMarkdownText(value: string): string {
  // Confirmation fields may contain deliberate line breaks. Render those as
  // visible data inside one Markdown item instead of letting a continuation
  // line become a sibling bullet, heading, quote, or code block.
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/\n/gu, ' ↵ ')
    .replace(/([\\`*_[\]<>#])/gu, '\\$1')
}

function inlineCode(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/gu) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

function basisText(basis: ConfirmationBasis, labels: ConfirmationLabels): string {
  return `**${labels.basis}:** ${labels.basisNames[basis]}`
}

function verifierText(
  check: UserFacingConfirmation['finalChecks']['checks'][number],
  labels: ConfirmationLabels,
): string {
  const command = [check.executable, ...check.arguments].map(inlineCode).join(' ')
  return `${command} — **${labels.commandKind}:** ${inlineCode(check.category)}; **${labels.directory}:** ${inlineCode(check.directory)}; **${labels.timeout}:** ${check.timeoutMs} ms`
}

function bulletList(values: readonly string[], labels: ConfirmationLabels, render = escapeMarkdownText): string[] {
  return values.length === 0 ? [`- ${labels.none}`] : values.map((value) => `- ${render(value)}`)
}

function confirmationText(confirmation: UserFacingConfirmation): string {
  const labels: ConfirmationLabels = CONFIRMATION_LABELS[confirmation.language]
  const lines = [
    `# ${escapeMarkdownText(confirmation.title)}`,
    '',
    `## ${labels.summary}`,
    '',
    basisText(confirmation.summary.basis, labels),
    '',
    escapeMarkdownText(confirmation.summary.text),
    '',
    `## ${labels.scope}`,
    '',
    basisText(confirmation.scope.basis, labels),
    '',
    ...bulletList(confirmation.scope.paths, labels, inlineCode),
    '',
    `## ${labels.exclusions}`,
    '',
    basisText(confirmation.exclusions.basis, labels),
    '',
    ...bulletList(confirmation.exclusions.paths, labels, inlineCode),
    '',
    `## ${labels.completion}`,
    '',
    basisText(confirmation.completion.basis, labels),
    '',
    ...bulletList(confirmation.completion.items, labels),
    '',
    `## ${labels.skills}`,
    '',
    ...(confirmation.skills.length === 0 ? [`- ${labels.none}`] : confirmation.skills.map((skill) => {
      const purposes = skill.purposes.map((purpose) => labels.purposeNames[purpose] ?? purpose).join(', ') || labels.none
      return `- ${inlineCode(skill.label)} — ${basisText(skill.basis, labels)}; ${skill.required ? labels.required : labels.optional}; ${skill.referenceOnly ? labels.referenceOnly : labels.available}; **${labels.purposes}:** ${escapeMarkdownText(purposes)}`
    })),
    '',
    `## ${labels.workItems}`,
  ]
  if (confirmation.workItems.length === 0) lines.push('', `- ${labels.none}`)
  for (const item of confirmation.workItems) {
    lines.push(
      '',
      `### ${item.number}. ${escapeMarkdownText(item.summary)}`,
      '',
      `- ${basisText(confirmation.summary.basis, labels)}`,
      `- **${labels.paths}:** ${item.paths.length === 0 ? labels.none : item.paths.map(inlineCode).join(', ')}`,
      `- **${labels.dependsOn}:** ${item.dependsOn.join(', ') || labels.none}`,
      `- **${labels.doneWhen}:**`,
      ...(item.doneWhen.length === 0 ? [`  - ${labels.none}`] : item.doneWhen.map((value) => `  - ${escapeMarkdownText(value)}`)),
      `- **${labels.checks}:**`,
      ...(item.checks.length === 0 ? [`  - ${labels.none}`] : item.checks.map((check) => `  - ${verifierText(check, labels)}`)),
      `- **${labels.expertise}:**`,
      ...(item.expertise.length === 0 ? [`  - ${labels.none}`] : item.expertise.map((expertise) => (
        `  - ${escapeMarkdownText(expertise.area)} — ${basisText(expertise.basis, labels)}; ${escapeMarkdownText(expertise.reason)}`
      ))),
    )
  }
  lines.push(
    '',
    `## ${labels.finalChecks}`,
    '',
    basisText(confirmation.finalChecks.basis, labels),
    '',
    ...(confirmation.finalChecks.checks.length === 0
      ? [`- ${labels.none}`]
      : confirmation.finalChecks.checks.map((check) => `- ${verifierText(check, labels)}`)),
    '',
    `## ${labels.attemptLimit}`,
    '',
    basisText(confirmation.attemptLimit.basis, labels),
    '',
    `- **${labels.maximumAttempts}:** ${confirmation.attemptLimit.maxAttempts}`,
  )
  return lines.join('\n')
}

/** Render only the public confirmation projection; internal directive fields never cross this boundary. */
export function renderDshConfirmation(confirmation: UserFacingConfirmation): string {
  return confirmationText(confirmation)
}

/** Keep plan-recovery choices user-facing and free of machine identity fields. */
export function renderDshPlanRecovery(recovery: PlanStartRecovery): string {
  return renderPlanStartRecovery(recovery)
}

/** Adapt one explicit confirmation choice to dsh UserQuestions. */
export function createDshConfirmationAnswerer(service: DshUserQuestions): DshConfirmationAnswerer {
  return {
    async ask(confirmation, signal, agent) {
      const labels = CONFIRMATION_LABELS[confirmation.language]
      // DSH's dedicated plan-review surface deliberately accepts a binary
      // decision. Revision remains available through its "Chat about it"
      // action, which dismisses this wait and returns the composer to the user.
      const options = confirmation.actions
        .filter((action): action is 'approve' | 'cancel' => action === 'approve' || action === 'cancel')
        .map((label) => ({
          label,
          description: label === 'approve'
            ? labels.approveDescription
            : labels.cancelDescription,
        }))
      const result = await service.ask({
        questions: [{
          id: 'kiokuko-plan-confirmation',
          question: labels.question,
          detail: renderDshConfirmation(confirmation),
          options,
          multiSelect: false,
          intent: { kind: 'plan-review', approve: 'approve' },
        }],
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })
      const answer = result.answers[0]
      if (answer === undefined || answer.id !== 'kiokuko-plan-confirmation') conflict('Confirmation answer does not match the current request')
      const selected = answer.selected.filter((value): value is UserFacingConfirmationAction => confirmation.actions.includes(value as UserFacingConfirmationAction))
      if (selected.length !== 1) conflict('Confirmation requires exactly one supported action')
      const action = selected[0]!
      const requestedChanges = answer.custom?.trim()
      if (action === 'revise' && !requestedChanges) conflict('Revision requires a non-empty description of the requested changes')
      if (action !== 'revise' && requestedChanges !== undefined && requestedChanges.length > 0) conflict('Only a revision may carry requested changes')
      return { action, ...(requestedChanges === undefined ? {} : { requestedChanges }) }
    },
  }
}
