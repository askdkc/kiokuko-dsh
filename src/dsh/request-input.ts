/** Native request carriers, not a test for human consent. Goal rounds retain
 * their source identity and never qualify as clarification/approval replies. */
export function isRequestInput(message: any): boolean {
  if (message?.role !== 'user') return false
  const source = message.source
  if (!source || source.kind === 'user') return true
  return source.kind === 'goal' &&
    typeof source.goalId === 'string' && source.goalId.length > 0 &&
    Number.isSafeInteger(source.revision) && source.revision > 0 &&
    Number.isSafeInteger(source.round) && source.round > 0
}

export function hasRequestInput(messages: readonly unknown[]): boolean {
  return messages.some(isRequestInput)
}
