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
  const nodes = [...session.surface.nodes]
  const isContext = (seq: import('@deepseek-ai/dsh-session').SessionSeq) => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message' && event.data.role === 'user'
      && event.data.source.kind === 'runtime-context'
  }
  const latest = [...nodes].reverse().find(isContext)
  let run: typeof nodes = []
  const flush = () => {
    if (run.length === 0) return
    const first = session.eventAt(run[0]!)!
    if (run.length > 1 || !isRuntimeContextMarker(first.data)) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: RUNTIME_CONTEXT_MARKER }],
        source: { kind: 'plugin:kiokuko-dsh', form: 'snapshot', sections: [] },
      }), { surfaceOp: { op: 'replace', startSeq: run[0]!, endSeq: run.at(-1)! }, sourceEventSeqs: [...run] })
    }
    run = []
  }
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (seq !== latest && (isContext(seq) || (event?.type === 'user/message' && isRuntimeContextMarker(event.data)))) run.push(seq)
    else flush()
  }
  flush()
}

export const RUNTIME_CONTEXT_MARKER = '[Superseded runtime context]'
export function isRuntimeContextMarker(value: unknown): boolean {
  const message = value as { role?: unknown; source?: { kind?: unknown; form?: unknown; sections?: unknown }; content?: unknown } | null
  if (message?.role !== 'user' || message.source?.kind !== 'plugin:kiokuko-dsh' || message.source.form !== 'snapshot') return false
  return Array.isArray(message.source.sections) && message.source.sections.length === 0
    && Array.isArray(message.content) && message.content.length === 1
    && message.content[0]?.type === 'text' && message.content[0]?.text === RUNTIME_CONTEXT_MARKER
}
