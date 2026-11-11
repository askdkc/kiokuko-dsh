import { createUserMessage } from '@deepseek-ai/dsh-llm'
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

/** Retire only superseded state nodes through the durable native replacement API.
 * Markers have no runtime-context source, so replay is idempotent even after a
 * partially saved migration. Human input and intervening tool evidence stay put.
 */
export function retireLegacyRuntimeContexts(session: import('@deepseek-ai/dsh-session').Session): void {
  const contexts = session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message' && event.data.role === 'user'
      && event.data.source.kind === 'runtime-context' ? [event] : []
  })
  for (const event of contexts.slice(0, -1)) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[Superseded runtime context]' }],
      source: { kind: 'plugin:kiokuko-dsh', form: 'snapshot', sections: [] },
    }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
  }
}
