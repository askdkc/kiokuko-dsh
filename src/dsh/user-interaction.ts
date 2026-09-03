import type { AkinatorQuestion } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'
import type { ConfirmationBasis, UserFacingConfirmation, UserFacingConfirmationAction, UserFacingLanguage } from '../enno-oduno/types.js'
import { renderPlanStartRecovery, type PlanStartRecovery } from '../enno-oduno/plan-recovery.js'

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

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message)
}

/** Adapt the dsh user-question service to one exact Akinator question at a time. */
export function createDshIntakeAnswerer(service: DshUserQuestions): DshIntakeAnswerer {
  return {
    async ask(question, signal, agent) {
      const result = await service.ask({
        questions: [{
          id: question.id,
          question: question.prompt,
          ...(question.options === null ? {} : { options: question.options.map((label) => ({ label })) }),
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
  return value.replace(/([\\`*_[\]<>#])/gu, '\\$1')
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
