/** Runtime context is a complete current snapshot, not conversation history.
 * Keep the latest snapshot at its original position; preserve all human input,
 * tool evidence and other sources. Native events remain untouched for audit.
 * Recompute from the retained surface on every attempt so compaction, resume,
 * A -> B -> A transitions and explicit empty snapshots need no extra cache. */
export function projectRuntimeContextMessages<T>(messages: readonly T[]): T[] {
  const isContext = (message: any): boolean => message?.role === 'user' && message.source?.kind === 'runtime-context'
  let latest = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isContext(messages[index])) { latest = index; break }
  }
  return messages.filter((message, index) => index === latest || !isContext(message))
}
