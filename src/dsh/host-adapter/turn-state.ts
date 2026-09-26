import { dshPonytailOwnerKey, type DshPonytailModes } from '../commands.js'
import type { DshIntakeGateResult, DshPreStepEvent } from '../intake-gate.js'
import type { DshToolPolicy, DshToolPolicyState } from '../tool-policy.js'
import type { StoredExecutionSelection } from '../execution-selection.js'
import type { EnnoOperationResponse } from '../../enno-oduno/service.js'
import type { EnnoOdunoState } from '../../enno-oduno/types.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'
import type { DshUserQuestionAgent } from '../user-interaction.js'
import type { ExecutionBinding } from '../execution-support.js'
import { canonicalContentHash } from '../../serialization/validate.js'

export interface TurnRecord {
  readonly agentId: string
  readonly sessionId: string
  readonly runId: string
  readonly workspace: string
  readonly orchestrationId: string
  readonly repositoryRoot: string
  readonly cwd: string
  readonly profileHints?: DshPreStepEvent['profileHints']
  nativeAgent?: DshUserQuestionAgent
  nativeSession?: object
  task: string
  turn: number
  prepared: DshIntakeGateResult['prepared']
  catalog: DshCapabilityCatalog
  /** Monotonic host generation assigned before each prepare begins. */
  prepareGeneration: number
  memoryInput?: string
  failed: boolean
  closed: boolean
}

function phaseForState(state: EnnoOdunoState): DshToolPolicyState['phase'] {
  if (!state.applicable) return 'completed'
  if (state.status === 'intake') return 'intake'
  if (state.status === 'oduno_ideal') return 'ideal'
  if (state.status === 'zenki_planning') return 'planning'
  if (state.status === 'needs_confirmation') return 'confirmation'
  if (state.status === 'goki_executing') return 'goki'
  if (state.status === 'enno_verifying') return 'verifying'
  if (state.status === 'oduno_meditation') return 'meditation'
  if (state.status === 'blocked') return 'blocked'
  if (state.status === 'cancelled') return 'cancelled'
  return 'completed'
}

export function policyState(state: EnnoOdunoState, record: TurnRecord, sessionId: string, lease?: EnnoOperationResponse['executionLease']): DshToolPolicyState {
  return {
    phase: phaseForState(state),
    runId: record.runId,
    workspace: record.workspace,
    orchestrationId: record.orchestrationId,
    ...(record.prepared.context?.deliveryId === null || record.prepared.context?.deliveryId === undefined ? {} : { deliveryId: record.prepared.context.deliveryId }),
    revision: state.contractRevision ?? 1,
    routeEpoch: lease?.routeEpoch ?? state.routeEpoch ?? 0,
    ...(state.advisoryPhaseState.state === 'aggregated' ? { advisoryRoundDigest: state.advisoryPhaseState.inputDigest } : {}),
    ...(lease === undefined ? {} : { leaseToken: lease.leaseToken, workUnitId: lease.workUnitId, currentWorkUnitId: lease.workUnitId }),
    dshSessionId: sessionId,
    nativeTurn: record.turn,
    ...(state.nextAction === undefined ? {} : { nextAction: state.nextAction }),
  }
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
  const resumedLeases = new Map<string, NonNullable<EnnoOperationResponse['executionLease']>>()
  const currentSession = (sessionId: string): TurnRecord | undefined => latestBySession.get(sessionId)
  const applyPolicy = (runId: string, state: DshToolPolicyState): void => {
    states.set(runId, state)
    policy.setState(state)
  }
  const identityKey = (agentId: string, sessionId: string): string => dshPonytailOwnerKey(agentId, sessionId)
  const turnKey = (agentId: string, sessionId: string, turn: number): string => `${identityKey(agentId, sessionId)}\u0000${turn}`
  const record = (event: DshPreStepEvent, result: DshIntakeGateResult, generation: number): void => {
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
    const incomingRevision = result.prepared.ennoOduno.contractRevision ?? 0
    const previousRevision = previous?.prepared.ennoOduno.contractRevision ?? 0
    if (previous !== undefined && (incomingRevision < previousRevision
      || incomingRevision === previousRevision && generation <= previous.prepareGeneration)) return
    const item: TurnRecord = previous ?? {
      agentId: event.agent.id,
      sessionId: event.sessionId,
      runId: run,
      workspace: result.prepared.project.workspace,
      orchestrationId: result.prepared.intake.sessionId,
      repositoryRoot: result.prepared.project.repositoryRoot,
      cwd: event.cwd,
      task: event.task,
      ...(event.profileHints === undefined ? {} : { profileHints: event.profileHints }),
      turn: event.turn,
      prepared: result.prepared,
      catalog: result.catalog,
      prepareGeneration: generation,
      ...(latest?.runId === run && latest.memoryInput !== undefined ? { memoryInput: latest.memoryInput } : {}),
      failed: false,
      closed: false,
    }
    if (event.nativeAgent !== undefined) item.nativeAgent = event.nativeAgent
    if (event.nativeSession !== undefined) item.nativeSession = event.nativeSession
    item.turn = event.turn
    const sameRevision = previous !== undefined && incomingRevision === previousRevision
      && previous.prepared.ennoOduno.applicable === result.prepared.ennoOduno.applicable
    if (sameRevision) {
      // A newer prepare may carry a newer context delivery while Enno has not
      // advanced its revision. Preserve the active lease and other policy
      // state; only replace the authoritative prepared context and delivery.
      item.prepared = { ...item.prepared, context: result.prepared.context, memoryPolicy: result.prepared.memoryPolicy }
    } else {
      item.prepared = result.prepared
    }
    item.prepareGeneration = generation
    item.task = event.task
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
    const existingState = states.get(item.runId)
    if (existingState !== undefined && existingState.revision === incomingRevision
      && existingState.phase === phaseForState(result.prepared.ennoOduno)) {
      // A continued native turn for the same Enno revision must retain the
      // active WorkUnit lease and route epoch. Rebuilding policy from the
      // public prepared projection would silently discard those host-only
      // credentials and make the first report after recovery fail with
      // lease_required. The operation path already advances this state when
      // Enno changes phase; at pre-step only the delivery and authoritative
      // native turn can legitimately be refreshed without a new contract
      // revision.
      const { deliveryId: _previousDeliveryId, ...withoutDeliveryId } = existingState
      const deliveryId = result.prepared.context?.deliveryId
      const next = deliveryId === null || deliveryId === undefined
        ? { ...withoutDeliveryId, nativeTurn: event.turn }
        : { ...withoutDeliveryId, deliveryId, nativeTurn: event.turn }
      applyPolicy(item.runId, next)
    } else {
      const next = policyState(result.prepared.ennoOduno, item, event.sessionId, resumedLeases.get(run))
      resumedLeases.delete(run)
      applyPolicy(item.runId, next)
    }
    if (getSelection(item.runId)?.value.mode === 'normal') {
      const { nextAction: _unused, ...ordinaryState } = states.get(item.runId)!
      const next: DshToolPolicyState = { ...ordinaryState, phase: 'normal' }
      applyPolicy(item.runId, next)
    }
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
    cwd: item.cwd, task: item.task, turn: item.turn,
    ennoState: item.prepared.ennoOduno,
    chat: item.prepared.intake.profile.taskType === 'chat' || !!getSelection(item.runId)?.value.discussion,
    terminal: item.closed || ['complete', 'report_blocker'].includes(item.prepared.ennoOduno.nextAction)
      && item.prepared.ennoOduno.applicable,
    generation: canonicalContentHash({ revision: item.prepared.ennoOduno.contractRevision,
      route: item.prepared.ennoOduno.routeEpoch ?? null, action: item.prepared.ennoOduno.nextAction,
      lease: states.get(item.runId)?.leaseToken ?? null }),
  })
  const sessionIds = (): readonly string[] => [...latestBySession.keys()]
  const releaseRun = (runId: string): void => {
    const items = [...turns.values()].filter(item => item.runId === runId)
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
    if (![...turns.values()].some(item => item.runId === runId)) states.delete(runId)
    resumedLeases.delete(runId)
  }
  const clear = (): void => {
    turns.clear()
    latestBySession.clear()
    states.clear()
    activeModeRequests.clear()
    resumedLeases.clear()
  }
  return {
    record, currentSession, currentForAgentEvent, allTurns, sessionIds, executionBinding,
    policyState: (runId: string): DshToolPolicyState | undefined => states.get(runId),
    applyPolicy,
    stageLease: (runId: string, lease: NonNullable<EnnoOperationResponse['executionLease']>): void => { resumedLeases.set(runId, lease) },
    releaseRun, clear,
  }
}
