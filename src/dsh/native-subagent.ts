/** Identify native delegation; parentSession also links main-conversation branches. */
export function isNativeSubagent(agent: { readonly session?: { readonly header?: {
  readonly parentSession?: unknown
  readonly origin?: string
  readonly delegationDepth?: number
} } }): boolean {
  const header = agent.session?.header
  if (header === undefined) return false
  const depth = header.delegationDepth
  return header.origin === 'subagent'
    || (typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0)
}
