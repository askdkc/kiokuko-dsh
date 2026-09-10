import { DeepModelSchema, type DeepModel } from './core/contracts.js'
import type { DeepNativeAgent } from './native-executor.js'

/** Read the exact Session's UI selection before falling back to creation options. */
export function currentDeepModel(agent: DeepNativeAgent): DeepModel | undefined {
  const context = agent.ctx as { get?(name: string, strict: boolean): any } | undefined
  const projection = agent.session && context?.get?.('sessionProjections', false)?.stateOf(agent.session, 'modelSelection')
  let candidate: unknown = agent.options
  if (projection !== undefined) {
    if (projection.pending !== null) candidate = projection.pending
    else {
      const header = (agent.session as { requestHeader?(): any }).requestHeader?.()
      candidate = header ? {
        provider: header.config.provider, model: header.config.model,
        ...(header.config.reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: header.config.reasoningEffort }),
      } : context?.get?.('agentDefaultModel', false)?.currentSelection()
    }
  }
  const binding = DeepModelSchema.safeParse(candidate && typeof candidate === 'object' ? {
    provider: (candidate as DeepModel).provider, model: (candidate as DeepModel).model,
    ...((candidate as DeepModel).reasoningEffort === undefined ? {} : { reasoningEffort: (candidate as DeepModel).reasoningEffort }),
  } : candidate)
  return binding.success ? binding.data : undefined
}
