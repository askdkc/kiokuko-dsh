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
  readonly status?: string
  readonly inbox?: { readonly nextStep: readonly unknown[]; readonly nextTurn: readonly unknown[] }
  readonly model?: { current(): ModelBinding | undefined; select(binding: ModelBinding): void }
  runMaintenance?(task: (signal: AbortSignal) => Promise<void>): Promise<void>
}
/** Resolve routes before native step preparation, then retain the fixed route
 * throughout prompt assembly, provider preparation and retries. */
export type ModelRoutingChoice = ModelBinding | undefined | { kind: 'native' }
export function installDshModelRouting(agent: RoutableAgent, beforeAssembly: (signal: AbortSignal) => Promise<ModelRoutingChoice>, ordinaryModel?: {
  load(): ModelBinding | undefined
  save(binding: ModelBinding): Promise<void>
}, guidance?: { prompts(): { require(name: string): Promise<string> }; assembled?(assembly: PromptAssembly): Promise<PromptAssembly | void>;
  beforeStep?(binding: ModelBinding | undefined, signal: AbortSignal): Promise<void>;
  beforeRequest?(binding: ModelBinding | undefined): Promise<void>; owner?(): string | undefined }): () => void {
  if (!agent.ctx) return () => {}
  let assembled: ModelBinding | undefined
  let ordinary: ModelBinding | undefined
  let routed = false
  let captureOrdinary = false
  let previousOwner: string | undefined
  const nativeRouting = agent.model !== undefined && typeof agent.runMaintenance === 'function'
  const same = (a: ModelBinding, b: ModelBinding) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
  let routingFailure: unknown, maintenance: Promise<void> | undefined, disposed = false
  const choose = async (signal: AbortSignal) => {
      const decision = await beforeAssembly(signal)
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
  }
  const prepareNative = async (signal: AbortSignal) => {
    if (!nativeRouting || signal.aborted || disposed) return
    routingFailure = undefined
    await choose(signal)
    signal.throwIfAborted()
    if (disposed) return
    await guidance?.beforeStep?.(assembled ?? agent.model!.current(), signal)
    signal.throwIfAborted()
    if (disposed || !assembled) return
    if (captureOrdinary) {
      ordinary ??= agent.model!.current()
      if (ordinary) await ordinaryModel?.save(ordinary)
      captureOrdinary = false
    }
    signal.throwIfAborted()
    if (!disposed) agent.model!.select(assembled)
  }
  const disposers = [
    agent.ctx.on('system-prompt/assemble', async (_assembly: any, context: { signal?: AbortSignal; modelSelection?: ModelBinding }, next: () => Promise<any>) => {
      if (routingFailure) throw routingFailure
      await choose(context.signal ?? new AbortController().signal)
      if (nativeRouting && assembled && context.modelSelection && !same(assembled, context.modelSelection)) {
        throw new Error('Model route changed after native step preparation')
      }
      const result = await next()
      const prompt = await applyJapaneseOutputSkill(nativeRouting || !assembled ? result : { ...result, variables: { ...result.variables, provider: assembled.provider, model: assembled.model } }, guidance?.prompts())
      return await guidance?.assembled?.(prompt) ?? prompt
    }, { prepend: true }),
    agent.ctx.on('agent/request', async (_payload: unknown, next: () => Promise<any>) => {
      const resolved = await next()
      await guidance?.beforeRequest?.(assembled)
      if (nativeRouting || !assembled) return resolved
      if (captureOrdinary) {
        ordinary ??= { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
        await ordinaryModel?.save(ordinary)
        captureOrdinary = false
      }
      const { reasoningEffort: _inherited, ...rest } = resolved
      return { ...rest, ...assembled }
    }, { prepend: true }),
  ]
  if (nativeRouting) {
    // Inbox insertion precedes the driver's wake. Maintenance retains native
    // queue identity and Stop while asynchronous routing selects the next model.
    disposers.push(agent.ctx.on('agent/inbox/inserted', ({ agent: owner }: { agent: RoutableAgent }) => {
      if (owner !== agent || disposed || agent.status !== 'idle' || maintenance) return
      maintenance = agent.runMaintenance!(prepareNative)
      void maintenance.catch(error => { routingFailure = error }).finally(() => { maintenance = undefined })
    }))
    disposers.push(agent.ctx.on('tools/post-execute', async (execution: { agent?: object; parent?: unknown; signal: AbortSignal }, _result: unknown, next: () => Promise<unknown>) => {
      const result = await next()
      if (execution.agent === agent && execution.parent === undefined && !execution.signal.aborted) {
        try { await prepareNative(execution.signal) } catch (error) { routingFailure = error }
      }
      return result
    }))
    disposers.push(agent.ctx.on('agent/turn-stopping', async ({ signal }: { signal: AbortSignal }) => {
      try { await prepareNative(signal) } catch (error) { routingFailure = error }
    }))
  }
  return () => { disposed = true; for (const dispose of disposers.reverse()) dispose() }
}
export function isModelAvailabilityFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; failure?: unknown }
  if ([401, 403, 429].includes(Number(value.status ?? value.statusCode))) return true
  const text = [value.code, value.message].filter(v => typeof v === 'string').join(' ')
  return /(?:unauthori[sz]ed|authentication|(?:missing|invalid)[_ -]?credential|invalid[_ -]?api[_ -]?key|quota|rate[_ -]?limit|model[_ -]?not[_ -]?found|model.*(?:unavailable|not available|does not exist|access)|unsupported[_ -]?model)/iu.test(text)
    || value.failure !== undefined && value.failure !== error && isModelAvailabilityFailure(value.failure)
}
