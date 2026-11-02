import type { TaskLease } from '../task-state.js'
import { dshPonytailOwnerKey, type DshPonytailModes } from '../commands.js'
import type { DshIntakeGateResult, DshPreStepEvent } from '../intake-gate.js'
import type { DshToolPolicy, DshToolPolicyState } from '../tool-policy.js'
import type { StoredExecutionSelection } from '../execution-selection.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'
import type { DshUserQuestionAgent } from '../user-interaction.js'
import type { ExecutionBinding } from '../execution-support.js'
import type { RequestIntentContext, RequestIntentDecision } from '../decisions/request-intent.js'
import type { MemoryOwnerKind } from '../memory-owner.js'
import { canonicalContentHash } from '../../serialization/validate.js'

export interface TurnRecord {
  authority?: TaskLease
  readonly agentId: string
  readonly sessionId: string
  readonly runId: string
  readonly workspace: string
  readonly orchestrationId: string
  readonly repositoryRoot: string
  readonly cwd: string
  readonly profileHints?: DshPreStepEvent['profileHints']
  readonly deferTaskTypeInference?: boolean
  requestIntent?: RequestIntentDecision
  requestIntentContext?: RequestIntentContext
  memoryOwner: MemoryOwnerKind
  nativeAgent?: DshUserQuestionAgent
  nativeSession?: object
  task: string
  turn: number
  prepared: DshIntakeGateResult['prepared']
  catalog: DshCapabilityCatalog
  /** Monotonic host generation assigned before each prepare begins. */
  prepareGeneration: number
  memoryInput?: string
  memoryRebuildAttempts: number
  failed: boolean
  closed: boolean
}

export function createTurnState(
  modes: Pick<DshPonytailModes, 'begin' | 'end'>,
  policy: Pick<DshToolPolicy, 'setState' | 'clearSession'>,
  getSelection: (runId: string) => StoredExecutionSelection | undefined,
) {
  const turns = new Map<string, TurnRecord>()
  const latestBySession = new Map<string, TurnRecord>()
  const states = new Map<string, DshToolPolicyState>()
  const activeModeRequests = new Map<string, string>()
  const currentSession = (sessionId: string): TurnRecord | undefined => latestBySession.get(sessionId)
  const applyPolicy = (runId: string, state: DshToolPolicyState): void => {
    states.set(runId, state)
    policy.setState(state)
  }
  const identityKey = (agentId: string, sessionId: string): string => dshPonytailOwnerKey(agentId, sessionId)
  const turnKey = (agentId: string, sessionId: string, turn: number): string => `${identityKey(agentId, sessionId)}\u0000${turn}`
  const record = (event: DshPreStepEvent, result: DshIntakeGateResult, generation: number, authority?: TaskLease): void => {
    const run = result.prepared.run.runId
    const latest = latestBySession.get(event.sessionId)
    if (latest !== undefined && (latest.nativeAgent !== event.nativeAgent || latest.nativeSession !== event.nativeSession)) {
      throw new Error('kiokuko-dsh session identity changed while the previous native session is active')
    }
    if (latest !== undefined && latest.turn > event.turn) return
    const key = turnKey(event.agent.id, event.sessionId, event.turn)
    const previous = turns.get(key)
    if (previous !== undefined && previous.runId !== run) throw new Error('kiokuko-dsh logical turn changed run identity')
    if (previous !== undefined && (previous.nativeAgent !== event.nativeAgent || previous.nativeSession !== event.nativeSession)) {
      throw new Error('kiokuko-dsh logical turn changed native agent or session identity')
    }
    if (previous !== undefined && generation <= previous.prepareGeneration) return
    const sameAuthority = previous?.authority?.sessionId === authority?.sessionId && previous?.authority?.revision === authority?.revision
      && previous?.authority?.generation === authority?.generation
    const item: TurnRecord = previous ? sameAuthority ? previous : { ...previous } : {
      agentId: event.agent.id,
      sessionId: event.sessionId,
      runId: run,
      workspace: result.prepared.project.workspace,
      orchestrationId: result.prepared.intake.sessionId,
      repositoryRoot: result.prepared.project.repositoryRoot,
      cwd: event.cwd,
      task: event.task,
      ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
      ...(event.deferTaskTypeInference ? { deferTaskTypeInference: true } : {}),
      ...(event.requestIntent === undefined ? {} : { requestIntent: event.requestIntent }),
      ...(event.requestIntentContext === undefined ? {} : { requestIntentContext: event.requestIntentContext }),
      memoryOwner: event.memoryOwner ?? result.prepared.memoryOwner?.kind ?? 'none',
      turn: event.turn,
      prepared: result.prepared,
      catalog: result.catalog,
      prepareGeneration: generation,
      ...(latest?.runId === run && latest.memoryInput !== undefined ? { memoryInput: latest.memoryInput } : {}),
      memoryRebuildAttempts: 0,
      failed: false,
      closed: false,
    }
    if (authority) item.authority = Object.freeze({ ...authority }); else delete item.authority
    if (event.nativeAgent !== undefined) item.nativeAgent = event.nativeAgent
    if (event.nativeSession !== undefined) item.nativeSession = event.nativeSession
    item.turn = event.turn
    const previousMemoryOwner = previous?.prepared.memoryOwner
    const nextMemoryOwner = result.prepared.memoryOwner
    const sameMemoryOwner = previousMemoryOwner?.kind === nextMemoryOwner?.kind
      && previousMemoryOwner?.agentId === nextMemoryOwner?.agentId && previousMemoryOwner?.sessionId === nextMemoryOwner?.sessionId
      && previousMemoryOwner?.turn === nextMemoryOwner?.turn && previousMemoryOwner?.requestDigest === nextMemoryOwner?.requestDigest
      && previousMemoryOwner?.runId === nextMemoryOwner?.runId
    item.prepared = result.prepared
    item.prepareGeneration = generation
    item.task = event.task
    if (event.requestIntent !== undefined) item.requestIntent = event.requestIntent
    if (event.requestIntentContext !== undefined) item.requestIntentContext = event.requestIntentContext
    item.memoryOwner = event.memoryOwner ?? result.prepared.memoryOwner?.kind ?? item.memoryOwner
    if (!sameMemoryOwner) item.memoryRebuildAttempts = 0
    item.catalog = result.catalog
    turns.set(key, item)
    latestBySession.set(event.sessionId, item)
    const modeRequest = `dsh:${event.agent.id}:${event.sessionId}:${event.turn}`
    const modeKey = identityKey(event.agent.id, event.sessionId)
    const activeModeRequest = activeModeRequests.get(modeKey)
    if (activeModeRequest !== modeRequest) {
      if (activeModeRequest !== undefined) modes.end(activeModeRequest)
      modes.begin(modeRequest, modeKey)
      activeModeRequests.set(modeKey, modeRequest)
    }
    const deliveryId = result.prepared.context?.deliveryId
    const next: DshToolPolicyState = {
      phase: 'normal',
      runId: item.runId,
      workspace: item.workspace,
      orchestrationId: item.orchestrationId,
      ...(deliveryId === null || deliveryId === undefined ? {} : { deliveryId }),
      revision: 1,
      dshSessionId: event.sessionId,
      nativeTurn: event.turn,
    }
    applyPolicy(item.runId, next)
  }
  const currentForAgentEvent = (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object): TurnRecord | undefined => {
    // The session is the authoritative route key. Agent ID alone is not
    // sufficient because an agent can own multiple sessions over its life.
    if (sessionId === undefined) return undefined
    const matchesNativeIdentity = (item: TurnRecord): boolean => {
      const sessionMatches = item.nativeSession === undefined ? nativeSession === undefined : nativeSession !== undefined && item.nativeSession === nativeSession
      const agentMatches = item.nativeAgent === undefined ? nativeAgent === undefined : nativeAgent !== undefined && item.nativeAgent === nativeAgent
      return sessionMatches && agentMatches
    }
    const item = currentSession(sessionId)
    return item?.agentId === agentId && (turn === undefined || item.turn === turn) && matchesNativeIdentity(item) ? item : undefined
  }
  const allTurns = (): readonly TurnRecord[] => [...turns.values()]
  const executionBinding = (item: TurnRecord): ExecutionBinding => ({
    runId: item.runId, sessionId: item.sessionId, nativeAgent: item.nativeAgent, nativeSession: item.nativeSession,
    cwd: item.cwd, repositoryRoot: item.repositoryRoot, task: item.task, turn: item.turn,
    chat: item.prepared.intake.profile.taskType === 'chat' || !!getSelection(item.runId)?.value.discussion,
    terminal: item.closed,
    generation: canonicalContentHash({ runId: item.runId, task: item.task }),
  })
  const sessionIds = (): readonly string[] => [...latestBySession.keys()]
  const releaseRun = (runId: string, authority?: TaskLease): void => {
    const items = [...turns.values()].filter(item => item.runId === runId && (!authority || item.authority?.sessionId === authority.sessionId && item.authority.generation === authority.generation))
    for (const item of items) {
      const modeKey = identityKey(item.agentId, item.sessionId)
      const modeRequest = `dsh:${item.agentId}:${item.sessionId}:${item.turn}`
      if (activeModeRequests.get(modeKey) === modeRequest) {
        modes.end(modeRequest)
        activeModeRequests.delete(modeKey)
      }
      turns.delete(turnKey(item.agentId, item.sessionId, item.turn))
      if (latestBySession.get(item.sessionId) === item) latestBySession.delete(item.sessionId)
    }
    for (const sessionId of new Set(items.map(item => item.sessionId))) {
      if (![...turns.values()].some(item => item.sessionId === sessionId && !item.closed)) policy.clearSession(sessionId)
    }
    if (![...turns.values()].some(item => item.runId === runId)) {
      states.delete(runId)
    }
  }
  const clear = (): void => {
    turns.clear()
    latestBySession.clear()
    states.clear()
    activeModeRequests.clear()
  }
  return {
    record, currentSession, currentForAgentEvent, allTurns, sessionIds, executionBinding,
    policyState: (runId: string): DshToolPolicyState | undefined => states.get(runId),
    applyPolicy,
    releaseRun, clear,
  }
}
