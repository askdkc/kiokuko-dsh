/** Shared host service key; importing it must not pull Lisp into modular core. */
export const LISP_CODING_SERVICE = 'kiokukoLispCoding'

export const LISP_ASSEMBLY_SERVICE = 'kiokukoLispAssembly'
/** Stable installed capabilities belong to the shared host contract, not the optional runtime. */
export function stableLispCapabilities<T extends { name: string; description?: string }>(tools: readonly T[], agent: any): readonly { name: string; description?: string }[] {
  const service = agent?.ctx?.get?.(LISP_ASSEMBLY_SERVICE, false) as { capabilities?: readonly { name: string; description: string }[]; inventory?: (agent: any) => readonly { name: string; description?: string }[] } | undefined
  const installed = service?.capabilities
  if (!installed) return tools
  const inventory = service?.inventory?.(agent) ?? tools
  const names = new Set(installed.map(tool => tool.name))
  return [...inventory.filter(tool => !names.has(tool.name)), ...installed]
}
