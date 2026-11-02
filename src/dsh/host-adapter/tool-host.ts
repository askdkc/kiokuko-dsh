import { curatorClassifier } from '../decisions/curator.js'
import { DSH_MODEL_FACING_OPERATIONS, type DshToolHostBinding, type DshToolHost } from '../tools.js'
import { type DshUserQuestionAgent } from '../user-interaction.js'
import { KiokukoError } from '../../errors.js'
import { curateMemoryCandidates } from '../../memory/curator.js'
import { checkpointDshMemory, type ScopedCheckpointInput } from '../../memory/scoped-memory.js'
import type { TurnRecord } from './turn-state.js'
import type { createTurnState } from './turn-state.js'
import type { NativeSkills, NativeTools } from './native-events.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DecisionService } from '../decisions/service.js'
import type { DshExecutionSupport, ExecutionBinding } from '../execution-support.js'
import type { DshIntakeGate, DshCapabilityReadContext } from '../intake-gate.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'

function operationInput(
  args: unknown,
  binding: DshToolHostBinding,
  cwd: string,
  operation: string,
): Record<string, unknown> {
  const source = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
  if (operation === 'curator_check') return { ...source, cwd, workspace: binding.workspace }
  if (operation === 'memory_checkpoint') return { ...source, cwd, runId: binding.runId, ...(binding.deliveryId === undefined ? {} : { deliveryId: binding.deliveryId }) }
  return { ...source, cwd }
}

export function operationName(value: string): value is typeof DSH_MODEL_FACING_OPERATIONS[number] {
  return (DSH_MODEL_FACING_OPERATIONS as readonly string[]).includes(value)
}

interface ToolHostDependencies {
  readonly runtime: DshCoreRuntime
  readonly turnState: ReturnType<typeof createTurnState>
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly currentForAgentEvent: (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object) => TurnRecord | undefined
  readonly skills: NativeSkills | undefined
  readonly tools: NativeTools | undefined
  readonly gate: Pick<DshIntakeGate, 'assertTurnStoppingCatalog'>
  readonly decisions: DecisionService
  readonly executionSupport: DshExecutionSupport
  readonly executionBinding: (item: TurnRecord) => ExecutionBinding
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<DshCapabilityCatalog>
}

export function createToolHost({
  runtime, turnState, currentSession, currentForAgentEvent, skills, tools,
  gate, decisions, executionSupport, executionBinding, capabilityCatalog,
}: ToolHostDependencies) {
  const toolHost: DshToolHost = {
    bind: (execution) => {
      const sessionId = execution.agent?.dshSessionId
      if (sessionId === undefined) throw new Error('kiokuko-dsh tool session identity is unavailable')
      const item = currentSession(sessionId)
      if (item === undefined || item.closed) throw new Error('kiokuko-dsh tool session is not bound to an active run')
      if (item.nativeSession !== execution.agent?.nativeSession) throw new Error('kiokuko-dsh tool native session identity is stale')
      if (execution.agent?.turn !== undefined && execution.agent.turn !== item.turn) throw new Error('kiokuko-dsh tool turn identity is stale')
      const state = turnState.policyState(item.runId)
      if (state === undefined || state.dshSessionId !== sessionId) throw new Error('kiokuko-dsh tool state is unavailable')
      return {
        dshSessionId: sessionId,
        runId: state.runId,
        workspace: state.workspace,
        orchestrationId: state.orchestrationId,
        ...(state.deliveryId === undefined ? {} : { deliveryId: state.deliveryId }),
        revision: state.revision,
      }
    },
    execute: async (operation, args, binding, signal) => {
      if (!operationName(operation)) throw new Error('Unsupported Kiokuko dsh operation')
      const run = turnState.allTurns()
        .filter((item) => item.runId === binding.runId && item.sessionId === binding.dshSessionId && !item.closed)
        .sort((left, right) => right.turn - left.turn)[0]
      const currentState = run === undefined ? undefined : turnState.policyState(run.runId)
      if (binding.dshSessionId === undefined || run === undefined || run.closed
        || binding.workspace !== run.workspace
        || binding.orchestrationId !== run.orchestrationId
        || currentState === undefined
        || binding.revision !== currentState.revision) throw new Error('kiokuko-dsh tool binding is not authoritative')
      if (signal?.aborted) throw signal.reason
      const cwd = run.cwd
      const operationSignal = signal ?? new AbortController().signal
      const currentCatalog = await capabilityCatalog(skills, tools, {
        agent: { id: run.agentId },
        ...(run.nativeAgent === undefined ? {} : { nativeAgent: run.nativeAgent }),
        cwd,
        signal: operationSignal,
      })
      gate.assertTurnStoppingCatalog(run.catalog, currentCatalog)
      const value = await runtime.withDatabase(async (database) => {
        const input = operationInput(args, binding, cwd, operation)
        if (operation === 'curator_check') {
          const backend = await curatorClassifier(decisions)
          return curateMemoryCandidates(database, input, { ...(backend ? { backend } : {}), signal: operationSignal })
        }
        return checkpointDshMemory(database, input as unknown as ScopedCheckpointInput, signal)
      })
      await executionSupport.refresh(executionBinding(run), false)
      return value
    },
  }

  const assertTurnBoundary = async (event: {
    readonly agent: { readonly id: string; readonly sessionId?: string; readonly nativeSession?: object; readonly nativeAgent?: DshUserQuestionAgent }
    readonly turn: number
    readonly signal: AbortSignal
  }): Promise<TurnRecord> => {
    const item = currentForAgentEvent(
      event.agent.id,
      event.agent.sessionId,
      event.turn,
      event.agent.nativeSession,
      event.agent.nativeAgent,
    )
    if (item === undefined || item.closed) throw new Error('kiokuko-dsh turn boundary identity is stale')
    const currentCatalog = await capabilityCatalog(skills, tools, {
      agent: { id: event.agent.id },
      ...(event.agent.nativeAgent === undefined ? {} : { nativeAgent: event.agent.nativeAgent }),
      cwd: item.cwd,
      signal: event.signal,
    })
    gate.assertTurnStoppingCatalog(item.catalog, currentCatalog)
    return item
  }

  return {
    toolHost, assertTurnBoundary,
  }
}
