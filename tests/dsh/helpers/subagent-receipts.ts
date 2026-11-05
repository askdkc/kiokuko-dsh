/** Resolve the reference shown to the model into the session ID used by lifecycle events. */
export async function continuableSessionIds(agent: any, subagents: any): Promise<string[]> {
  const references = agent.session.snapshotEvents().flatMap((event: any) => event.type === 'tool/result'
    ? event.data.message?.content?.flatMap((block: any) => {
      const match = block.type === 'text' ? /^started subagent (\S+)$/.exec(block.text) : null
      return match ? [match[1]!] : []
    }) ?? [] : []) as string[]
  // Hosts before the name catalog expose session IDs directly in the receipt.
  const signal = new AbortController().signal
  return Promise.all(references.map(reference => subagents.resolveName?.(agent, reference, signal) ?? reference))
}
