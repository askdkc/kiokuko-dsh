/** Context from host-observed UI answers; it never grants execution authority. */
export interface ClarificationSource {
  readonly id: string
  readonly text: string
}
export interface ClarificationAnswer {
  readonly id: string
  readonly questionId: string
  readonly question: string
  readonly value: string
  readonly scope: string
  readonly sourceIds: readonly string[]
}
export interface ClarificationContext {
  readonly sources: readonly ClarificationSource[]
  readonly answers: readonly ClarificationAnswer[]
}
export function collectClarificationContext(
  messages: readonly ClarificationSource[],
  known: ReadonlyMap<string, ClarificationContext>,
): ClarificationContext {
  const sources = new Map<string, ClarificationSource>(),
    answers = new Map<string, ClarificationAnswer>()
  for (const message of messages) {
    const previous = known.get(message.id)
    for (const source of previous?.sources ?? [message]) {
      const old = sources.get(source.id)
      if (old && old.text !== source.text)
        throw new Error('Conflicting clarification source identity')
      sources.set(source.id, source)
    }
    for (const answer of previous?.answers ?? []) {
      const old = answers.get(answer.id)
      if (old && JSON.stringify(old) !== JSON.stringify(answer))
        throw new Error('Conflicting clarification answer identity')
      answers.set(answer.id, answer)
    }
  }
  return { sources: [...sources.values()], answers: [...answers.values()] }
}
export function reusableClarificationAnswer(
  context: ClarificationContext,
  question: string,
  scope: string,
): ClarificationAnswer | undefined {
  const answer = [...context.answers]
    .reverse()
    .find((answer) => answer.question === question)
  return answer?.question === question &&
    answer.scope === scope &&
    answer.sourceIds.length === context.sources.length &&
    answer.sourceIds.every((id) =>
      context.sources.some((source) => source.id === id),
    )
    ? answer
    : undefined
}
export function clarificationReply(
  context: ClarificationContext,
  input: Omit<ClarificationAnswer, 'sourceIds'>,
): { context: ClarificationContext; content: string } {
  const answer = {
    ...input,
    sourceIds: context.sources.map((source) => source.id),
  }
  const prior = context.answers
    .map(
      (value) =>
        `Earlier native user answer to clarification "${value.question}" (source revision ${value.questionId}:${value.id}):\n${value.value}`,
    )
    .join('\n\n')
  const content = `Original user request (unchanged):\n${context.sources.map((source) => source.text).join('\n')}\n\n${prior ? prior + '\n\n' : ''}Latest native user answer to clarification "${input.question}" (source revision ${input.questionId}:${input.id}; same question and current scope):\n${input.value}\n\nInterpret this latest explicit answer as a revision only where it changes the earlier instruction within this question’s scope. Preserve unrelated constraints. Native permissions and task ownership still apply.`
  return {
    context: {
      sources: [...context.sources],
      answers: [...context.answers, answer],
    },
    content,
  }
}
