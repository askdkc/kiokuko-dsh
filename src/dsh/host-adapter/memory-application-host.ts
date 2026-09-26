import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { NativeAgent, NativeAgents, NativeCommands, NativeSessions, NativeSkills, NativeTools } from './native-events.js'
import { onNativeServiceEvent } from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import type { createTurnState } from './turn-state.js'
import type { DshEnnoDelegation } from '../enno-delegation.js'
import type { DshIntakeGate, DshCapabilityReadContext } from '../intake-gate.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'
import { mountMemoryApplication } from '../memory-application.js'
import { refreshContinuedTaskContext } from '../task-intake.js'
import { bindMemoryApplication, memoryRetrievalStatus } from '../../memory/application.js'

interface MemoryApplicationHostDependencies {
  readonly ctx: Context
  readonly runtime: DshCoreRuntime
  readonly tools: NativeTools | undefined
  readonly commands: NativeCommands | undefined
  readonly skills: NativeSkills | undefined
  readonly agents: NativeAgents | undefined
  readonly sessions: NativeSessions | undefined
  readonly delegation: DshEnnoDelegation
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly turnState: ReturnType<typeof createTurnState>
  readonly gate: DshIntakeGate
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<DshCapabilityCatalog>
}

export function mountHostMemoryApplication(deps: MemoryApplicationHostDependencies): (() => void) | undefined {
  const { ctx, runtime, tools, commands, skills, agents, sessions, delegation,
    currentSession, turnState, gate, capabilityCatalog } = deps
  return tools ? mountMemoryApplication({ tools: tools as any, on: (name: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }) => onNativeServiceEvent(ctx, name, listener, options), ...(commands ? { commands: commands as any } : {}) }, {
    runtime,
    session(value) {
      const agent = value as NativeAgent | undefined
      if (!agent?.session || agents?.get(agent.id) !== agent || sessions?.get(agent.session.id) !== agent.session || typeof agent.session.header?.cwd !== 'string') return undefined
      return { sessionId: agent.session.id, repositoryRoot: realpathSync(agent.session.header.cwd) }
    },
    resolve(execution) {
      const agent = execution.agent, session = agent?.session
      const item = session ? currentSession(session.id) : undefined
      if (!item || item.closed || item.nativeAgent !== agent || item.nativeSession !== session || delegation.isChild(agent)) return undefined
      return { runId: item.runId, workspace: item.workspace, sessionId: item.sessionId, repositoryRoot: item.repositoryRoot }
    },
    async refresh(execution, query) {
      const item = currentSession(execution.agent.session.id)!
      const captured = item.prepared
      const assertCurrent = () => {
        execution.signal.throwIfAborted()
        if (item.closed || item.prepared !== captured || currentSession(item.sessionId) !== item) throw new Error('Memory refresh task changed')
      }
      const result = await runtime.withDatabase(async database => {
        const value = await refreshContinuedTaskContext({ database, prepared: captured, task: query,
          capabilities: [...item.catalog.skills, ...item.catalog.tools], assertCurrent,
          validateCapabilities: async () => {
            assertCurrent()
            const fresh = await capabilityCatalog(skills, tools, { agent: { id: item.agentId }, nativeAgent: execution.agent, cwd: item.cwd, signal: execution.signal })
            gate.assertTurnStoppingCatalog(item.catalog, fresh)
          } })
        assertCurrent()
        bindMemoryApplication(database, { runId: item.runId, workspace: item.workspace, sessionId: item.sessionId, repositoryRoot: item.repositoryRoot }, captured.intake.profile, value.context,
          memoryRetrievalStatus(database, item.workspace, value.context, value.memoryPolicy.contextWithheld))
        return value
      })
      assertCurrent()
      item.prepared = { ...captured, ...result }
      const activePolicy = turnState.policyState(item.runId)
      if (activePolicy) {
        const { deliveryId: _previous, ...state } = activePolicy
        const next = { ...state, ...(result.context?.deliveryId ? { deliveryId: result.context.deliveryId } : {}) }
        turnState.applyPolicy(item.runId, next)
      }
      return result
    },
  }) : undefined
}
