import { randomUUID } from 'node:crypto'
import type { DshModelMessage } from './context-injection.js'
import type { DshLogEvent } from './session-memory-finalizer.js'

interface ContextSession {
  readonly surface?: { readonly nodes: readonly number[] }
  readonly eventAt?: (seq: number) => DshLogEvent | undefined
  readonly snapshotEvents?: () => readonly DshLogEvent[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Read retained messages, excluding chunk history and compacted-away instructions. */
function retainedEvents(session: ContextSession): readonly DshLogEvent[] {
  if (session.surface !== undefined && session.eventAt !== undefined) {
    return session.surface.nodes.flatMap(seq => {
      const event = session.eventAt!(seq)
      return event === undefined ? [] : [event]
    })
  }
  const nodes: DshLogEvent[] = []
  for (const event of session.snapshotEvents?.() ?? []) {
    if (event.surfaceOp === 'append') nodes.push(event)
    else if (event.surfaceOp !== undefined) {
      const replacement = event.surfaceOp
      const start = nodes.findIndex(node => node.seq === replacement.start)
      const end = nodes.findIndex(node => node.seq === replacement.end)
      if (start < 0 || end < start) throw new Error('Kiokuko context projection encountered an invalid session replacement')
      nodes.splice(start, end - start + 1, event)
    }
  }
  return nodes
}

/**
 * Emit only changed named fragments. Delivery is proven by the native surface
 * or the current claimed/queued batch, never by an earlier projection attempt.
 * Rebuilding from the surface also restores needed fragments after compaction,
 * resume, or plugin reload without a second persistence/cache owner.
 */
export function projectDshContext(
  messages: readonly DshModelMessage[],
  session: ContextSession,
  pending: readonly unknown[] = [],
): readonly unknown[] {
  const latest = new Map<string, string>()
  for (const value of [
    ...retainedEvents(session).filter(event => event.type === 'user/message').map(event => event.data),
    ...pending,
  ]) {
    const message = record(value)
    const source = record(message?.source)
    if (message?.role !== 'user' || source?.kind !== 'plugin' || source.plugin !== 'kiokuko-dsh'
      || source.form !== 'snapshot' || !Array.isArray(source.sections) || source.sections.length !== 1) continue
    const section = record(source.sections[0])
    const content = message.content
    if (typeof section?.name !== 'string' || typeof section.text !== 'string'
      || !Array.isArray(content) || content.length !== 1) continue
    const block = record(content[0])
    if (block?.type === 'text' && block.text === section.text) latest.set(section.name, section.text)
  }
  return messages.flatMap(message => {
    const name = `${message.source}:${message.name}`
    if (latest.get(name) === message.content) return []
    latest.set(name, message.content)
    return [{
      id: randomUUID(),
      role: message.role,
      content: [{ type: 'text', text: message.content }],
      source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'snapshot', sections: [{ name, text: message.content }] },
    }]
  })
}
