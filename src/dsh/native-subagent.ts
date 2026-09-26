/** Identify a DSH-owned child from native session metadata, never user text. */
export function isNativeSubagent(agent: { readonly session?: { readonly header?: {
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
} } }): boolean {
  const header = agent.session?.header
  if (header === undefined) return false
  const depth = header.delegationDepth
  return (typeof header.parentSession === 'string' && header.parentSession.trim().length > 0)
    || header.origin === 'subagent'
    || (typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0)
}
