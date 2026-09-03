import type { AkinatorQuestion } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'
import type { UserFacingConfirmation, UserFacingConfirmationAction } from '../enno-oduno/types.js'
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

function confirmationText(confirmation: UserFacingConfirmation): string {
  const lines = [
    confirmation.title,
    `Summary [${confirmation.summary.basis}]: ${confirmation.summary.text}`,
    `Scope [${confirmation.scope.basis}]: ${confirmation.scope.paths.join(', ') || '(none)'}`,
    `Exclusions [${confirmation.exclusions.basis}]: ${confirmation.exclusions.paths.join(', ') || '(none)'}`,
    `Completion [${confirmation.completion.basis}]:`,
    ...confirmation.completion.items.map((item, index) => `  ${index + 1}. ${item}`),
    'Skills:',
    ...confirmation.skills.map((skill) => `  - ${skill.label} [${skill.basis}] required=${skill.required} referenceOnly=${skill.referenceOnly} purposes=${skill.purposes.join(', ')}`),
    'Work items:',
    ...confirmation.workItems.flatMap((item) => [
      `  ${item.number}. ${item.summary}`,
      `     paths: ${item.paths.join(', ') || '(none)'}`,
      `     dependsOn: ${item.dependsOn.join(', ') || '(none)'}`,
      `     doneWhen: ${item.doneWhen.join(' | ') || '(none)'}`,
      ...item.checks.map((check) => `     check: ${check.executable} ${check.arguments.join(' ')} [directory=${check.directory}, timeoutMs=${check.timeoutMs}]`),
      ...item.expertise.map((expertise) => `     expertise: ${expertise.area} [${expertise.basis}] ${expertise.reason}`),
    ]),
    'Final checks:',
    ...confirmation.finalChecks.checks.map((check) => `  - ${check.executable} ${check.arguments.join(' ')} [directory=${check.directory}, timeoutMs=${check.timeoutMs}]`),
    `Attempt limit [${confirmation.attemptLimit.basis}]: ${confirmation.attemptLimit.maxAttempts}`,
    'Choose one: approve, revise, cancel.',
  ]
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
      const result = await service.ask({
        questions: [{
          id: 'kiokuko-plan-confirmation',
          question: 'Review the proposed plan and choose an action.',
           detail: renderDshConfirmation(confirmation),
          options: confirmation.actions.map((label) => ({ label })),
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
