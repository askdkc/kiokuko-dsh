/** Pure serialized marker recognition; public package imports must not load the optional DSH SDK. */
export const RUNTIME_CONTEXT_MARKER = '[Superseded runtime context]'
export function isRuntimeContextMarker(value: unknown): boolean {
  const message = value as { role?: unknown; source?: { kind?: unknown; form?: unknown; sections?: unknown }; content?: unknown } | null
  if (message?.role !== 'user' || message.source?.kind !== 'plugin:kiokuko-dsh' || message.source.form !== 'snapshot') return false
  return Array.isArray(message.source.sections) && message.source.sections.length === 0
    && Array.isArray(message.content) && message.content.length === 1
    && message.content[0]?.type === 'text' && message.content[0]?.text === RUNTIME_CONTEXT_MARKER
}
