import type { DshAnswerContext } from './answer-context.js'
import { executionClarification } from './intake-clarification.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import { randomUUID } from 'node:crypto'
import { TASK_TYPES, type TaskType } from '../akinator/types.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'
import type { AkinatorTaskClassification } from './decisions/akinator-classification.js'
import {deriveProfile} from '../akinator/domain.js'

export type { IntakeMode } from './intake-mode.js'
export const TASK_PREPARE_TOOL = 'prepare_requested_work'
export const ON_DEMAND_GUIDANCE = 'The original user request may be answered now without selecting a task category. No execution task has been prepared yet. Preserve all requested actions, negations, alternatives and target uncertainty. Native read, glob, grep, web_search and web_fetch demands automatically prepare the original request with research advice when no non-chat action type is resolved. Use these tools directly to gather requested evidence; do not call prepare_requested_work merely to read a plan or inspect files. An explicit development request is prepared automatically on its first tool demand. prepare_requested_work(taskType) remains an advisory control operation. Do not silently replace a requested action with a text-only answer or claim work was done. Ask a concrete clarification in ordinary conversation when the actual target or requested action is unclear. Installed Skill reads need no preparation and do not activate execution. Do not prepare work merely to load a skill. Owned development tools use their own authorization; Plan, goal, cancellation and execution ownership still apply. If only run_code is exposed and the request is ambiguous, prepare with exactly return await tools.prepare_requested_work({"taskType":"research"}) using the appropriate advisory type; the host intercepts that preparation-only carrier without evaluating code. For an explicit development request, its first run_code demand prepares automatically before evaluating the program.'
const ACTION_TYPES: readonly TaskType[] = TASK_TYPES.filter(type => type !== 'chat')

export interface DemandAgent { readonly ctx?: unknown; readonly id: string; readonly session?: { readonly id: string; snapshotEvents?(): readonly DshLogEvent[] } }
export interface DemandInput { readonly agent: DemandAgent; readonly turn: number; readonly step: number; readonly messages: readonly unknown[]; readonly signal: AbortSignal }
interface Execution { readonly agent?: DemandAgent; readonly callId: string; readonly name: string; readonly arguments: unknown; readonly signal: AbortSignal; readonly parent?: unknown }
interface Definition { readonly name: string; readonly execute: (...args: any[]) => unknown }
interface NativeTools {
  register(definition: any): () => void
  get(name: string, agent?: unknown): Definition | undefined
  guard(callback: (execution: Execution) => string | undefined): () => void
}
interface Dependencies {
  readonly answerContext?: DshAnswerContext | undefined
  readonly nativeChild?: (agent: DemandAgent) => boolean
  readonly validate: (input: DemandInput) => Promise<void>
  readonly existing: (input: DemandInput) => Promise<boolean>
  readonly classify: (input: DemandInput, task: string) => Promise<AkinatorTaskClassification>
  readonly prepare: (input: DemandInput, taskType: TaskType) => Promise<boolean>
  readonly ready: (agent: DemandAgent, turn?: number) => boolean
}
interface Turn {
  readonly input: DemandInput
  readonly task: string
  readonly humanContents: ReadonlyMap<string, string>
  status: 'capturing' | 'answer' | 'preparing' | 'prepared' | 'closed' | 'stale'
  intent: AkinatorTaskClassification
  taskType?: TaskType
  existing?: boolean
  capture?: Promise<boolean>
  preparation?: Promise<void>
  readonly preparationCalls: Set<string>
  readonly controller: AbortController
}
function humanMessages(messages: readonly unknown[]): any[] {
  return messages.filter((value: any) => value?.role === 'user' && (!value.source || value.source.kind === 'user'))
}
function humanTask(messages: readonly unknown[]): string {
  return humanMessages(messages).flatMap(message => typeof message.content === 'string' ? [message.content]
    : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n').trim()
}
function humanId(message: any): string { return typeof message.id === 'string' ? message.id : canonicalContentHash(message) }
function eventTurn(event: { data?: unknown } | undefined): number | undefined {
  const data = event?.data as { turn?: unknown } | undefined
  return Number.isSafeInteger(data?.turn) ? data!.turn as number : undefined
}
/** Tool names select advice only; admission and native permissions remain authoritative. */
function automaticPreparationType(intent: AkinatorTaskClassification, name: string): TaskType | undefined {
  if (intent.taskType && intent.taskType !== 'chat') return intent.taskType
  return ['read', 'glob', 'grep', 'web_search', 'web_fetch'].includes(name) ? 'research' : undefined
}
function denied(reason: string): { kind: 'deny'; reason: string } { return { kind: 'deny', reason } }
/** A protocol carrier, not JavaScript evaluation. Only this exact JSON-literal call is recognized. */
export function preparationCarrier(value: unknown): TaskType | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const args = value as Record<string, unknown>
  if (Object.keys(args).sort().join(',') !== 'code,description' || typeof args.description !== 'string' || !args.description.trim()
    || typeof args.code !== 'string' || args.code.length > 256) return undefined
  const code = args.code.trim().replace(/;$/u, '')
  const prefix = 'return await tools.prepare_requested_work('
  if (!code.startsWith(prefix) || !code.endsWith(')')) return undefined
  try {
    const input = JSON.parse(code.slice(prefix.length, -1)) as { taskType?: TaskType }
    if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || !ACTION_TYPES.includes(input.taskType!)
      || code !== prefix + JSON.stringify(input) + ')') return undefined
    return input.taskType
  } catch { return undefined }
}


/** Conversation entry and execution intake are distinct; neither this mode nor a type hint grants native permission. */
export class OnDemandIntake {
  readonly #turns = new Map<string, Turn>()
  readonly #executions = new WeakMap<object, { turn: Turn; execute: Definition['execute']; carrier?: TaskType; skillRead?: boolean; requestPreparation?: boolean }>()
  readonly #disposers: (() => void)[] = []
  readonly #pending = new Set<Promise<unknown>>()
  readonly #lifecycle = new AbortController()
  #tools?: NativeTools
  #startupSkillReader: Definition['execute'] | undefined
  readonly #skillReaders = new WeakMap<DemandAgent, Definition['execute'] | undefined>()
  #stopped = false
  constructor(private readonly host: Dependencies, private readonly options: { onlyWhenDeferred?: boolean } = {}) {}
  private watch<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise)
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise))
    return promise
  }
  private existingTurn(execution: Execution): number | undefined {
    const last = execution.agent?.session?.snapshotEvents?.().filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
    return last?.type === 'turn/start' ? eventTurn(last) : undefined
  }

  /** True means ordinary text may continue; false leaves an existing execution on its original path. */
  async capture(input: DemandInput): Promise<boolean> {
    input.signal.throwIfAborted()
    if (!this.#stopped && this.host.nativeChild?.(input.agent)) return false
    if (this.#stopped || !input.agent.session || !Number.isSafeInteger(input.turn) || input.turn < 1) throw new Error('Invalid on-demand intake identity')
    input = { ...input, signal: AbortSignal.any([input.signal, this.#lifecycle.signal]) }
    const sessionId = input.agent.session!.id
    const previous = this.#turns.get(sessionId)
    if (previous) {
      if (previous.input.agent !== input.agent || previous.input.agent.session !== input.agent.session || input.turn < previous.input.turn) throw new Error('Stale on-demand intake identity')
      if (previous.input.turn === input.turn) {
        if (previous.status === 'closed') throw new Error('On-demand turn is closed')
        const fresh = humanMessages(input.messages).filter(message => previous.humanContents.get(humanId(message)) !== canonicalContentHash(message))
        if (!fresh.length) {
          if (previous.capture && !await previous.capture) return false
          return previous.status !== 'prepared'
        }
        previous.status = 'stale'; previous.controller.abort(new Error('Human instructions changed'))
        // A new native batch can contain only the steering message. Preserve
        // the original request while replacing changed messages by identity.
        const merged = new Map(previous.input.messages.map(message => [humanId(message), message]))
        for (const message of input.messages) merged.set(humanId(message), message)
        input = { ...input, messages: [...merged.values()] }
      }
      if (previous.input.turn !== input.turn && !['closed', 'prepared'].includes(previous.status)) throw new Error('Previous on-demand turn has not ended')
      previous.controller.abort(new Error('A newer native turn superseded this request'))
    }
    // Install the pending state synchronously, before any host or classifier awaits.
    const controller = new AbortController()
    const state: Turn = { input: { ...input, signal: AbortSignal.any([input.signal, controller.signal]), messages: Object.freeze(structuredClone([...input.messages])) }, task: humanTask(input.messages),
      humanContents: new Map(humanMessages(input.messages).map(message => [humanId(message), canonicalContentHash(message)])),
      status: 'capturing', intent: { deferInference: true }, preparationCalls: new Set(), controller }
    this.#turns.set(sessionId, state)
    const promise = (async () => {
      await this.host.validate(input)
      this.assertCurrent(state)
      // Presets and later host plugins register readers after mount. Pin the
      // validated owner's first reader once, including absence; never rebind it.
      if (!this.#skillReaders.has(input.agent)) this.#skillReaders.set(input.agent,
        this.#startupSkillReader ?? this.#tools?.get('skill', input.agent)?.execute)
      if (previous?.input.turn !== input.turn && await this.host.existing(input)) {
        this.assertCurrent(state)
        // Retain the exact resumed request for the public preparation receipt.
        // Existing ownership alone grants nothing: readiness is rechecked at dispatch.
        if (state.task) { state.existing = true; state.status = 'prepared' }
        else this.#turns.delete(sessionId)
        return false
      }
      if (!humanMessages(input.messages).length) throw new Error('Original human input is required before on-demand intake')
      state.intent = await this.host.classify(input, state.task)
      if(!state.intent.taskType&&!state.intent.deferInference&&!executionClarification(state.task)){
        const type=deriveProfile(state.task).taskType
        if(type==='build'||type==='debug'||type==='devops')state.intent={...state.intent,taskType:type}
      }
      this.assertCurrent(state)
      // Eager mode still binds known work before generation. Classifier uncertainty
      // instead reaches ordinary reasoning, with no execution grant or purpose UI.
      if (this.options.onlyWhenDeferred && !state.intent.deferInference) {
        this.#turns.delete(sessionId)
        state.status = 'closed'
        controller.abort(new Error('Known intent continues through eager admission'))
        return false
      }
      await this.host.answerContext?.prepare(state.input, state.task, state.intent.taskType ?? null)
      this.assertCurrent(state)
      state.status = 'answer'
      return true
    })()
    this.watch(promise)
    state.capture = promise
    try { return await promise } catch (error) { if (this.#turns.get(sessionId) === state) state.status = 'stale'; throw error }
    finally { delete state.capture }
  }
  private assertCurrent(state: Turn): void {
    state.input.signal.throwIfAborted()
    if (this.#stopped || this.#turns.get(state.input.agent.session!.id) !== state || ['closed', 'stale'].includes(state.status)) throw new Error('On-demand request changed or closed')
  }
  private bound(execution: Execution): Turn | undefined {
    const agent = execution.agent, state = agent?.session && this.#turns.get(agent.session.id)
    if (!state || state.input.agent !== agent || state.input.agent.session !== agent.session) return undefined
    if (state.existing && this.existingTurn(execution) !== state.input.turn) return undefined
    const starts = agent.session.snapshotEvents?.().filter(event => event.type === 'turn/start')
    const latest = eventTurn(starts?.at(-1))
    if (latest !== undefined && latest !== state.input.turn) return undefined
    return state
  }
  private definition(execution: Execution): Definition | undefined {
    try { return this.#tools?.get(execution.name, execution.agent) } catch { return undefined }
  }
  private async prepare(state: Turn, taskType: TaskType, signal: AbortSignal): Promise<void> {
    this.assertCurrent(state); signal.throwIfAborted()
    const clarification = executionClarification(state.task)
    if (clarification) throw new Error(clarification)
    if (!ACTION_TYPES.includes(taskType)) throw new Error('Answer conversational questions directly; prepare_requested_work is for requested work')
    if (state.status === 'prepared') {
      if (state.taskType !== taskType) throw new Error('Prepared intent cannot be replaced within a turn')
      return
    }
    if (state.preparation) { await state.preparation; this.assertCurrent(state); return }
    state.status = 'preparing'; state.taskType = taskType
    const operation = (async () => {
      // Retain exact original messages. The only caller-supplied input is an advisory task type.
      const admitted = await this.host.prepare({ ...state.input, signal: AbortSignal.any([state.input.signal, signal]) }, taskType)
      this.assertCurrent(state); signal.throwIfAborted()
      if (!admitted || !this.host.ready(state.input.agent, state.input.turn)) throw new Error('Execution preparation did not admit this exact request')
      state.status = 'prepared'
    })()
    this.watch(operation)
    state.preparation = operation
    try { await operation } catch (error) { if (!['closed', 'stale'].includes(state.status)) state.status = 'stale'; throw error }
    finally { delete state.preparation }
  }
  async answerMessages(input: DemandInput, messages: readonly unknown[]): Promise<readonly unknown[]> {
    return this.guidance(await this.host.answerContext?.project(input, messages) ?? messages)
  }
  async beforeRequest(agent: DemandAgent): Promise<void> { if (this.pending(agent)) await this.host.answerContext?.beforeRequest(agent) }
  async fence(agent: DemandAgent, request: { sessionId?: string; purpose?: string; messages?: readonly unknown[] }): Promise<void> {
    if (this.pending(agent)) await this.host.answerContext?.fence(agent, request)
  }
  guidance(messages: readonly unknown[]): readonly unknown[] {
    return [...messages, { id: randomUUID(), role: 'user', content: [{ type: 'text', text: ON_DEMAND_GUIDANCE }],
      source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'snapshot', sections: [{ name: 'on-demand-intake', text: ON_DEMAND_GUIDANCE }] } }]
  }
  snapshot(sessionId: string): { task: string; taskType: TaskType | null; status: string; turn: number } | undefined {
    const state = this.#turns.get(sessionId)
    return state && { task: state.task, taskType: state.taskType ?? state.intent.taskType ?? null, status: state.status, turn: state.input.turn }
  }
  /** A current host-validated control call, never arbitrary code or a name-based exemption. */
  preparationOnly(execution: Execution): boolean {
    const state = this.bound(execution), proof = this.#executions.get(execution)
    if (this.#stopped || execution.signal.aborted || execution.parent !== undefined || !state || state.input.signal.aborted
      || !proof || proof.turn !== state || this.definition(execution)?.execute !== proof.execute
      || state.preparationCalls.has(execution.callId)) return false
    if (proof.carrier) return execution.name === 'run_code' && state.status === 'answer' && preparationCarrier(execution.arguments) === proof.carrier
    return proof.requestPreparation === true && execution.name === TASK_PREPARE_TOOL
      && (state.status === 'answer' || state.existing === true && state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn))
  }
  pending(agent: DemandAgent): boolean {
    const state = agent.session && this.#turns.get(agent.session.id)
    return !!state && state.input.agent === agent && !['prepared', 'closed', 'stale'].includes(state.status)
  }
  /** An admitted host continuation still needs capture to retire the previous turn's receipt. */
  continuing(agent: DemandAgent): boolean { return !this.#stopped && this.host.ready(agent) }
  finish(session: object & { id: string }, turn: number): void {
    const state = this.#turns.get(session.id)
    if (state?.input.agent.session === session && state.input.turn === turn) { state.status = 'closed'; state.controller.abort(new Error('Native turn ended')) }
  }
  mount(context: { on(name: string, listener: (...args: any[]) => any, options?: { prepend: boolean }): () => void }, tools: NativeTools, systemPrompt?: { section(section: any): () => void }): void {
    if (!tools.get || !tools.guard || !tools.register) throw new Error('On-demand intake requires native tool identity and monotonic guards')
    this.#tools = tools
    // Preserve an already installed reader across replacement before capture.
    // When absent, capture binds the validated agent's installed preset reader.
    this.#startupSkillReader = tools.get('skill')?.execute
    if (systemPrompt && !this.options.onlyWhenDeferred) this.#disposers.push(systemPrompt.section({ name: 'kiokuko:on-demand-intake', order: -99999, text: 'On-demand host contract: text answers do not require execution intake. The public prepare_requested_work tool accepts an advisory type only; task_prepare/task_answer remain host-only. ' + ON_DEMAND_GUIDANCE }))
    const definition = { name: TASK_PREPARE_TOOL, modelFacing: true,
      description: 'Prepare the original user request for tool-backed work. Supply only an advisory taskType, never a rewritten task or target. This does not grant native tool permissions. Answer ordinary questions directly; clarify unknown actions or targets first.',
      parameters: { type: 'object', properties: { taskType: { type: 'string', enum: ACTION_TYPES } }, required: ['taskType'], additionalProperties: false },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args: unknown, execution: Execution) => {
        const state = this.bound(execution)
        const value = args as { taskType?: TaskType }
        if (!state || execution.name !== TASK_PREPARE_TOOL || this.definition(execution)?.execute !== definition.execute
          || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !ACTION_TYPES.includes(value.taskType!)) throw new Error('Invalid task preparation request')
        if (state.preparationCalls.has(execution.callId) || !(state.status === 'answer' || state.existing && state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn))) throw new Error('Task preparation was already consumed for this turn')
        state.preparationCalls.add(execution.callId)
        if (state.existing) { this.assertCurrent(state); execution.signal.throwIfAborted() }
        else await this.prepare(state, value.taskType!, execution.signal)
        return { prepared: true, taskType: state.taskType ?? value.taskType, originalTask: state.task, permissions: 'unchanged_native_policy' }
      } }
    this.#disposers.push(tools.register(definition))
    this.#disposers.push(context.on('tools/pre-execute', async (execution: Execution, next: () => Promise<any>) => {
      if (this.#stopped || execution.signal.aborted) return denied('On-demand intake is stopped or cancelled')
      if (execution.agent && this.host.nativeChild?.(execution.agent)) {
        const decision = await next()
        return decision?.kind === 'cancel' ? denied('Native tool policy cancelled this call') : decision
      }
      const actual = this.definition(execution)
      if (!actual || typeof actual.execute !== 'function') return denied('Unknown native tool definition')
      const state = this.bound(execution)
      if (!state) {
        if (execution.agent?.session && this.#turns.has(execution.agent.session.id)) return denied('Stale on-demand native turn')
        const turn = this.existingTurn(execution)
        if (!execution.agent || turn === undefined || !this.host.ready(execution.agent, turn)) return denied('No current native request for tool execution')
        const decision = await next()
        return decision?.kind === 'cancel' ? denied('Native tool policy cancelled this call') : decision
      }
      try {
        this.assertCurrent(state)
        const skillReader = this.#skillReaders.get(state.input.agent)
        const skillRead = execution.name === 'skill' && skillReader !== undefined && actual.execute === skillReader && state.status === 'answer'
        const carrier = execution.name === 'run_code' && state.status !== 'prepared' ? preparationCarrier(execution.arguments) : undefined
        if (execution.name === 'run_code' && state.status !== 'prepared' && !carrier && !automaticPreparationType(state.intent, execution.name)) return denied('Clarify the requested work before code execution.')
        if (carrier) {
          if (state.status !== 'answer' || state.preparationCalls.has(execution.callId)) return denied('Preparation carrier is not current')
        } else if (execution.name === TASK_PREPARE_TOOL) {
          if (actual.execute !== definition.execute || !(state.status === 'answer' || state.existing && state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn)) || state.preparationCalls.has(execution.callId)) return denied('Task preparation is not current')
        } else if (!skillRead) {
          if (state.status !== 'prepared') {
            const type = automaticPreparationType(state.intent, execution.name)
            if (!type) return denied('Before tool-backed work, call prepare_requested_work with its advisory taskType. Clarify unknown actions or targets first; the original request is preserved.')
            await this.prepare(state, type, execution.signal)
          }
          if (!this.host.ready(state.input.agent, state.input.turn)) return denied('Prepared execution is no longer current')
        }
        this.assertCurrent(state)
        if (this.definition(execution)?.execute !== actual.execute) return denied('Native tool definition changed during preparation')
        this.#executions.set(execution, { turn: state, execute: actual.execute, ...(carrier ? { carrier } : {}), ...(skillRead ? { skillRead: true } : {}), ...(execution.name === TASK_PREPARE_TOOL ? { requestPreparation: true } : {}) })
        // Preserve native allow/deny/ask unchanged. Approval is resolved by the native registry AFTER this waterfall.
        const decision = await next()
        // DSH 0.1.5 does not understand cancel and otherwise dispatches it without running guards.
        return decision?.kind === 'cancel' ? denied('Native tool policy cancelled this call') : decision
      } catch (error) { return denied(error instanceof Error ? error.message : 'Execution preparation failed') }
    }, { prepend: true }))
    this.#disposers.push(context.on('tools/execute', async (execution: Execution, next: () => Promise<unknown>) => {
      if (execution.agent && this.host.nativeChild?.(execution.agent)) return next()
      const proof = this.#executions.get(execution)
      if (!proof) return next() // Existing independently admitted runs keep their original path.
      const state = this.bound(execution)
      if (!state || proof.turn !== state || this.definition(execution)?.execute !== proof.execute) throw new Error('On-demand dispatch identity changed')
      this.assertCurrent(state)
      ;(execution as { signal: AbortSignal }).signal = AbortSignal.any([execution.signal, state.input.signal, this.#lifecycle.signal])
      if (!proof.carrier) return next()
      if (state.status !== 'answer' || state.preparationCalls.has(execution.callId) || preparationCarrier(execution.arguments) !== proof.carrier) throw new Error('Preparation carrier was already consumed or changed')
      state.preparationCalls.add(execution.callId)
      await this.prepare(state, proof.carrier, execution.signal)
      const result = { prepared: true, taskType: state.taskType, originalTask: state.task, permissions: 'unchanged_native_policy', programExecuted: false }
      return { isError: false, value: { logs: ['Host intake prepared. No program was evaluated.'], result }, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }, { prepend: true }))
    this.#disposers.push(tools.guard(execution => {
      if (this.#stopped || execution.signal.aborted) return 'On-demand intake is stopped or cancelled'
      if (execution.agent && this.host.nativeChild?.(execution.agent)) return undefined
      const state = this.bound(execution), actual = this.definition(execution)
      if (!actual) return 'Unknown native tool definition'
      if (!state) {
        if (execution.agent?.session && this.#turns.has(execution.agent.session.id)) return 'Stale on-demand native turn'
        const turn = this.existingTurn(execution)
        return execution.agent && turn !== undefined && this.host.ready(execution.agent, turn) ? undefined : 'No current native request for tool execution'
      }
      const proof = this.#executions.get(execution)
      if (!proof || proof.turn !== state || proof.execute !== actual.execute || ['closed', 'stale', 'capturing'].includes(state.status)) return 'Tool execution has no current on-demand preparation'
      if (proof.carrier) return state.status === 'answer' && preparationCarrier(execution.arguments) === proof.carrier ? undefined : 'Preparation carrier is not current'
      if (proof.skillRead) return state.status === 'answer' && actual.execute === this.#skillReaders.get(state.input.agent) ? undefined : 'Conversational Skill read is not current'
      if (execution.name === TASK_PREPARE_TOOL) return actual.execute === definition.execute && (state.status === 'answer' || state.existing && state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn)) ? undefined : 'Task preparation is not current'
      return state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn) ? undefined : 'Execution task is not prepared'
    }))
  }
  answerOwner(session: object & { id: string }): { agent: DemandAgent; workspace: string } | undefined {
    if (this.#stopped) return undefined
    const state = this.#turns.get(session.id), owner = this.host.answerContext?.owner(session)
    return state && state.status !== 'stale' && state.input.agent === owner?.agent ? owner : undefined
  }
  retire(agent: DemandAgent): void {
    this.host.answerContext?.retire(agent)
    const state = agent.session && this.#turns.get(agent.session.id)
    if (state?.input.agent !== agent || state.input.agent.session !== agent.session) return
    state.controller.abort(new Error('Native agent disposed'))
    state.status = 'closed'
    this.#turns.delete(agent.session!.id)
  }
  stop(): void { this.#stopped = true; this.#lifecycle.abort(new Error('On-demand intake stopped')) }
  async drain(): Promise<void> { while (this.#pending.size) await Promise.allSettled([...this.#pending]) }
  async dispose(): Promise<void> { this.stop(); await this.drain(); for (const dispose of this.#disposers.reverse()) dispose() }
}
