import type { ProfileMemoryHint } from '../akinator/memory-probe-types.js'
import type { AkinatorQuestion, TaskType } from '../akinator/types.js'
import { KiokukoError } from '../errors.js'

const INTAKE_CHOICES: readonly { types: readonly TaskType[]; label: string }[] = [
  { types: ['build'], label: '実装・変更' },
  { types: ['research', 'debug', 'review', 'devops', 'analysis'], label: '不具合調査、情報調査' },
  { types: ['writing'], label: '文章作成' },
  { types: ['chat'], label: '質問、相談、会話' },
]

function intakeOptions(question: AkinatorQuestion) {
  if (question.options === null) return undefined
  if (question.id !== 'taskType') return question.options.map(value => ({ value, label: value }))
  return INTAKE_CHOICES.flatMap(choice => {
    // Group the UI without changing stored task types or returning a disallowed answer.
    const value = choice.types.find(type => question.options!.includes(type))
    return value === undefined ? [] : [{ value, label: choice.label }]
  })
}

function intakePresentation(question: AkinatorQuestion) {
  const choices = intakeOptions(question)
  const options = choices === undefined ? {} : { options: choices.map(({ label }) => ({ label })) }
  if (question.id === 'taskType') return {
    header: 'Kiokuko · 作業の選択',
    question: '今回は何をしてほしいですか？',
    ...options,
  }
  return {
    question: question.prompt,
    detail: question.id === 'target'
      ? '例：「このリポジトリ全体」「src/login.ts」「ログイン画面」「本番API」。分かる範囲で対象の名前やパスを入力してください。'
      : '例：「ログインに成功し、関連テストが通る」「READMEが導入手順だけになる」「原因と修正案が分かる」。作業がどうなれば完了かを入力してください。',
    ...options,
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
  ask(question: AkinatorQuestion, signal?: AbortSignal, agent?: DshUserQuestionAgent, memoryHints?: readonly ProfileMemoryHint[]): Promise<string>
}

function conflict(message: string): never { throw new KiokukoError('CONFLICT', message) }

export function createDshIntakeAnswerer(service: DshUserQuestions): DshIntakeAnswerer {
  return {
    async ask(question, signal, agent, memoryHints) {
      const presentation = intakePresentation(question)
      const hints = (memoryHints ?? []).filter(hint => hint.field === question.id).slice(0, 3)
      const hintDetail = hints.length ? '\n前回の例（今回の回答は自由に変更できます）:\n'
        + hints.map(hint => `${hint.value} — ${hint.source.observedAt.slice(0, 10)} / ${hint.source.runId}`).join('\n') : ''
      const result = await service.ask({
        questions: [{
          id: question.id,
          ...presentation,
          ...(question.options === null && hints.length ? { options: hints.map(hint => ({ label: hint.value, description: `前回の例 · ${hint.source.observedAt.slice(0, 10)}` })) } : {}),
          ...(hintDetail ? { detail: ('detail' in presentation ? presentation.detail : '') + hintDetail } : {}),
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
          const option = intakeOptions(question)?.[Number(normalized) - 1]?.value
          if (option === undefined) conflict(`選択肢の番号は1〜${presentation.options?.length ?? 0}で入力してください。`)
          return option
        }
        const displayIndex = presentation.options?.findIndex(option => option.label === value) ?? -1
        if (displayIndex >= 0) return intakeOptions(question)![displayIndex]!.value
      }
      return value
    },
  }
}

