import type { ModelBinding, ModelRole } from './model-configuration.js'
import type { EnnoOdunoState } from '../enno-oduno/types.js'
import type { DshNativeSession } from './session-bridge.js'
import { applyJapaneseOutputSkill } from './japanese-output-skill.js'
import type { PromptAssembly } from './japanese-output-skill.js'

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
export type ModelRoutingChoice = ModelBinding | undefined | { kind: 'native' }
export function installDshModelRouting(agent: RoutableAgent, beforeAssembly: (signal: AbortSignal) => Promise<ModelRoutingChoice>, ordinaryModel?: {
  load(): ModelBinding | undefined
  save(binding: ModelBinding): Promise<void>
}, guidance?: { prompts(): { require(name: string): Promise<string> }; assembled?(assembly: PromptAssembly): Promise<PromptAssembly | void>;
  beforeRequest?(binding: ModelBinding | undefined): Promise<void>; owner?(): string | undefined }): () => void {
  if (!agent.ctx) return () => {}
  let assembled: ModelBinding | undefined
  let ordinary: ModelBinding | undefined
  let routed = false
  let captureOrdinary = false
  let previousOwner: string | undefined
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly: any, context: { signal?: AbortSignal }, next: () => Promise<any>) => {
      const decision = await beforeAssembly(context.signal ?? new AbortController().signal)
      const owner = guidance?.owner?.()
      if (owner !== previousOwner) { ordinary = undefined; routed = false; captureOrdinary = false; previousOwner = owner }
      const native = decision !== undefined && 'kind' in decision && decision.kind === 'native'
      const selected = native ? undefined : decision as ModelBinding | undefined
      if (selected && !routed) {
        ordinary = ordinaryModel?.load()
        captureOrdinary = true
      }
      assembled = selected ? Object.freeze({ ...selected }) : native ? undefined : routed ? ordinary : undefined
      routed = selected !== undefined
      if (native) { ordinary = undefined; captureOrdinary = false }
      const result = await next()
      const prompt = await applyJapaneseOutputSkill(!assembled ? result : { ...result, variables: { ...result.variables, provider: assembled.provider, model: assembled.model } }, guidance?.prompts())
      return await guidance?.assembled?.(prompt) ?? prompt
    }, { prepend: true }),
    agent.ctx.on('agent/request', async (_payload: unknown, next: () => Promise<any>) => {
      const resolved = await next()
      await guidance?.beforeRequest?.(assembled)
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
