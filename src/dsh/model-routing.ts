import type { ModelBinding, ModelRole } from './model-configuration.js'
import type { EnnoOdunoState } from '../enno-oduno/types.js'
import type { DshNativeSession } from './session-bridge.js'

export function modelRoleForState(state: EnnoOdunoState): Exclude<ModelRole, 'worker'> | undefined {
  switch (state.status) {
    case 'oduno_ideal': return 'ideal'
    case 'zenki_planning': case 'needs_confirmation': return 'zenki'
    case 'goki_executing': return 'goki'
    case 'enno_verifying': case 'oduno_meditation': return 'check'
    default: return undefined
  }
}
export interface RoutableAgent {
  readonly id: string
  readonly ctx?: { on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => void }
  readonly session?: DshNativeSession
}
/** Equivalent public hooks to DSH installModelSelection, with asynchronous host admission.
 * Assembly precedes agent/pre-step in 0.1.2-rc.1. Capture a detached selection
 * before next(), and reuse that exact value for every retry of this request.
 */
export function installDshModelRouting(agent: RoutableAgent, beforeAssembly: (signal: AbortSignal) => Promise<ModelBinding | undefined>, ordinaryModel?: {
  load(): ModelBinding | undefined
  save(binding: ModelBinding): Promise<void>
}): () => void {
  if (!agent.ctx) return () => {}
  let assembled: ModelBinding | undefined
  let ordinary: ModelBinding | undefined
  let routed = false
  let captureOrdinary = false
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly: any, context: { signal?: AbortSignal }, next: () => Promise<any>) => {
      const selected = await beforeAssembly(context.signal ?? new AbortController().signal)
      if (selected && !routed) {
        ordinary = ordinaryModel?.load()
        captureOrdinary = true
      }
      assembled = selected ? Object.freeze({ ...selected }) : routed ? ordinary : undefined
      routed = selected !== undefined
      const result = await next()
      return !assembled ? result : { ...result, variables: { ...result.variables, provider: assembled.provider, model: assembled.model } }
    }, { prepend: true }),
    agent.ctx.on('agent/request', async (_payload: unknown, next: () => Promise<any>) => {
      const resolved = await next()
      if (!assembled) return resolved
      if (captureOrdinary) {
        ordinary ??= { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
        await ordinaryModel?.save(ordinary)
        captureOrdinary = false
      }
      const { reasoningEffort: _inherited, ...rest } = resolved
      return { ...rest, ...assembled }
    }, { prepend: true }),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
export function isModelAvailabilityFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; failure?: unknown }
  if ([401, 403, 429].includes(Number(value.status ?? value.statusCode))) return true
  const text = [value.code, value.message].filter(v => typeof v === 'string').join(' ')
  return /(?:unauthori[sz]ed|authentication|(?:missing|invalid)[_ -]?credential|invalid[_ -]?api[_ -]?key|quota|rate[_ -]?limit|model[_ -]?not[_ -]?found|model.*(?:unavailable|not available|does not exist|access)|unsupported[_ -]?model)/iu.test(text)
    || value.failure !== undefined && value.failure !== error && isModelAvailabilityFailure(value.failure)
}
