import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  KIOKUKO_DSH_HOST_SERVICE,
  type DshCompositionHost,
  type DshNativePreStepPayload,
} from './composition.js'
import { DshRuntime } from './runtime.js'
import { DshIntakeGate, type DshCapabilityReadContext, type DshIntakeGateResult, type DshPreStepDecision, type DshPreStepEvent } from './intake-gate.js'
import { DshToolPolicy, type DshToolPolicyState } from './tool-policy.js'
import {
  DSH_MODEL_FACING_OPERATIONS,
  type DshToolExecution,
  type DshToolHostBinding,
  type DshNativeToolExecution,
  type DshToolHost,
} from './tools.js'
import { DshSessionBridge, DshRunLifecycle } from './session-bridge.js'
import { DshEnnoController } from './enno-controller.js'
import { DshAdvisoryRunner, type DshAdvisoryCall, type DshAdvisoryRoundResult } from './advisory-runner.js'
import { DshPonytailModes } from './commands.js'
import { createDshIntakeAnswerer, createDshConfirmationAnswerer, type DshUserQuestions } from './user-interaction.js'
import { createDshCapabilityCatalog, type DshCapabilityCatalog } from './capability-catalog.js'
import { STANDARD_SKILL_MANIFESTS } from '../setup/standard-skills.js'
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js'
import { injectDshContext, selectDshDirectiveSources } from './context-injection.js'
import { projectDshDirective } from './directive-projection.js'
import { submitOdunoIdeal, submitEnnoPlan, submitEnnoAdvice, reportEnnoWork, finishEnno, submitOdunoMeditation, answerEnno, prepareEnnoVerification, stateForSnapshot, type EnnoOperationResponse } from '../enno-oduno/service.js'
import { readEnnoSnapshot, terminalizeLedgerRunInTransaction } from '../enno-oduno/store.js'
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js'
import { curateMemoryCandidates } from '../memory/curator.js'
import { checkpointScopedMemoryWithProvenance, type ScopedCheckpointInput } from '../memory/scoped-memory.js'
import { LedgerStore } from '../ledger/store.js'
import type { EnnoNextAction, EnnoOdunoState } from '../enno-oduno/types.js'

interface NativeSkills {
  registerProvider(create: (control: { readonly signal: AbortSignal }) => unknown): () => void
  snapshot?(options?: unknown): Promise<{
    readonly skills: readonly { name: string; description?: string; invocation?: { modelInvocable?: boolean } }[]
    readonly complete: boolean
  }>
}

interface NativeTools {
  register(definition: unknown): () => void
  guard(guard: (execution: unknown) => string | undefined): () => void
  schemas?(scope?: unknown): readonly { name: string; description?: string }[] | PromiseLike<readonly { name: string; description?: string }[]>
}

interface NativeCommands { register(...args: any[]): () => void }
interface NativeSessions { get(id: string): { id: string; header?: { cwd?: string } } | undefined }
interface NativeAgents { get(id: string): { id: string; inject?: (message: unknown) => void } | undefined }

export interface DshAdvisoryHost {
  readonly verifyReadOnly: (call: DshAdvisoryCall) => boolean | PromiseLike<boolean>
  readonly execute: (call: DshAdvisoryCall) => Promise<unknown>
}

interface AdapterContext extends Context {
  get(name: string, strict?: boolean): unknown
}

export interface DshHostAdapterOptions {
  readonly databasePath?: string
  readonly migrationsDirectory?: string
  readonly repositoryRoot?: string
  readonly now?: () => string
  /** Optional host-owned isolated, read-only advisory execution surface. */
  readonly advisory?: DshAdvisoryHost
}

export interface DshHostAdapter {
  readonly host: DshCompositionHost
  readonly dispose: () => Promise<void>
}

interface TurnRecord {
  readonly agentId: string
  readonly sessionId: string
  readonly runId: string
  readonly workspace: string
  readonly orchestrationId: string
  readonly repositoryRoot: string
  readonly cwd: string
  nativeAgent?: object
  nativeSession?: object
  task: string
  turn: number
  prepared: DshIntakeGateResult['prepared']
  contextInjectionKey?: string
  failed: boolean
  closed: boolean
}

function textFromMessages(messages: readonly unknown[]): string {
  const texts: string[] = []
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (message.role !== undefined && message.role !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
      const text = (block as Record<string, unknown>).text
      if (typeof text === 'string' && text.length > 0) texts.push(text)
    }
  }
  const task = texts.join('\n').trim()
  if (task.length === 0) throw new Error('dsh pre-step did not contain a user task')
  return task
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

function policyState(state: EnnoOdunoState, record: TurnRecord, sessionId: string, lease?: EnnoOperationResponse['executionLease']): DshToolPolicyState {
  return {
    phase: phaseForState(state),
    runId: record.runId,
    workspace: record.workspace,
    orchestrationId: record.orchestrationId,
    ...(record.prepared.context?.deliveryId === null || record.prepared.context?.deliveryId === undefined ? {} : { deliveryId: record.prepared.context.deliveryId }),
    revision: state.contractRevision ?? 1,
    routeEpoch: lease?.routeEpoch ?? state.routeEpoch ?? 0,
    ...(lease === undefined ? {} : { leaseToken: lease.leaseToken, workUnitId: lease.workUnitId, currentWorkUnitId: lease.workUnitId }),
    dshSessionId: sessionId,
    ...(state.nextAction === undefined ? {} : { nextAction: state.nextAction }),
  }
}

async function capabilityCatalog(
  skills: NativeSkills | undefined,
  tools: NativeTools | undefined,
  context: DshCapabilityReadContext,
): Promise<DshCapabilityCatalog> {
  if (skills?.snapshot === undefined || tools?.schemas === undefined) {
    throw new Error('kiokuko-dsh requires native Skill and tool snapshots')
  }
  const scope = context.nativeAgent ?? context.agent
  const skillSnapshot = await skills.snapshot({ scope, cwd: context.cwd, signal: context.signal })
  if (skillSnapshot.complete !== true) throw new Error('kiokuko-dsh native Skill snapshot is incomplete')
  // A Skill visible to a user but not model-invocable is not a capability
  // that can satisfy the model's required route. Treat it as unavailable by
  // excluding it before the mandatory-catalog check below.
  const nativeSkills = skillSnapshot.skills.filter((skill) => skill.invocation?.modelInvocable !== false)
  const nativeTools = await tools.schemas(scope)
  const mandatoryOrder = new Map<string, number>()
  STANDARD_SKILL_MANIFESTS.forEach((manifest, index) => mandatoryOrder.set(manifest.name, index))
  const skillDescriptors = nativeSkills
    .map((skill) => ({ kind: 'skill' as const, name: skill.name, ...(skill.description === undefined ? {} : { description: skill.description }) }))
    .sort((left, right) => {
      const leftMandatory = mandatoryOrder.has(left.name)
      const rightMandatory = mandatoryOrder.has(right.name)
      if (leftMandatory !== rightMandatory) return leftMandatory ? -1 : 1
      if (leftMandatory && rightMandatory) return mandatoryOrder.get(left.name)! - mandatoryOrder.get(right.name)!
      return compareCanonicalStrings(left.name, right.name)
    })
  const toolDescriptors = nativeTools
    .map((tool) => ({ kind: 'mcp_tool' as const, name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }) }))
    .sort((left, right) => compareCanonicalStrings(left.name, right.name))
  return createDshCapabilityCatalog({ skills: skillDescriptors, tools: toolDescriptors })
}

function operationInput(args: unknown, binding: DshToolHostBinding, cwd: string, operation: string): Record<string, unknown> {
  const source = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const identity = { runId: binding.runId, workspace: binding.workspace, orchestrationId: binding.orchestrationId, expectedRevision: binding.revision, idempotencyKey: binding.idempotencyKey }
  if (operation === 'enno_work_report') return { ...source, ...identity, leaseToken: binding.leaseToken, routeEpoch: binding.routeEpoch, workUnitId: binding.workUnitId }
  if (operation === 'curator_check') return { ...source, cwd, workspace: binding.workspace }
  if (operation === 'memory_checkpoint') return { ...source, cwd, runId: binding.runId, ...(binding.deliveryId === undefined ? {} : { deliveryId: binding.deliveryId }) }
  return { ...source, ...identity }
}

function operationName(value: string): value is typeof DSH_MODEL_FACING_OPERATIONS[number] {
  return (DSH_MODEL_FACING_OPERATIONS as readonly string[]).includes(value)
}

export function createDshHostAdapter(ctx: Context, options: DshHostAdapterOptions = {}): DshHostAdapter {
  const native = ctx as unknown as AdapterContext
  const skills = native.get('skills', false) as NativeSkills | undefined
  const systemPrompt = native.get('systemPrompt', false) as DshCompositionHost['systemPrompt'] | undefined
  const tools = native.get('tools', false) as NativeTools | undefined
  const commands = native.get('commands', false) as NativeCommands | undefined
  const userQuestions = native.get('userQuestions', false) as DshUserQuestions | undefined
  const sessions = native.get('sessions', false) as NativeSessions | undefined
  const agents = native.get('agents', false) as NativeAgents | undefined
  const advisory = options.advisory ?? native.get('dshAdvisory', false) as DshAdvisoryHost | undefined
  const root = realpathSync(options.repositoryRoot ?? process.cwd())
  const runtime = new DshRuntime({
    repositoryRoot: root,
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    migrationsDirectory: options.migrationsDirectory ?? fileURLToPath(new URL('../../migrations/', import.meta.url)),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 30_000, batchSize: 16 },
    autoRegisterRepository: true,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const turns = new Map<string, TurnRecord>()
  const latestBySession = new Map<string, TurnRecord>()
  const states = new Map<string, DshToolPolicyState>()
  const activeModeRequests = new Map<string, string>()
  const policy = new DshToolPolicy({ phase: 'intake', runId: 'pending', workspace: 'pending', orchestrationId: 'pending', revision: 1, routeEpoch: 0 })
  const bridge = new DshSessionBridge({ runtime })
  const modes = new DshPonytailModes()
  const confirmation = userQuestions === undefined ? undefined : createDshConfirmationAnswerer(userQuestions)

  const identityKey = (agentId: string, sessionId: string): string => `${agentId}\u0000${sessionId}`
  const turnKey = (agentId: string, sessionId: string, turn: number): string => `${identityKey(agentId, sessionId)}\u0000${turn}`
  const record = (event: DshPreStepEvent, result: DshIntakeGateResult): void => {
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
    if (previous !== undefined && incomingRevision <= (previous.prepared.ennoOduno.contractRevision ?? 0)) return
    const item: TurnRecord = previous ?? {
      agentId: event.agent.id,
      sessionId: event.sessionId,
      runId: run,
      workspace: result.prepared.project.workspace,
      orchestrationId: result.prepared.intake.sessionId,
      repositoryRoot: result.prepared.project.repositoryRoot,
      cwd: event.cwd,
      task: event.task,
      turn: event.turn,
      prepared: result.prepared,
      failed: false,
      closed: false,
    }
    if (event.nativeAgent !== undefined) item.nativeAgent = event.nativeAgent
    if (event.nativeSession !== undefined) item.nativeSession = event.nativeSession
    item.turn = event.turn
    item.prepared = result.prepared
    item.task = event.task
    turns.set(key, item)
    latestBySession.set(event.sessionId, item)
    const modeRequest = `dsh:${event.agent.id}:${event.sessionId}:${event.turn}`
    const modeKey = identityKey(event.agent.id, event.sessionId)
    const activeModeRequest = activeModeRequests.get(modeKey)
    if (activeModeRequest !== modeRequest) {
      if (activeModeRequest !== undefined) modes.end(activeModeRequest)
      modes.begin(modeRequest)
      activeModeRequests.set(modeKey, modeRequest)
    }
    const next = policyState(result.prepared.ennoOduno, item, event.sessionId)
    states.set(item.runId, next)
    policy.setState(next)
  }

  class CapturingGate extends DshIntakeGate {
    override async prepare(event: DshPreStepEvent): Promise<DshIntakeGateResult> {
      await runtime.withDatabase((database) => resolveProjectWorkspaceReadOnly(database, event.cwd))
      const prepared = await super.prepare(event)
      if (prepared.admitted) record(event, prepared)
      return prepared
    }
    override async preStep(event: DshPreStepEvent, next: () => Promise<DshPreStepDecision>): Promise<DshPreStepDecision> {
      const result = await this.prepare(event)
      if (!result.admitted) return { kind: 'reject' }
      try {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        const messages = await contextMessages(event, result)
        return { ...decision, messages: [...decision.messages, ...messages] }
      } catch {
        return { kind: 'reject' }
      }
    }
  }

  const gate = new CapturingGate(
    runtime,
    userQuestions === undefined ? undefined : createDshIntakeAnswerer(userQuestions),
    (context) => capabilityCatalog(skills, tools, context),
  )
  const currentSession = (sessionId: string): TurnRecord | undefined => latestBySession.get(sessionId)
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
  const contextInjectionKey = (item: TurnRecord, turn: number, state: EnnoOdunoState, selection: { readonly routeSkillNames: readonly string[]; readonly expertRefs: readonly unknown[] }): string => canonicalContentHash({
    sessionId: item.sessionId,
    turn,
    routeSkillNames: selection.routeSkillNames,
    expertRefs: selection.expertRefs,
    contractRevision: state.contractRevision,
    nextAction: state.nextAction,
    directiveDigest: state.directive === null ? null : canonicalContentHash(state.directive),
  })
  const mapPreStep = async (payload: DshNativePreStepPayload): Promise<DshPreStepEvent> => {
    const nativeSession = payload.agent.session
    const registered = nativeSession === undefined && payload.agent.sessionId === undefined
      ? sessions?.get(payload.agent.id)
      : undefined
    const sessionId = nativeSession?.id ?? payload.agent.sessionId ?? registered?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('kiokuko-dsh native agent session identity is unavailable')
    const registeredSession = nativeSession === undefined ? sessions?.get(sessionId) : undefined
    const boundSession = nativeSession ?? registeredSession ?? registered
    if (boundSession !== undefined && boundSession.id !== sessionId) throw new Error('kiokuko-dsh native session identity is inconsistent')
    const cwd = boundSession?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('kiokuko-dsh native session cwd is unavailable')
    const catalog = await capabilityCatalog(skills, tools, {
      agent: { id: payload.agent.id },
      nativeAgent: payload.agent as object,
      cwd,
      signal: payload.signal,
    })
    const bound = currentForAgentEvent(payload.agent.id, sessionId, payload.turn, boundSession as object | undefined, payload.agent as object)
    // DSH supplies only the messages claimed for this particular step. After
    // the first step that batch may contain steering/injected context rather
    // than the original user task, so the established logical-turn record is
    // the authoritative task projection.
    const task = bound === undefined ? textFromMessages(payload.messages) : bound.task
    return {
      agent: { id: payload.agent.id },
      nativeAgent: payload.agent as object,
      sessionId,
      ...(boundSession === undefined ? {} : { nativeSession: boundSession as object }),
      turn: payload.turn,
      step: payload.step,
      task,
      cwd,
      capabilities: catalog,
      signal: payload.signal,
    }
  }
  const contextMessages = async (event: DshPreStepEvent, result: DshIntakeGateResult): Promise<readonly unknown[]> => {
    const item = currentForAgentEvent(event.agent.id, event.sessionId, event.turn, event.nativeSession, event.nativeAgent)
    if (item === undefined || item.sessionId !== event.sessionId) throw new Error('kiokuko-dsh turn identity is not bound')
    if (event.nativeSession !== undefined && item.nativeSession !== event.nativeSession) throw new Error('kiokuko-dsh native session identity is not bound')
    const directive = projectDshDirective(result.prepared.ennoOduno)
    const selection = directive === null ? { routeSkillNames: [], expertRefs: [] } : selectDshDirectiveSources(directive)
    const contextKey = contextInjectionKey(item, event.turn, result.prepared.ennoOduno, selection)
    if (item.contextInjectionKey === contextKey) return []
    const messages = await injectDshContext({
      prepared: result.prepared,
      task: event.task,
      routeSkillNames: selection.routeSkillNames,
      expertRefs: selection.expertRefs,
      ...(directive === null ? {} : { directive }),
      runtime,
    })
    const nativeMessages = messages.map((message) => ({
        id: randomUUID(),
        role: message.role,
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' },
      }))
    item.contextInjectionKey = contextKey
    return Object.freeze(nativeMessages)
  }

  const toolHost: DshToolHost = {
    bind: (execution) => {
      const sessionId = execution.agent?.dshSessionId
      if (sessionId === undefined) throw new Error('kiokuko-dsh tool session identity is unavailable')
      const item = currentSession(sessionId)
      if (item === undefined || item.closed) throw new Error('kiokuko-dsh tool session is not bound to an active run')
      if (item.nativeSession !== execution.agent?.nativeSession) throw new Error('kiokuko-dsh tool native session identity is stale')
      if (execution.agent?.turn !== undefined && execution.agent.turn !== item.turn) throw new Error('kiokuko-dsh tool turn identity is stale')
      const state = states.get(item.runId)
      if (state === undefined || state.dshSessionId !== sessionId) throw new Error('kiokuko-dsh tool state is unavailable')
      return {
        dshSessionId: sessionId,
        runId: state.runId,
        workspace: state.workspace,
        orchestrationId: state.orchestrationId,
        ...(state.deliveryId === undefined ? {} : { deliveryId: state.deliveryId }),
        revision: state.revision,
        routeEpoch: state.routeEpoch,
        ...(state.leaseToken === undefined ? {} : { leaseToken: state.leaseToken }),
        ...(state.workUnitId === undefined ? {} : { workUnitId: state.workUnitId }),
      }
    },
    execute: async (operation, args, binding, signal) => {
      if (!operationName(operation)) throw new Error('Unsupported Kiokuko dsh operation')
      const run = [...turns.values()]
        .filter((item) => item.runId === binding.runId && item.sessionId === binding.dshSessionId && !item.closed)
        .sort((left, right) => right.turn - left.turn)[0]
      const currentState = run === undefined ? undefined : states.get(run.runId)
      if (binding.dshSessionId === undefined || run === undefined || run.closed
        || binding.workspace !== run.workspace
        || binding.orchestrationId !== run.orchestrationId
        || currentState === undefined
        || binding.revision !== currentState.revision
        || binding.routeEpoch !== currentState.routeEpoch) throw new Error('kiokuko-dsh tool binding is not authoritative')
      if (signal?.aborted) throw signal.reason
      const cwd = run.cwd
      const response = await runtime.withDatabase(async (database) => {
        const input = operationInput(args, binding, cwd, operation)
        if (operation === 'enno_ideal_submit') return submitOdunoIdeal(database, input)
        if (operation === 'enno_plan_submit') return submitEnnoPlan(database, input)
        if (operation === 'enno_work_report') return reportEnnoWork(database, input)
        if (operation === 'enno_finish') return finishEnno(database, input)
        if (operation === 'enno_meditation_submit') return submitOdunoMeditation(database, input)
        if (operation === 'curator_check') return curateMemoryCandidates(database, input)
        return checkpointScopedMemoryWithProvenance(database, input as unknown as ScopedCheckpointInput, { clientKind: 'dsh', actor: 'dsh', reference: 'dsh' }, signal)
      }) as EnnoOperationResponse | unknown
      if (run !== undefined && isEnnoResponse(response)) {
        run.prepared = { ...run.prepared, ennoOduno: response.ennoOduno }
        const next = policyState(response.ennoOduno, run, run.sessionId, response.executionLease)
        states.set(run.runId, next)
        policy.setState(next)
        if (confirmation !== undefined && response.ennoOduno.nextAction === 'ask_user_confirmation' && response.ennoOduno.directive?.userFacingConfirmation !== undefined) {
          const answer = await confirmation.ask(response.ennoOduno.directive.userFacingConfirmation, signal)
          const confirmed = await runtime.withDatabase((database) => answerEnno(database, {
            runId: binding.runId,
            workspace: binding.workspace,
            orchestrationId: binding.orchestrationId,
            expectedRevision: response.ennoOduno.contractRevision ?? binding.revision,
            idempotencyKey: `dsh-confirm:${canonicalContentHash({ runId: binding.runId, revision: response.ennoOduno.contractRevision, action: answer.action })}`,
            action: answer.action,
            ...(answer.requestedChanges === undefined ? {} : { requestedChanges: answer.requestedChanges }),
          }))
          const confirmedState = policyState(confirmed.ennoOduno, run, run.sessionId, confirmed.executionLease)
          states.set(run.runId, confirmedState)
          policy.setState(confirmedState)
          return confirmed
        }
      }
      return response
    },
  }

  const advisoryRunner = new DshAdvisoryRunner({
    verifyReadOnly: advisory?.verifyReadOnly ?? (() => false),
    execute: advisory?.execute ?? (async () => { throw new Error('kiokuko-dsh advisory host is unavailable') }),
  })
  const submitAdvisory = async (result: DshAdvisoryRoundResult, input: { readonly event: { readonly agent: { readonly id: string; readonly sessionId?: string; readonly nativeSession?: object; readonly nativeAgent?: object }; readonly turn: number }; readonly state: EnnoOdunoState }): Promise<EnnoOdunoState> => {
    const item = currentForAgentEvent(input.event.agent.id, input.event.agent.sessionId, input.event.turn, input.event.agent.nativeSession, input.event.agent.nativeAgent)
    if (item === undefined || item.closed) throw new Error('kiokuko-dsh advisory turn is not bound')
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
    const next = policyState(response.ennoOduno, item, item.sessionId)
    states.set(item.runId, next)
    policy.setState(next)
    return response.ennoOduno
  }

  const ennoController = new DshEnnoController({
    readState: async (event) => {
      const { agent } = event
      const item = currentForAgentEvent(agent.id, agent.sessionId, event.turn, agent.nativeSession, agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh agent is not bound to a run')
      return runtime.withDatabase((database) => stateForRun(database, item))
    },
    injectNextStepContext: async ({ event, selection, state }) => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh turn identity is not bound')
      const exactNativeAgent = event.agent.nativeAgent as { readonly inject?: (message: unknown) => void } | undefined
      const agent = exactNativeAgent === undefined
        ? agents?.get(event.agent.id)
        : exactNativeAgent
      if (agent?.inject === undefined) throw new Error('kiokuko-dsh native agent injection is unavailable')
      if (event.agent.nativeAgent !== undefined && agent !== event.agent.nativeAgent) {
        throw new Error('kiokuko-dsh native agent injection identity is stale')
      }
      const contextKey = contextInjectionKey(item, event.turn, state, selection)
      if (item.contextInjectionKey === contextKey) return
      const projectedDirective = projectDshDirective({ nextAction: state.nextAction, directive: state.directive })
      const messages = await injectDshContext({
        prepared: item.prepared,
        task: item.task,
        routeSkillNames: selection.routeSkillNames,
        expertRefs: selection.expertRefs,
        ...(projectedDirective === null
          ? {}
          : { directive: projectedDirective }),
        runtime,
      })
      for (const message of messages) {
        agent.inject({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message.content }], source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' } })
      }
      item.contextInjectionKey = contextKey
    },
    runFinalVerification: async ({ event }): Promise<EnnoOdunoState> => {
      const item = currentForAgentEvent(event.agent.id, event.agent.sessionId, event.turn, event.agent.nativeSession, event.agent.nativeAgent)
      if (item === undefined) throw new Error('kiokuko-dsh verification turn identity is not bound')
      const state = await runtime.withDatabase((database) => stateForRun(database, item))
      if (state.contractRevision === null) throw new Error('kiokuko-dsh verification revision is unavailable')
      const response = await runtime.withDatabase((database) => prepareEnnoVerification(database, {
        runId: item.runId,
        workspace: item.workspace,
        orchestrationId: item.orchestrationId,
        expectedRevision: state.contractRevision!,
        idempotencyKey: `dsh-verify:${canonicalContentHash({ runId: item.runId, revision: state.contractRevision })}`,
      }))
      item.prepared = { ...item.prepared, ennoOduno: response.ennoOduno }
      const next = policyState(response.ennoOduno, item, item.sessionId)
      states.set(item.runId, next)
      policy.setState(next)
      return response.ennoOduno
    },
    advisoryRunner,
    submitAdvisory,
  })

  const resolveSessionRunId = (session: { id: string }): string | undefined => {
    const item = currentSession(session.id)
    if (item?.nativeSession !== undefined && item.nativeSession !== session) return undefined
    return item?.closed === true ? undefined : item?.runId
  }
  const resolveIdleClose = async (agentId: string, sessionId?: string, nativeSession?: object, nativeAgent?: object): Promise<{ runId: string; status: 'completed' | 'failed' | 'cancelled' } | undefined> => {
    const item = currentForAgentEvent(agentId, sessionId, undefined, nativeSession, nativeAgent)
    if (item === undefined || item.closed) return undefined
    const state = await runtime.withDatabase((database) => stateForRun(database, item))
    if (item.failed) return { runId: item.runId, status: 'failed' }
    if (state.status === 'cancelled') return { runId: item.runId, status: 'cancelled' }
    if (state.status === 'completed' || state.nextAction === 'complete') return { runId: item.runId, status: 'completed' }
    // Idle means the driver has no active work, not that Enno reached a
    // terminal state. Keep active, blocked, and verification states open.
    return undefined
  }
  const closeRun = async (input: { runId: string; status: 'completed' | 'failed' | 'cancelled' }): Promise<void> => {
    await lifecycleClose(runtime)(input)
    const items = [...turns.values()].filter((candidate) => candidate.runId === input.runId)
    for (const item of items) {
      item.closed = true
      gate.clearTurn(item.sessionId, item.turn)
      const modeKey = identityKey(item.agentId, item.sessionId)
      const modeRequest = `dsh:${item.agentId}:${item.sessionId}:${item.turn}`
      if (activeModeRequests.get(modeKey) === modeRequest) {
        modes.end(modeRequest)
        activeModeRequests.delete(modeKey)
      }
      turns.delete(turnKey(item.agentId, item.sessionId, item.turn))
      if (latestBySession.get(item.sessionId) === item) latestBySession.delete(item.sessionId)
    }
    for (const sessionId of new Set(items.map((item) => item.sessionId))) {
      if (![...turns.values()].some((candidate) => candidate.sessionId === sessionId && !candidate.closed)) policy.clearSession(sessionId)
    }
    if (![...turns.values()].some((candidate) => candidate.runId === input.runId)) states.delete(input.runId)
  }
  const errorDisposer = (ctx as any).on('agent/error', (event: { agent: { id: string; session?: { id: string }; sessionId?: string } }) => {
    const item = currentForAgentEvent(event.agent.id, event.agent.session?.id ?? event.agent.sessionId, undefined, event.agent.session, event.agent)
    if (item !== undefined) item.failed = true
  })
  const bridgeLifecycle = new DshRunLifecycle({ bridge, closeRun })

  const host: DshCompositionHost = {
    ...(skills === undefined ? {} : { skills: skills as any }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    runtime,
    runtimeOwner: 'host',
    ...(userQuestions === undefined ? {} : { userQuestions }),
    ...(commands === undefined ? {} : { commands: commands as any }),
    ponytailModes: modes,
    ...(tools === undefined ? {} : {
      tools: { register: tools.register.bind(tools) as any, guard: tools.guard.bind(tools) as any },
      toolHost,
      toolPolicy: policy,
    }),
    ...(tools === undefined ? {} : { intakeGate: gate, mapPreStep }),
    bridge,
    bridgeOwner: 'host',
    resolveSessionRunId,
    ennoController,
    lifecycle: bridgeLifecycle,
    resolveIdleClose,
  }

  return {
    host,
    dispose: async () => {
      const failures: unknown[] = []
      try { errorDisposer?.() } catch (error) { failures.push(error) }
      try { policy.dispose() } catch (error) { failures.push(error) }
      try { modes.dispose() } catch (error) { failures.push(error) }
      try { ennoController.dispose() } catch (error) { failures.push(error) }
      try { await bridgeLifecycle.dispose() } catch (error) { failures.push(error) }
      // Observer failures are deliberately fail-closed, but must not prevent
      // the database/runtime from being closed and releasing its resources.
      try { await runtime.close() } catch (error) { failures.push(error) }
      turns.clear()
      latestBySession.clear()
      states.clear()
      activeModeRequests.clear()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'kiokuko-dsh adapter disposal failed')
    },
  }
}

function lifecycleClose(runtime: DshRuntime) {
  return ({ runId, status }: { runId: string; status: 'completed' | 'failed' | 'cancelled' }) => runtime.withDatabase((database) => {
    const row = new LedgerStore(database).readRun(runId)
    if (row !== undefined && (row.status === 'intake' || row.status === 'active')) terminalizeLedgerRunInTransaction(database, runId, status)
  })
}

function isEnnoResponse(value: unknown): value is EnnoOperationResponse {
  return typeof value === 'object' && value !== null && 'ennoOduno' in value && typeof (value as { ennoOduno?: unknown }).ennoOduno === 'object'
}

function stateForRun(database: any, item: TurnRecord): EnnoOdunoState {
  return stateForSnapshot(readEnnoSnapshot(database, { runId: item.runId, workspace: item.workspace, orchestrationId: item.orchestrationId }))
}

export { KIOKUKO_DSH_HOST_SERVICE }
