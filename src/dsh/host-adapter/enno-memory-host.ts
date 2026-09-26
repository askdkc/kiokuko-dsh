import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshEnnoMemoryRefresh } from '../enno-memory-refresh.js'
import type { DshExecutionSupport } from '../execution-support.js'
import type { DshEnnoDelegation } from '../enno-delegation.js'
import type { StoredExecutionSelection } from '../execution-selection.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'
import type { DshCapabilityReadContext } from '../intake-gate.js'
import type { NativeSkills, NativeTools } from './native-events.js'
import type { TurnRecord } from './turn-state.js'
import type { createTurnState } from './turn-state.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { bindMemoryApplication, memoryRetrievalStatus } from '../../memory/application.js'

interface EnnoMemoryHostDependencies {
  readonly ennoMemory: DshEnnoMemoryRefresh
  readonly runtime: DshCoreRuntime
  readonly executionSupport: DshExecutionSupport
  readonly delegation: DshEnnoDelegation
  readonly getSelection: (runId: string) => StoredExecutionSelection | undefined
  readonly turnState: ReturnType<typeof createTurnState>
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<DshCapabilityCatalog>
  readonly skills: NativeSkills | undefined
  readonly tools: NativeTools | undefined
  readonly assertTurnStoppingCatalog: (expected: DshCapabilityCatalog, actual: DshCapabilityCatalog) => void
  readonly isHumanMessage: (value: unknown) => boolean
}

export function createEnnoMemoryHost(deps: EnnoMemoryHostDependencies) {
  const { ennoMemory, runtime, executionSupport, delegation, getSelection, turnState, currentSession,
    capabilityCatalog, skills, tools, assertTurnStoppingCatalog, isHumanMessage } = deps
  const refreshEnnoMemory = async (item: TurnRecord, signal: AbortSignal): Promise<void> => {
    if (!ennoMemory.enabled || !item.nativeAgent || !item.nativeSession || item.closed || executionSupport.paused(item.sessionId)
      || delegation.isChild(item.nativeAgent) || getSelection(item.runId)?.value.status !== 'ready') return
    const prepared = item.prepared, catalog = item.catalog, generation = item.prepareGeneration
    const policySnapshot = turnState.policyState(item.runId)
    const input = item.memoryInput ?? item.prepared.intake.profile.constraints ?? ''
    const nativeAgent = item.nativeAgent, nativeSession = item.nativeSession
    const inboxIdentity = () => canonicalContentHash([
      ...((nativeAgent as any).inbox?.nextStep ?? []), ...((nativeAgent as any).inbox?.nextTurn ?? []),
    ].filter(isHumanMessage))
    const pendingInput = inboxIdentity()
    const current = () => currentSession(item.sessionId) === item && !item.closed && item.prepareGeneration === generation
      && item.catalog === catalog && item.nativeAgent === nativeAgent && item.nativeSession === nativeSession
      && item.prepared.ennoOduno === prepared.ennoOduno && turnState.policyState(item.runId) === policySnapshot
      && (item.memoryInput ?? item.prepared.intake.profile.constraints ?? '') === input
      && !executionSupport.paused(item.sessionId) && inboxIdentity() === pendingInput
    await ennoMemory.refresh({ runId: item.runId, sessionId: item.sessionId, nativeAgent, nativeSession,
      prepared, capabilities: [...catalog.skills, ...catalog.tools], constraints: input, query:item.task, signal, isCurrent: current,
      validateCapabilities: async () => {
        const fresh = await capabilityCatalog(skills, tools, { agent: { id: item.agentId }, nativeAgent, cwd: item.cwd, signal })
        assertTurnStoppingCatalog(catalog, fresh)
      },
      ...(policySnapshot?.leaseToken === undefined ? {} : { leaseToken: policySnapshot.leaseToken }),
      apply: value => {
        if (item.closed || currentSession(item.sessionId)?.runId !== item.runId
          || currentSession(item.sessionId)?.nativeAgent !== nativeAgent || currentSession(item.sessionId)?.nativeSession !== nativeSession) return
        const target = currentSession(item.sessionId)!
        target.prepared = { ...target.prepared, ...value }
        const activePolicy = turnState.policyState(item.runId)
        if (activePolicy) {
          const { deliveryId: _previousDelivery, ...authority } = activePolicy
          const next = { ...authority, ...(value.context?.deliveryId ? { deliveryId: value.context.deliveryId } : {}) }
          turnState.applyPolicy(item.runId, next)
        }
      } })
    const refreshed = currentSession(item.sessionId)
    if (refreshed && !refreshed.closed && refreshed.nativeAgent === nativeAgent && refreshed.nativeSession === nativeSession) {
      await runtime.withDatabase(db => bindMemoryApplication(db, { runId: refreshed.runId, workspace: refreshed.workspace, sessionId: refreshed.sessionId, repositoryRoot: refreshed.repositoryRoot },
        refreshed.prepared.intake.profile, refreshed.prepared.context, memoryRetrievalStatus(db, refreshed.workspace, refreshed.prepared.context, refreshed.prepared.memoryPolicy.contextWithheld)))
    }
  }
  return { refreshEnnoMemory }
}
