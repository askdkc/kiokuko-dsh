import { reviewPlanDecisions } from '../decisions/plan-review.js'
import { executeCheckModel } from '../decisions/check-model.js'
import { reviewEnnoPlan } from '../../enno-oduno/service.js'
import { readExecutionSelection } from '../execution-selection.js'
import { DSH_MODEL_FACING_OPERATIONS, type DshToolHostBinding, type DshToolHost } from '../tools.js'
import { DshAdvisoryRunner, type DshAdvisoryRoundResult } from '../advisory-runner.js'
import { type DshUserQuestionAgent } from '../user-interaction.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { KiokukoError } from '../../errors.js'
import { submitOdunoIdeal, submitEnnoPlan, submitEnnoAdvice, readPendingEnnoAdvice, reportEnnoWork, finishEnno, submitOdunoMeditation, type EnnoOperationResponse } from '../../enno-oduno/service.js'
import { readEnnoSnapshot } from '../../enno-oduno/store.js'
import { curateMemoryCandidates } from '../../memory/curator.js'
import { checkpointDshMemory, type ScopedCheckpointInput } from '../../memory/scoped-memory.js'
import { type EnnoOdunoState } from '../../enno-oduno/types.js'
import { commitExpectedFailure, ennoReceiptOperation, isExpectedTurnFailure, phaseForOperation, prepareTurnIntent, readTurnSeal, appliedTurnOutcome } from '../turn-process.js'
import type { TurnRecord } from './turn-state.js'
import { policyState, type createTurnState } from './turn-state.js'
import type { NativeSkills, NativeTools, NativeSessions, NativeAgents } from './native-events.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DecisionService } from '../decisions/service.js'
import type { DshEnnoDelegation } from '../enno-delegation.js'
import type { DshExecutionSupport, ExecutionBinding } from '../execution-support.js'
import type { DshLlm, DshSessionEventSource } from '../session-memory-finalizer.js'
import type { DshModelCatalog } from '../model-configuration.js'
import type { DshIntakeGate, DshCapabilityReadContext } from '../intake-gate.js'
import type { DshToolPolicy } from '../tool-policy.js'
import type { DshCapabilityCatalog } from '../capability-catalog.js'
import type { DshAdvisoryCall } from '../advisory-runner.js'

function operationInput(
  args: unknown,
  binding: DshToolHostBinding,
  cwd: string,
  operation: string,
  catalog: DshCapabilityCatalog,
): Record<string, unknown> {
  const source = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const identity = { runId: binding.runId, workspace: binding.workspace, orchestrationId: binding.orchestrationId, expectedRevision: binding.revision, idempotencyKey: binding.idempotencyKey }
  const advisory = binding.advisoryRoundDigest === undefined ? {} : { advisoryRoundDigest: binding.advisoryRoundDigest }
  if (operation === 'enno_work_report') return { ...source, ...identity, leaseToken: binding.leaseToken, routeEpoch: binding.routeEpoch, workUnitId: binding.workUnitId }
  if (operation === 'enno_plan_review') return { ...source, ...identity, capabilities: [...catalog.skills, ...catalog.tools] }
  if (operation === 'enno_plan_submit') return { ...source, ...identity, ...advisory, capabilities: [...catalog.skills, ...catalog.tools] }
  if (operation === 'curator_check') return { ...source, cwd, workspace: binding.workspace }
  if (operation === 'memory_checkpoint') return { ...source, cwd, runId: binding.runId, ...(binding.deliveryId === undefined ? {} : { deliveryId: binding.deliveryId }) }
  return { ...source, ...identity, ...advisory }
}

export function operationName(value: string): value is typeof DSH_MODEL_FACING_OPERATIONS[number] {
  return (DSH_MODEL_FACING_OPERATIONS as readonly string[]).includes(value)
}

function isEnnoResponse(value: unknown): value is EnnoOperationResponse {
  return typeof value === 'object' && value !== null && 'ennoOduno' in value && typeof (value as { ennoOduno?: unknown }).ennoOduno === 'object'
}

function isTurnOutcome(value: unknown): value is { readonly kind: 'applied' | 'retry' | 'clarify' | 'waiting_user' | 'infrastructure_error' } {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'applied' || kind === 'retry' || kind === 'clarify' || kind === 'waiting_user' || kind === 'infrastructure_error'
}

function isAppliedEnnoOutcome(value: unknown): value is { readonly kind: 'applied'; readonly value: EnnoOperationResponse } {
  return isTurnOutcome(value) && value.kind === 'applied'
    && 'value' in value && isEnnoResponse((value as { value?: unknown }).value)
}

interface ToolHostDependencies {
  readonly runtime: DshCoreRuntime
  readonly turnState: ReturnType<typeof createTurnState>
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly currentForAgentEvent: (agentId: string, sessionId?: string, turn?: number, nativeSession?: object, nativeAgent?: object) => TurnRecord | undefined
  readonly skills: NativeSkills | undefined
  readonly tools: NativeTools | undefined
  readonly sessions: NativeSessions | undefined
  readonly agents: NativeAgents | undefined
  readonly gate: Pick<DshIntakeGate, 'assertTurnStoppingCatalog'>
  readonly decisions: DecisionService
  readonly delegation: DshEnnoDelegation
  readonly llm: DshLlm | undefined
  readonly modelCatalog: DshModelCatalog | undefined
  readonly executionSupport: DshExecutionSupport
  readonly executionBinding: (item: TurnRecord) => ExecutionBinding
  readonly policy: Pick<DshToolPolicy, 'sealSession'>
  readonly advisory: { readonly verifyReadOnly: (call: DshAdvisoryCall) => boolean | PromiseLike<boolean>; readonly execute: (call: DshAdvisoryCall) => Promise<unknown> } | undefined
  readonly capabilityCatalog: (skills: NativeSkills | undefined, tools: NativeTools | undefined, context: DshCapabilityReadContext) => Promise<DshCapabilityCatalog>
  readonly objectRecord: (value: unknown) => Record<string, unknown> | undefined
}

export function createToolHost({
  runtime, turnState, currentSession, currentForAgentEvent, skills, tools,
  sessions, agents, gate, decisions, delegation, llm, modelCatalog,
  executionSupport, executionBinding, policy, advisory, capabilityCatalog,
  objectRecord,
}: ToolHostDependencies) {
  const advisoryRounds = new Map<string, {
    readonly stateDigest: string
    readonly result: DshAdvisoryRoundResult
  }>()
  const advisoryEvidenceFor = async (item: TurnRecord, state: EnnoOdunoState): Promise<{
    readonly phase: DshAdvisoryRoundResult['phase']
    readonly contributions: DshAdvisoryRoundResult['contributions']
  } | undefined> => {
    const advisoryState = state.advisoryPhaseState
    const contractRevision = state.contractRevision
    if (advisoryState.state !== 'aggregated' || contractRevision === null) return undefined
    let round = advisoryRounds.get(item.runId)
    if (round?.stateDigest !== advisoryState.inputDigest) {
      const restored = await runtime.withDatabase((database) => readPendingEnnoAdvice(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
        expectedRevision: contractRevision,
        advisoryRoundDigest: advisoryState.inputDigest,
      }))
      round = {
        stateDigest: restored.advisoryRound.inputDigest,
        result: {
          phase: restored.advisoryRound.phase,
          inputDigest: restored.advisoryRound.inputDigest,
          contributions: restored.advisoryRound.contributions,
          degraded: restored.advisoryRound.degraded,
        },
      }
      advisoryRounds.set(item.runId, round)
    }
    return { phase: round.result.phase, contributions: round.result.contributions }
  }
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
        routeEpoch: state.routeEpoch,
        ...(state.advisoryRoundDigest === undefined ? {} : { advisoryRoundDigest: state.advisoryRoundDigest }),
        ...(state.leaseToken === undefined ? {} : { leaseToken: state.leaseToken }),
        ...(state.workUnitId === undefined ? {} : { workUnitId: state.workUnitId }),
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
        || binding.revision !== currentState.revision
        || binding.routeEpoch !== currentState.routeEpoch
        || binding.advisoryRoundDigest !== currentState.advisoryRoundDigest) throw new Error('kiokuko-dsh tool binding is not authoritative')
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
      if (operation === 'enno_delegate') {
        if (!run.nativeAgent) throw new KiokukoError('INTEGRITY_ERROR', 'Native parent is unavailable')
        return delegation.execute(run.nativeAgent, args, binding, currentCatalog.tools.map(tool => tool.name), operationSignal)
      }
      const phase = phaseForOperation(operation)
      const receiptOperation = ennoReceiptOperation(operation)
      const inputDigest = canonicalContentHash({
        operation,
        arguments: args,
        revision: binding.revision,
        routeEpoch: binding.routeEpoch,
        workUnitId: binding.workUnitId ?? null,
      })
      if (phase !== undefined && receiptOperation !== undefined) {
        const executionAttempt = operation === 'enno_work_report'
          ? await runtime.withDatabase(database => readEnnoSnapshot(database, {
            runId: run.runId, workspace: run.workspace, orchestrationId: run.orchestrationId,
          }).workUnits.find(unit => unit.workUnit.id === binding.workUnitId)?.attemptCount ?? 0)
          : 0
        await runtime.withDatabase((database) => prepareTurnIntent(database, {
          runId: run.runId,
          dshSessionId: run.sessionId,
          nativeTurn: run.turn,
          phase,
          contractRevision: binding.revision,
          executionAttempt,
          ...(binding.workUnitId === undefined ? {} : { workUnitId: binding.workUnitId }),
          inputDigest,
          operation: receiptOperation,
          idempotencyKey: binding.idempotencyKey,
        }))
      }
      let response: EnnoOperationResponse | unknown
      try {
        response = await runtime.withDatabase(async (database) => {
          const input = operationInput(args, binding, cwd, operation, run.catalog)
          if (operation === 'enno_ideal_submit') return submitOdunoIdeal(database, input)
          if (operation === 'enno_plan_review') {
            const selected = readExecutionSelection(database, run.runId)
            if (selected?.value.mode !== 'enno' || selected.value.status !== 'ready') throw new Error('Plan review has no admitted model configuration')
            const check = selected.value.configuration?.roles.check
            const selectionDigest = canonicalContentHash(selected?.value.configuration ?? null)
            const assertCurrent = async () => {
              operationSignal.throwIfAborted()
              const catalog = await capabilityCatalog(skills, tools, { agent: { id: run.agentId }, ...(run.nativeAgent ? { nativeAgent: run.nativeAgent } : {}), cwd, signal: operationSignal })
              gate.assertTurnStoppingCatalog(run.catalog, catalog)
              if (run.closed || currentSession(run.sessionId) !== run || sessions?.get(run.sessionId) !== run.nativeSession || agents?.get(run.agentId) !== run.nativeAgent || readExecutionSelection(database, run.runId)?.revision !== selected.revision || canonicalContentHash(readExecutionSelection(database, run.runId)?.value.configuration ?? null) !== selectionDigest) throw new Error('Plan review binding changed')
            }
            return reviewEnnoPlan(database, input, (context, reviewSignal) => reviewPlanDecisions({ service: decisions,
              requestId: `run:${run.runId}`, context, signal: reviewSignal,
              check: { identity: { provider: check?.provider ?? null, requestedModel: check?.model ?? null, source: 'roles.check' },
                verifyReadOnly: async () => {
                  if (!check || !llm) return false
                  if (modelCatalog?.resolveCallConfig) {
                    const resolved = await modelCatalog.resolveCallConfig(check)
                    if (canonicalContentHash(resolved) !== canonicalContentHash(check)) throw new Error('Configured check model binding changed')
                  }
                  return true
                },
                execute: call => { if (!check || !llm) throw new Error('Configured check model is unavailable'); return executeCheckModel(llm, check, call) },
              } }), operationSignal, assertCurrent)
          }
          if (operation === 'enno_plan_submit') return submitEnnoPlan(database, input)
          if (operation === 'enno_work_report') return reportEnnoWork(database, input)
          if (operation === 'enno_finish') return finishEnno(database, input)
          if (operation === 'enno_meditation_submit') {
            // The native DSH turn still has a tool result, final assistant
            // message, step end, and turn end to commit. Keep the ledger open
            // until the idle lifecycle flushes that ordered suffix.
            return submitOdunoMeditation(database, input, { deferLedgerTerminalization: true })
          }
          if (operation === 'curator_check') return curateMemoryCandidates(database, input)
          return checkpointDshMemory(database, input as unknown as ScopedCheckpointInput, signal)
        }) as EnnoOperationResponse | unknown
      } catch (error) {
        if (phase === undefined || receiptOperation === undefined || !isExpectedTurnFailure(error)) throw error
        response = await runtime.withDatabase((database) => commitExpectedFailure(database, {
          runId: run.runId,
          dshSessionId: run.sessionId,
          nativeTurn: run.turn,
          phase,
          contractRevision: binding.revision,
          ...(binding.workUnitId === undefined ? {} : { workUnitId: binding.workUnitId }),
          inputDigest,
          operation: receiptOperation,
          idempotencyKey: binding.idempotencyKey,
          error,
        }))
      }
      const ennoResponse = isAppliedEnnoOutcome(response) ? response.value : response
      if (run !== undefined && isEnnoResponse(ennoResponse)) {
        if (binding.advisoryRoundDigest !== undefined) advisoryRounds.delete(run.runId)
        run.prepared = { ...run.prepared, ennoOduno: ennoResponse.ennoOduno }
        const next = policyState(ennoResponse.ennoOduno, run, run.sessionId, ennoResponse.executionLease)
        turnState.applyPolicy(run.runId, next)
        await executionSupport.refresh(executionBinding(run), false)
        if (operation === 'enno_ideal_submit' || operation === 'enno_plan_submit') {
          await executionSupport.proposals(run.sessionId, objectRecord(args)?.executionHints,
            ennoResponse.ennoOduno.contractRevision ?? binding.revision)
        }
      }
      if (phase !== undefined && isEnnoResponse(ennoResponse) && !isTurnOutcome(response)) {
        response = appliedTurnOutcome(ennoResponse, {
          schemaVersion: 1,
          runId: run.runId,
          phase,
          revision: binding.revision,
          nextAction: ennoResponse.ennoOduno.nextAction,
        })
      }
      if (phase !== undefined) {
        const seal = await runtime.withDatabase((database) => readTurnSeal(database, run.sessionId, run.turn))
        if (seal === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Committed DSH phase has no turn seal')
        policy.sealSession(run.sessionId, run.turn, seal.receiptId)
      }
      return response
    },
  }

  const advisoryRunner = new DshAdvisoryRunner({
    verifyReadOnly: advisory?.verifyReadOnly ?? (() => false),
    execute: advisory?.execute ?? (async () => { throw new Error('kiokuko-dsh advisory host is unavailable') }),
  })
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
  const submitAdvisory = async (result: DshAdvisoryRoundResult, input: { readonly event: { readonly agent: { readonly id: string; readonly sessionId?: string; readonly nativeSession?: object; readonly nativeAgent?: DshUserQuestionAgent }; readonly turn: number; readonly signal: AbortSignal }; readonly state: EnnoOdunoState }): Promise<EnnoOdunoState> => {
    // Advisory execution is asynchronous. Revalidate the live Agent/catalog
    // after it settles and immediately before committing its contribution.
    const item = await assertTurnBoundary(input.event)
    const directive = input.state.directive?.advisoryRound
    if (directive === undefined || input.state.contractRevision === null) throw new Error('kiokuko-dsh advisory directive is unavailable')
    const response = await runtime.withDatabase((database) => {
      const snapshot = readEnnoSnapshot(database, { runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId })
      if (snapshot.revision !== input.state.contractRevision || snapshot.mutationRevision < 0) throw new Error('kiokuko-dsh advisory state changed')
      return submitEnnoAdvice(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
        expectedRevision: snapshot.revision,
        mutationRevision: snapshot.mutationRevision,
        idempotencyKey: `dsh-advice:${canonicalContentHash({ runId: item.runId, revision: snapshot.revision, mutationRevision: snapshot.mutationRevision, phase: result.phase, inputDigest: result.inputDigest })}`,
        phase: result.phase,
        allowlistedContext: directive.context,
        contributions: result.contributions,
      })
    })
    item.prepared = { ...item.prepared, ennoOduno: response.ennoOduno }
    if (response.ennoOduno.advisoryPhaseState.state !== 'aggregated') {
      throw new Error('kiokuko-dsh advisory submission did not produce an aggregated round')
    }
    advisoryRounds.set(item.runId, {
      stateDigest: response.ennoOduno.advisoryPhaseState.inputDigest,
      result,
    })
    const next = policyState(response.ennoOduno, item, item.sessionId)
    turnState.applyPolicy(item.runId, next)
    return response.ennoOduno
  }

  return {
    toolHost, advisoryRunner, advisoryEvidenceFor, assertTurnBoundary, submitAdvisory,
    clearRun: (runId: string): void => { advisoryRounds.delete(runId) },
    clear: (): void => { advisoryRounds.clear() },
  }
}
