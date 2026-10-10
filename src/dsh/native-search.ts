/** Missing-target guidance for native ripgrep, without replacing its tool or execution. */
import { onNativeEvent } from './host-adapter/native-events.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only an exact, single-target native ENOENT diagnostic proves the requested path is missing. */
function missingTargetMessage(arguments_: unknown, result: unknown): string | undefined {
  if (!isRecord(arguments_) || typeof arguments_.path !== 'string' || arguments_.path.length === 0
    || !isRecord(result) || result.isError !== true || !isRecord(result.error)
    || !isRecord(result.error.info) || result.error.info.code !== 'SEARCH_FAILED') return undefined

  const path = arguments_.path
  // Do not turn mixed, truncated, or descendant diagnostics into a claim about the search root.
  const diagnostic = `${path}: IO error for operation on ${path}: No such file or directory (os error 2)`
  const prefix = 'grep search failed (exit 2): '
  if (result.error.message !== prefix + diagnostic && result.error.message !== prefix + 'rg: ' + diagnostic) return undefined

  return `cannot search ${JSON.stringify(path)}: not found - check the path, or omit the path to search the session workspace.`
}

/** Preserve native identity, policies, result metadata, timeouts and complete-result spill handling. */
export function mountNativeSearch(context: object): () => void {
  return onNativeEvent(context, 'tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.name !== 'grep' || !isRecord(decision) || decision.kind !== 'accept'
      || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision

    const message = missingTargetMessage(execution.arguments, result)
    return message === undefined ? decision : { ...decision, content: [{ type: 'text', text: message }] }
  }, { global: true })
}
