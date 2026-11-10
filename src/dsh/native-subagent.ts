export function parentOnlyTaskToolMessage(tool: string): string {
  return `${tool} is parent-only. A native child cannot prepare or change the parent task. Report the ownership denial to the parent; retrying this tool or rewriting its arguments cannot restore child authority.`
}

/** Identify native delegation; parentSession also links main-conversation branches. */
export function isNativeSubagent(agent: { readonly session?: object }): boolean {
  const session = agent.session
  const header = session && 'header' in session ? session.header : undefined
  if (!header || typeof header !== 'object') return false
  const depth = 'delegationDepth' in header ? header.delegationDepth : undefined
  return ('origin' in header && header.origin === 'subagent')
    || (typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0)
}
