import type { Context } from '@deepseek-ai/cordis'
import type { DshMemoryFinalizer } from '../session-memory-finalizer.js'
import type { NativeAgent, NativeAgents, NativeSessions } from './native-events.js'
import { onNativeEvent } from './native-events.js'
import type { DshEnnoDelegation } from '../enno-delegation.js'
import type { DeepPlanningController } from '../../deep-thinker/controller.js'
import type { TurnRecord } from './turn-state.js'
import { DshEfficiencyObserver, mountDshEfficiencyObserver, type FinalizationInputMode } from '../efficiency.js'

interface EfficiencyHostDependencies {
  readonly ctx: Context
  readonly memoryFinalizer: DshMemoryFinalizer
  readonly agents: NativeAgents | undefined
  readonly sessions: NativeSessions | undefined
  readonly delegation: DshEnnoDelegation
  readonly deepPlanning: DeepPlanningController
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
}

export function createEfficiencyHost(deps: EfficiencyHostDependencies) {
  const { ctx, memoryFinalizer, agents, sessions, delegation, deepPlanning, currentSession } = deps
  let efficiency: DshEfficiencyObserver | undefined
  let efficiencyDisposers: (() => void)[] = []
  const closeEfficiency = () => {
    for (const dispose of efficiencyDisposers.reverse()) { try { dispose() } catch { efficiency?.unavailable() } }
    efficiencyDisposers = []
    efficiency?.close()
  }
  const configureEfficiency = (config: { observe: boolean; inputMode: FinalizationInputMode }) => {
    const observer = config.observe ? new DshEfficiencyObserver() : undefined
    memoryFinalizer.configure(config.inputMode, observer === undefined ? undefined : observation => observer.record(observation))
    closeEfficiency()
    efficiency = observer
    if (observer === undefined) return
    const scope = (ctx.root ?? ctx) as Context
    const observedAgents = new Map<string, NativeAgent>()
    const bind = (agent: NativeAgent | undefined) => {
      if (!agent?.session || agents?.get(agent.id) !== agent || sessions?.get(agent.session.id) !== agent.session) return
      if (observedAgents.size >= 2048 && !observedAgents.has(agent.session.id)) observedAgents.delete(observedAgents.keys().next().value!)
      observedAgents.set(agent.session.id, agent)
    }
    try {
      efficiencyDisposers.push(onNativeEvent(scope, 'agent/pre-step', (payload: { agent?: NativeAgent }, next: () => unknown) => {
        try { bind(payload.agent) } catch { /* optional attribution */ }
        return next()
      }, { global: true }))
      efficiencyDisposers.push(onNativeEvent(scope, 'agent/session-start', (payload: { agent?: NativeAgent }) => { try { bind(payload.agent) } catch { /* optional attribution */ } }, { global: true }))
      efficiencyDisposers.push(onNativeEvent(scope, 'session/disposed', (session: { id: string }) => {
        if (observedAgents.get(session.id)?.session === session) observedAgents.delete(session.id)
      }, { global: true }))
      efficiencyDisposers.push(mountDshEfficiencyObserver(scope, observer, (sessionId, request) => {
        const agent = observedAgents.get(sessionId)
        if (!agent?.session || agents?.get(agent.id) !== agent || sessions?.get(sessionId) !== agent.session) return undefined
        const child = delegation.observationBinding(agent) ?? deepPlanning.executor.observationBinding(agent)
        if (child !== undefined) return { sessionId, ...child, task: 'child' }
        const owner = currentSession(sessionId)
        if (owner === undefined || owner.nativeSession !== agent.session) return undefined
        return { sessionId, runId: owner.runId, task: request.purpose === undefined ? 'main' : 'auxiliary' }
      }))
    } catch { observer.unavailable(); closeEfficiency() }
  }
  return { get efficiency() { return efficiency }, configure: configureEfficiency, close: closeEfficiency }
}
