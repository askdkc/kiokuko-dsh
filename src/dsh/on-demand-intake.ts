import { ExecutionSelectionPending } from './execution-pending.js'
import type { DshAnswerContext } from './answer-context.js'
import { executionClarification } from './intake-clarification.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TASK_TYPES, type TaskType } from '../akinator/types.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'
import type { AkinatorTaskClassification } from './decisions/akinator-classification.js'
import type { TaskSnapshot } from './task-state.js'
import { createRequestIntentContext, unresolvedRequestIntent, validateMainModelRequestIntent, requestIntentReferenceIds, requestIntentMessageRefs, requestIntentTaskType, RequestIntentSubmissionSchema,
  type RequestIntentContext, type RequestIntentDecision, type RequestIntentInterpretation, type RequestIntentSubmission } from './decisions/request-intent.js'
import { memoryOwnerKind, type MemoryOwnerIdentity, type MemoryOwnerKind } from './memory-owner.js'

export type { IntakeMode } from './intake-mode.js'
export const TASK_PREPARE_TOOL = 'prepare_requested_work'
export const ON_DEMAND_GUIDANCE = 'The original user request may be answered now without selecting a task category. Ordinary native Bash needs no memory, Goal or prepare_requested_work round trip when the host confirms there is no owned task; native permissions and human Stop remain authoritative. Owned or explicitly enrolled work retains its authority checks. Preserve the original utterance, every requested action, negation, quotation, target uncertainty, and current-session references; never replace it with a model rewrite. Use only the supplied active Goal and proposal references from this exact native session, never another chat. Classify relation as new, same_scope_continuation, scope_change, or unknown, and action as answer, research, verify, change, operate, or unknown; do not infer either from a fixed phrase or tool name. “Check how it behaves” is verification/research even when the next tool is Bash. This interpretation grants no native permission. When the decision provider is unavailable, abstains, or returns unknown, interpret the same context in the main model; ask the user only if the action or referenced target remains unclear, and preserve active work while waiting. Native read, glob, grep, web_search and web_fetch demands can gather evidence without preparation. Do not call prepare_requested_work merely to read a plan or inspect files. prepare_requested_work accepts either the legacy taskType alone or a requestIntent with exact evidenceRefs from the supplied context; it never accepts a rewritten task or target and never changes native permissions. Installed Skill reads need no preparation and do not activate execution. Do not prepare work merely to load a skill. Plan, Goal, cancellation, memory-owner and execution ownership still apply. If only run_code is exposed, use the exact preparation-only carrier returned by this tool contract; the host intercepts it without evaluating code.'
const ACTION_TYPES: readonly TaskType[] = TASK_TYPES.filter(type => type !== 'chat')
const NO_ACTIVE_GOAL_GUIDANCE = 'The current context has no active Goal. same_scope_continuation may refer to the exact current-session conversation without a formal Goal; it grants no execution permission. scope_change requires an active Goal or task. If the original request clearly specifies a self-contained task, use relation=new and the action it requests (verify for verification), with the exact current evidenceRefs. Otherwise clarify the intended target with the user. Preserve the original scope, constraints and native permissions.'

const preparationFieldsSchema = z.object({
  taskType: z.enum(ACTION_TYPES).optional(),
  requestIntent: RequestIntentSubmissionSchema.optional(),
}).strict()
type PreparationRequest = z.infer<typeof preparationFieldsSchema>
function parsePreparationRequest(value: unknown): PreparationRequest | undefined {
  const parsed = preparationFieldsSchema.safeParse(value)
  return parsed.success && (parsed.data.taskType !== undefined || parsed.data.requestIntent !== undefined) ? parsed.data : undefined
}

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
  /** Positive host authority lookup; unavailable storage must reject, never mean absent. */
  readonly nativeOwnership?: (input: DemandInput) => Promise<'unowned' | 'owned'>
  /** Exact idempotent request replay; never accepts a new turn as continuation. */
  readonly replay?: (input: DemandInput) => Promise<boolean>
  /** Finalize or preserve the prior native turn only after its matching boundary is observed. */
  readonly advance?: (input: DemandInput, requestIntent?: RequestIntentDecision) => Promise<void>
  /** Route an answer to a pending host-owned confirmation before model generation. */
  readonly resumeConfirmation?: (input: DemandInput) => Promise<boolean>
  readonly existing: (input: DemandInput, requestIntent?: RequestIntentDecision) => Promise<boolean>
  readonly classify: (input: DemandInput, task: string) => Promise<AkinatorTaskClassification>
  readonly interpret?: (input: DemandInput, task: string) => Promise<RequestIntentInterpretation | undefined>
  readonly prepare: (input: DemandInput, taskType: TaskType, requestIntent?: RequestIntentDecision,
    requestIntentContext?: RequestIntentContext) => Promise<boolean>
  readonly ready: (agent: DemandAgent, turn?: number) => boolean
}
interface Turn {
  readonly input: DemandInput
  readonly task: string
  readonly humanContents: ReadonlyMap<string, string>
  status: 'capturing' | 'answer' | 'preparing' | 'prepared' | 'closed' | 'stale'
  intent: AkinatorTaskClassification
  requestIntent?: RequestIntentDecision
  requestIntentContext?: RequestIntentContext
  requestIntentContextDigest?: string
  preparedIntentDigest?: string
  memoryOwner: MemoryOwnerKind
  taskType?: TaskType
  existing?: boolean
  confirmationResume?: boolean
  capture?: Promise<boolean>
  captureError?: unknown
  preparation?: Promise<void>
  selectionPending?: boolean
  nativeUnowned?: boolean
  /** Only project context actually produced for this exact captured turn. */
  answerContextReady?: boolean
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
function automaticPreparationType(intent: AkinatorTaskClassification, requestIntent: RequestIntentDecision | undefined,
  name: string): TaskType | undefined {
  if (requestIntent?.relation === 'unknown' || requestIntent?.action === 'unknown') {
    // Gathering evidence grants no change/process authority. An active Goal
    // still requires its reference to be resolved before opening another run.
    return ['read', 'glob', 'grep', 'web_search', 'web_fetch'].includes(name) ? 'research' : undefined
  }
  if (requestIntent?.action === 'answer') return undefined
  const interpreted = requestIntentTaskType(requestIntent, intent.taskType)
  if (interpreted && interpreted !== 'chat') return interpreted
  if (intent.taskType && intent.taskType !== 'chat') return intent.taskType
  return ['read', 'glob', 'grep', 'web_search', 'web_fetch'].includes(name) ? 'research' : undefined
}
const UNOWNED_NATIVE_TOOLS = new Set(['bash', 'read', 'glob', 'grep', 'web_search', 'web_fetch', 'skill'])
function denied(reason: string): { kind: 'deny'; reason: string } { return { kind: 'deny', reason } }
/** A protocol carrier, not JavaScript evaluation. Only this exact JSON-literal call is recognized. */
export function preparationCarrier(value: unknown): PreparationRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const args = value as Record<string, unknown>
  if (Object.keys(args).sort().join(',') !== 'code,description' || typeof args.description !== 'string' || !args.description.trim()
     || typeof args.code !== 'string' || args.code.length > 8192) return undefined
  const code = args.code.trim().replace(/;$/u, '')
  const prefix = 'return await tools.prepare_requested_work('
  if (!code.startsWith(prefix) || !code.endsWith(')')) return undefined
  try {
    const input = JSON.parse(code.slice(prefix.length, -1)) as unknown
    const parsed = parsePreparationRequest(input)
    if (!parsed || code !== prefix + JSON.stringify(input) + ')') return undefined
    return parsed
  } catch { return undefined }
}


/** Conversation entry and execution intake are distinct; neither this mode nor a type hint grants native permission. */
export class OnDemandIntake {
  readonly #turns = new Map<string, Turn>()
  readonly #executions = new WeakMap<object, { turn: Turn; execute: Definition['execute']; carrier?: PreparationRequest; carrierDigest?: string; skillRead?: boolean; requestPreparation?: boolean; nativeUnownedDigest?: string }>()
  readonly #disposers: (() => void)[] = []
  readonly #pending = new Set<Promise<unknown>>()
  readonly #controlTools = new Map<string, Definition['execute']>()
  readonly #controlExecutions = new WeakMap<object, { turn?: Turn; execute: Definition['execute']; digest: string; invoke?: Definition['execute']; args?: unknown }>()
  readonly #lifecycle = new AbortController()
  #tools?: NativeTools
  #startupSkillReader: Definition['execute'] | undefined
  readonly #skillReaders = new WeakMap<DemandAgent, Definition['execute'] | undefined>()
  #stopped = false
  constructor(private readonly host: Dependencies, private readonly options: { onlyWhenDeferred?: boolean } = {}) {}
  /** Exact host-owned implementations, never a name-only execution bypass. */
  registerControlTool(definition: Definition): () => void {
    this.#controlTools.set(definition.name, definition.execute)
    return () => { if (this.#controlTools.get(definition.name) === definition.execute) this.#controlTools.delete(definition.name) }
  }
  isControl(execution: Execution): boolean {
    const proof = this.#controlExecutions.get(execution)
    return !this.#stopped && !execution.signal.aborted && !!proof
      && (!proof.turn || this.bound(execution) === proof.turn && !proof.turn.input.signal.aborted && !['closed', 'stale'].includes(proof.turn.status))
      && this.definition(execution)?.execute === proof.execute && canonicalContentHash(execution.arguments) === proof.digest
      && (proof.invoke ? [...this.#controlTools].some(([name, invoke]) => invoke === proof.invoke
        && this.#tools?.get(name, execution.agent)?.execute === invoke) : this.#controlTools.get(execution.name) === proof.execute)
  }
  controlTask(execution: Execution): string | undefined {
    return this.isControl(execution) ? this.#controlExecutions.get(execution)?.turn?.task : undefined
  }
  private controlCall(execution: Execution, actual: Definition): { execute: Definition['execute']; digest: string; invoke?: Definition['execute']; args?: unknown } | undefined {
    if (this.#controlTools.get(execution.name) === actual.execute) return { execute: actual.execute, digest: canonicalContentHash(execution.arguments) }
    if (execution.name !== 'run_code' || !execution.arguments || typeof execution.arguments !== 'object' || Array.isArray(execution.arguments)) return undefined
    const value = execution.arguments as Record<string, unknown>
    if (Object.keys(value).sort().join(',') !== 'code,description' || typeof value.code !== 'string' || value.code.length > 8192
      || typeof value.description !== 'string' || !value.description.trim()) return undefined
    const code = value.code.trim().replace(/;$/u, '')
    for (const [name, invoke] of this.#controlTools) {
      if (this.#tools?.get(name, execution.agent)?.execute !== invoke) continue
      const prefix = `return await tools.${name}(`
      if (!code.startsWith(prefix) || !code.endsWith(')')) continue
      try {
        const args: unknown = JSON.parse(code.slice(prefix.length, -1))
        if (code === prefix + JSON.stringify(args) + ')') return { execute: actual.execute, digest: canonicalContentHash(execution.arguments), invoke, args }
      } catch { /* Nonliteral programs keep ordinary execution admission. */ }
    }
    return undefined
  }
  private watch<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise)
    void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise))
    return promise
  }
  private existingTurn(execution: Execution): number | undefined {
    const last = execution.agent?.session?.snapshotEvents?.().filter(event => event.type === 'turn/start' || event.type === 'turn/end').at(-1)
    return last?.type === 'turn/start' ? eventTurn(last) : undefined
  }
  private acknowledgeExisting(state: Turn): void {
    this.assertCurrent(state)
    state.existing = true
    state.status = 'prepared'
    const taskType = requestIntentTaskType(state.requestIntent, state.intent.taskType)
    if (taskType !== undefined) state.taskType = taskType
    state.preparedIntentDigest = canonicalContentHash({ taskType: state.taskType ?? null, requestIntent: state.requestIntent ?? null })
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
          if (previous.status === 'stale') throw previous.captureError ?? new Error('Previous on-demand request is stale')
          return previous.status !== 'prepared'
        }
        previous.status = 'stale'; previous.controller.abort(new Error('Human instructions changed'))
        // A new native batch can contain only the steering message. Preserve
        // the original request while replacing changed messages by identity.
        const merged = new Map(previous.input.messages.map(message => [humanId(message), message]))
        for (const message of input.messages) merged.set(humanId(message), message)
        input = { ...input, messages: [...merged.values()] }
      }
      if (previous.input.turn !== input.turn && !humanMessages(input.messages).length && this.host.ready(input.agent)) {
        // A host-driven next turn may carry no new human message. Leave its
        // active execution bound to the host instead of creating an empty intake.
        if (previous.status === 'closed') {
          await this.host.validate(input)
          input.signal.throwIfAborted()
          await this.host.advance?.(input)
          this.#turns.delete(sessionId)
          this.host.answerContext?.retire(input.agent)
          return false
        }
      }
      if (previous.input.turn !== input.turn && !['closed', 'prepared'].includes(previous.status)) throw new Error('Previous on-demand turn has not ended')
      previous.controller.abort(new Error('A newer native turn superseded this request'))
    } else if (!humanMessages(input.messages).length && this.host.ready(input.agent)) {
      await this.host.validate(input)
      input.signal.throwIfAborted()
      await this.host.advance?.(input)
      return false
    }
    this.host.answerContext?.retire(input.agent)
    // Install the pending state synchronously, before any host or classifier awaits.
    const controller = new AbortController()
    const state: Turn = { input: { ...input, signal: AbortSignal.any([input.signal, controller.signal]), messages: Object.freeze(structuredClone([...input.messages])) }, task: humanTask(input.messages),
      humanContents: new Map(humanMessages(input.messages).map(message => [humanId(message), canonicalContentHash(message)])),
      status: 'capturing', intent: { deferInference: true }, memoryOwner: 'none', preparationCalls: new Set(), controller }
    this.#turns.set(sessionId, state)
    const promise = (async () => {
      await this.host.validate(input)
      this.assertCurrent(state)
      // Presets and later host plugins register readers after mount. Pin the
      // validated owner's first reader once, including absence; never rebind it.
      if (!this.#skillReaders.has(input.agent)) this.#skillReaders.set(input.agent,
        this.#startupSkillReader ?? this.#tools?.get('skill', input.agent)?.execute)
      if (!humanMessages(input.messages).length) throw new Error('Original human input is required before on-demand intake')
      // Native authority is independent of optional memory, Skills and model
      // classification. Never manufacture an owned task merely to run Bash.
      if (!this.options.onlyWhenDeferred && await this.host.nativeOwnership?.(state.input) === 'unowned') {
        this.assertCurrent(state)
        state.nativeUnowned = true
        const context = createRequestIntentContext({ task: state.task, messageRefs: requestIntentMessageRefs(state.input.messages, state.task) })
        if (context) {
          state.requestIntentContext = context
          state.requestIntentContextDigest = canonicalContentHash(context)
          state.requestIntent = unresolvedRequestIntent(context, 'native_unowned_request')
        }
        state.status = 'answer'
        return true
      }
      try { state.intent = await this.host.classify(input, state.task) }
      catch { input.signal.throwIfAborted(); state.intent = { deferInference: true } }
      try {
        const interpreted = await this.host.interpret?.(state.input, state.task)
        if (interpreted) {
          state.requestIntentContext = interpreted.context
          state.requestIntent = interpreted.decision
          state.requestIntentContextDigest = canonicalContentHash(interpreted.context)
        }
      } catch (error) {
        input.signal.throwIfAborted()
      }
      state.memoryOwner = memoryOwnerKind(state.requestIntent, state.intent.taskType)
      this.assertCurrent(state)
      if (previous?.input.turn !== input.turn) await this.host.advance?.(input, state.requestIntent)
      this.assertCurrent(state)
      const resumeConfirmation = previous?.input.turn !== input.turn && state.task
        ? await this.host.resumeConfirmation?.(input) ?? false : false
      if (process.env.KIOKUKO_INTENT_DEBUG === '1' && previous?.input.turn !== input.turn) {
        console.error('on-demand confirmation route', { turn: input.turn, previousTurn: previous?.input.turn,
          hasTask: state.task.length > 0, resumeConfirmation })
      }
      if (resumeConfirmation) {
        this.assertCurrent(state)
        state.confirmationResume = true
        state.status = 'answer'
        if (previous?.taskType !== undefined) state.taskType = previous.taskType
        this.host.answerContext?.retire(input.agent)
        return false
      }
      if (process.env.KIOKUKO_INTENT_DEBUG === '1' && previous?.input.turn !== input.turn && state.task && this.host.resumeConfirmation) {
        console.error('confirmation resume not selected', input.turn, state.task.length)
      }
      if (state.task && await this.host.replay?.(state.input)) {
        this.acknowledgeExisting(state)
        return false
      }
      const canContinue = state.requestIntent?.relation === 'same_scope_continuation'
        && state.requestIntent.action !== 'answer' && state.requestIntent.action !== 'unknown'
      if (previous?.input.turn !== input.turn && state.task && canContinue
        && await this.host.existing(input, state.requestIntent)) {
        // Persisted ownership is only an acknowledgement when this exact native
        // agent/session/turn is already bound. A cold resume stays conversational
        // until explicit preparation reconstructs that binding.
        if (this.host.ready(state.input.agent, state.input.turn)) {
          this.acknowledgeExisting(state)
          return false
        }
      }
      // Eager mode still binds known work before generation. Classifier uncertainty
      // instead reaches ordinary reasoning, with no execution grant or purpose UI.
      const requestIntentUnresolved = state.requestIntent !== undefined
        && (state.requestIntent.relation === 'unknown' || state.requestIntent.action === 'unknown')
      const requestAsAnswer = state.requestIntent?.action === 'answer'
      const knownIntent = this.host.interpret === undefined
        ? !state.intent.deferInference && state.intent.taskType !== undefined && state.intent.taskType !== 'chat'
        : state.requestIntent !== undefined && !requestIntentUnresolved && !requestAsAnswer
          && state.requestIntent.relation !== 'unknown' && state.requestIntent.action !== 'unknown'
      if (this.options.onlyWhenDeferred && knownIntent) {
        this.#turns.delete(sessionId)
        state.status = 'closed'
        controller.abort(new Error('Known intent continues through eager admission'))
        return false
      }
      // The current request is on the conversational path until actual admission.
      // Provisional intent cannot select a different run's memory validator.
      state.memoryOwner = 'conversation'
      await this.host.answerContext?.prepare(state.input, state.task, state.intent.taskType ?? null, state.memoryOwner)
      state.answerContextReady = this.host.answerContext !== undefined
      this.assertCurrent(state)
      state.status = 'answer'
      return true
    })()
    this.watch(promise)
    state.capture = promise
    try { return await promise } catch (error) {
      if (this.#turns.get(sessionId) === state) { state.status = 'stale'; state.captureError = error }
      throw error
    }
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
  private ownerIdentity(state: Turn): MemoryOwnerIdentity {
    const session = state.input.agent.session!
    return { agentId: state.input.agent.id, sessionId: session.id, turn: state.input.turn,
      requestDigest: canonicalContentHash(state.task) }
  }
  private definition(execution: Execution): Definition | undefined {
    try { return this.#tools?.get(execution.name, execution.agent) } catch { return undefined }
  }
  private async prepare(state: Turn, taskType: TaskType, signal: AbortSignal, requestIntent?: RequestIntentDecision,
    explicitIntent = false): Promise<void> {
    this.assertCurrent(state); signal.throwIfAborted()
    if (state.selectionPending) throw new ExecutionSelectionPending()
    const resolved = requestIntent ?? state.requestIntent
    const clarification = executionClarification(state.task, resolved, state.requestIntentContext)
    if (clarification) throw new Error(clarification)
    if (!ACTION_TYPES.includes(taskType)) throw new Error('Answer conversational questions directly; prepare_requested_work is for requested work')
    if (state.status === 'prepared' && state.confirmationResume && explicitIntent
      && (state.requestIntent?.relation === 'unknown' || state.requestIntent?.action === 'unknown')) state.status = 'answer'
    if (state.status === 'prepared') {
      if (state.taskType !== taskType) throw new Error('Prepared intent cannot be replaced within a turn')
      if (explicitIntent && state.preparedIntentDigest !== canonicalContentHash({ taskType, requestIntent: requestIntent ?? null })) {
        throw new Error('Prepared interpretation cannot be replaced within a turn')
      }
      return
    }
    if (state.preparation) { await state.preparation; this.assertCurrent(state); return }
    state.nativeUnowned = false
    state.status = 'preparing'; state.taskType = taskType
    const operation = (async () => {
      // Retain exact original messages. The only caller-supplied input is an advisory task type.
      const admitted = await this.host.prepare({ ...state.input, signal: AbortSignal.any([state.input.signal, signal]) }, taskType,
        requestIntent ?? state.requestIntent, state.requestIntentContext)
      this.assertCurrent(state); signal.throwIfAborted()
      if (!admitted || !this.host.ready(state.input.agent, state.input.turn)) throw new Error('Execution preparation did not admit this exact request')
      const preparedIntent = requestIntent ?? state.requestIntent
      if (preparedIntent !== undefined) state.requestIntent = preparedIntent
      state.preparedIntentDigest = canonicalContentHash({ taskType, requestIntent: state.requestIntent ?? null })
      state.status = 'prepared'
      delete state.confirmationResume
    })()
    this.watch(operation)
    state.preparation = operation
    try { await operation } catch (error) {
      if (!['closed', 'stale'].includes(state.status)) {
        // A declined selection preserves this request for a conversational acknowledgement.
        // It is not admission: preparation remains consumed and tools still need a ready host.
        state.selectionPending = error instanceof ExecutionSelectionPending && !state.input.signal.aborted && !signal.aborted
        // Preparation failure is not a change of human authority. Keep the
        // captured request retryable, but never revive Stop/cancellation. A
        // new call must pass host admission and native permission checks again.
        state.status = state.input.signal.aborted || signal.aborted || this.#stopped ? 'stale' : 'answer'
        delete state.preparedIntentDigest
        delete state.taskType
        state.memoryOwner = 'none'
      }
      throw error
    }
    finally { delete state.preparation }
  }
  private bindIntent(state: Turn, submission?: RequestIntentSubmission): RequestIntentDecision | undefined {
    if (!submission) return state.requestIntent
    if (!state.requestIntentContext || state.requestIntentContextDigest !== canonicalContentHash(state.requestIntentContext)) {
      throw new Error('Request interpretation context is stale')
    }
    const result = validateMainModelRequestIntent(submission, state.requestIntentContext)
    if (!result.ok) {
      switch (result.reason) {
        case 'no_active_goal': throw new Error(`Request relation ${submission.relation} cannot be used without an active Goal. ${NO_ACTIVE_GOAL_GUIDANCE}`)
        case 'missing_reference': throw new Error('Request interpretation is missing required current message or active Goal references. Use the exact current evidenceRefs from the supplied context.')
        case 'unknown_reference': throw new Error('Request interpretation references another request, stale revision, or unknown proposal. Use only the exact current evidenceRefs from the supplied context.')
        case 'unresolved_intent': throw new Error('Request relation or action is unresolved. Interpret the original request and current context; clarify with the user if its action or target remains unclear.')
        case 'invalid_submission': throw new Error('Invalid request interpretation. Supply a relation, action and unique exact current evidenceRefs.')
        case 'invalid_task_operation': throw new Error('The proposed task operation is not allowed for the current SQLite task state and revision. Use task_operation or /kioku-task with an allowed explicit operation; native permissions and required evidence remain unchanged.')
      }
    }
    const bound = result.decision
    const prior = state.requestIntent
    if (prior?.source === 'decision-provider' && prior.relation !== 'unknown' && prior.action !== 'unknown') {
      if (prior.relation !== bound.relation || prior.action !== bound.action) {
        throw new Error('Main-model interpretation conflicts with the configured decision provider')
      }
      return { ...prior, evidence: bound.evidence }
    }
    return bound
  }
  async answerMessages(input: DemandInput, messages: readonly unknown[]): Promise<readonly unknown[]> {
    const state = this.#turns.get(input.agent.session!.id)
    // Native pre-step may augment its payload while downstream hooks run.
    // Project the immutable human batch captured before that waterfall.
    if (state?.input.turn === input.turn && state.input.agent !== input.agent) throw new Error('Answer projection native agent changed')
    const projected = state?.input.turn === input.turn && !state.nativeUnowned && state.answerContextReady && !state.confirmationResume && this.host.answerContext
      ? await this.host.answerContext.project(state.input, messages, this.ownerIdentity(state)) : messages
    return this.guidance(projected, state?.input.turn === input.turn ? state : undefined)
  }
  async beforeRequest(agent: DemandAgent): Promise<void> {
    const state = agent.session && this.#turns.get(agent.session.id)
    if (state && !state.nativeUnowned && state.answerContextReady && state.input.agent === agent && state.status === 'answer' && this.pending(agent)) {
      await this.host.answerContext?.beforeRequest(state.input, this.ownerIdentity(state))
    }
  }
  async fence(agent: DemandAgent, request: { sessionId?: string; purpose?: string; messages?: readonly unknown[] }): Promise<void> {
    const state = agent.session && this.#turns.get(agent.session.id)
    if (state && !state.nativeUnowned && state.answerContextReady && state.input.agent === agent && state.status === 'answer' && this.pending(agent)) {
      await this.host.answerContext?.fence(state.input, request, this.ownerIdentity(state))
    }
  }
  guidance(messages: readonly unknown[], state?: Turn): readonly unknown[] {
    const context = state?.requestIntentContext
    const interpretation = state?.requestIntent
    const intentText = context ? `\n\nCurrent request references and same-session work (host-bound, advisory only):\n${JSON.stringify({
      references: requestIntentReferenceIds(context),
      activeGoal: context.activeGoal ?? null,
      activeTask: context.activeTask ?? null,
      proposals: context.proposals.map(({ id, revision, digest, text }) => ({ id, revision, digest, text })),
      decision: interpretation ? { relation: interpretation.relation, action: interpretation.action, source: interpretation.source,
        policyVersion: interpretation.policyVersion, evidence: interpretation.evidence, unresolvedReason: interpretation.unresolvedReason ?? null } : null,
    })}\nUse only these exact references in requestIntent.evidenceRefs. The original human message remains unchanged.` : ''
    const text = ON_DEMAND_GUIDANCE + intentText + (context && !context.activeGoal && !context.activeTask ? `\n${NO_ACTIVE_GOAL_GUIDANCE}` : '')
    return [...messages, { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
      source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'snapshot', sections: [{ name: 'on-demand-intake', text }] } }]
  }
  snapshot(sessionId: string): { task: string; taskType: TaskType | null; status: string; turn: number; requestIntent?: RequestIntentDecision; memoryOwner: MemoryOwnerKind } | undefined {
    const state = this.#turns.get(sessionId)
    return state && { task: state.task, taskType: state.taskType ?? state.intent.taskType ?? null, status: state.status, turn: state.input.turn,
      ...(state.requestIntent ? { requestIntent: structuredClone(state.requestIntent) } : {}), memoryOwner: state.memoryOwner }
  }
  /** Refresh only authority facts after a committed control operation; retain the exact human request. */
  taskStateChanged(task: TaskSnapshot): void {
    const state = this.#turns.get(task.sessionId)
    if (!state || ['closed', 'stale'].includes(state.status) || state.input.signal.aborted || !state.requestIntentContext) return
    state.nativeUnowned = false
    const previous = state.requestIntentContext.activeTask
    if (previous?.taskId === task.taskId && previous.revision === task.revision && previous.generation === task.generation) return
    const context = createRequestIntentContext({ ...state.requestIntentContext, activeTask: task,
      ...(state.requestIntentContext.activeGoal?.runId === task.runId ? {} : { activeGoal: undefined }) })
    if (!context) return
    state.requestIntentContext = context
    state.requestIntentContextDigest = canonicalContentHash(context)
    state.requestIntent = unresolvedRequestIntent(context, 'task_state_changed')
    state.status = 'answer'; state.existing = false; state.memoryOwner = 'none'
    delete state.preparedIntentDigest
  }
  /** A current host-validated control call, never arbitrary code or a name-based exemption. */
  /** Exact registered native-tool proof, never a model flag or a generic task-control bypass. */
  unownedNative(execution: Execution): boolean {
    const state = this.bound(execution), proof = this.#executions.get(execution)
    return !this.#stopped && !execution.signal.aborted && UNOWNED_NATIVE_TOOLS.has(execution.name) && execution.parent === undefined
      && !!state && state.nativeUnowned === true && state.status === 'answer' && !state.input.signal.aborted
      && !!proof && proof.turn === state && proof.execute === this.definition(execution)?.execute
      && proof.nativeUnownedDigest === canonicalContentHash(execution.arguments)
  }
  preparationOnly(execution: Execution): boolean {
    if (this.isControl(execution)) return true
    const state = this.bound(execution), proof = this.#executions.get(execution)
    if (this.#stopped || execution.signal.aborted || execution.parent !== undefined || !state || state.input.signal.aborted
      || !proof || proof.turn !== state || this.definition(execution)?.execute !== proof.execute
      || state.preparationCalls.has(execution.callId)) return false
    if (proof.carrier) return execution.name === 'run_code' && state.status === 'answer'
      && canonicalContentHash(preparationCarrier(execution.arguments) ?? null) === proof.carrierDigest
    return proof.requestPreparation === true && execution.name === TASK_PREPARE_TOOL
      && (state.status === 'answer' || state.existing === true && state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn))
  }
  pending(agent: DemandAgent): boolean {
    const state = agent.session && this.#turns.get(agent.session.id)
    return !!state && !state.confirmationResume && state.input.agent === agent && !['prepared', 'closed', 'stale'].includes(state.status)
  }
  /** An admitted host continuation still needs capture to retire the previous turn's receipt. */
  continuing(agent: DemandAgent): boolean { return !this.#stopped && this.host.ready(agent) }
  finish(session: object & { id: string }, turn: number): void {
    const state = this.#turns.get(session.id)
    if (state?.input.agent.session === session && state.input.turn === turn) {
      state.status = 'closed'; state.controller.abort(new Error('Native turn ended'))
      this.host.answerContext?.retire(state.input.agent)
    }
  }
  mount(context: { on(name: string, listener: (...args: any[]) => any, options?: { prepend: boolean }): () => void }, tools: NativeTools, systemPrompt?: { section(section: any): () => void }): void {
    if (!tools.get || !tools.guard || !tools.register) throw new Error('On-demand intake requires native tool identity and monotonic guards')
    this.#tools = tools
    // Preserve an already installed reader across replacement before capture.
    // When absent, capture binds the validated agent's installed preset reader.
    this.#startupSkillReader = tools.get('skill')?.execute
    if (systemPrompt && !this.options.onlyWhenDeferred) this.#disposers.push(systemPrompt.section({ name: 'kiokuko:on-demand-intake', order: -99999, text: 'On-demand host contract: text answers do not require execution intake. The public prepare_requested_work tool accepts an advisory taskType or a source-bound requestIntent; task_prepare/task_answer remain host-only. ' + ON_DEMAND_GUIDANCE }))
    const definition = { name: TASK_PREPARE_TOOL, modelFacing: true,
      description: 'Prepare the exact original user request for tool-backed work. Supply either legacy advisory taskType or requestIntent with exact evidenceRefs from the host context; never rewrite the task or invent a target. This does not grant native tool permissions. Answer ordinary questions directly; clarify unknown actions or targets first.',
      parameters: { ...JSON.parse(JSON.stringify(z.toJSONSchema(preparationFieldsSchema))), anyOf: [{ required: ['taskType'] }, { required: ['requestIntent'] }] },
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args: unknown, execution: Execution) => {
        const state = this.bound(execution)
        const value = parsePreparationRequest(args)
        if (!state || execution.name !== TASK_PREPARE_TOOL || this.definition(execution)?.execute !== definition.execute || !value) throw new Error('Invalid task preparation request')
        if (state.preparationCalls.has(execution.callId) || !(state.status === 'answer' || state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn))) throw new Error('Task preparation was already consumed for this turn')
        state.preparationCalls.add(execution.callId)
        if (state.existing) {
          this.assertCurrent(state); execution.signal.throwIfAborted()
          const boundIntent = this.bindIntent(state, value.requestIntent)
          if (boundIntent?.relation === 'same_scope_continuation' && boundIntent.action !== 'answer' && boundIntent.action !== 'unknown') {
            const intentType = requestIntentTaskType(boundIntent, state.taskType ?? state.intent.taskType ?? value.taskType)
            if (value.taskType !== undefined && intentType !== undefined && value.taskType !== intentType) {
              throw new Error('The advisory taskType conflicts with the bound request action')
            }
            state.requestIntent = boundIntent
          } else {
            if (!boundIntent || boundIntent.relation === 'unknown' || boundIntent.action === 'unknown' || boundIntent.action === 'answer') {
              throw new Error('Clarify whether this request continues, changes, or starts work before preparing it')
            }
            const intentType = requestIntentTaskType(boundIntent, state.taskType ?? state.intent.taskType ?? value.taskType)
            if (!intentType || intentType === 'chat' || value.taskType !== undefined && value.taskType !== intentType) {
              throw new Error('The advisory taskType conflicts with the bound request action')
            }
            state.existing = false
            state.status = 'answer'
            state.memoryOwner = memoryOwnerKind(boundIntent, intentType)
            await this.prepare(state, intentType, execution.signal, boundIntent, value.requestIntent !== undefined)
          }
        } else {
          const suppliedIntent = this.bindIntent(state, value.requestIntent)
          const currentIntent = suppliedIntent ?? state.requestIntent
          const unresolved = currentIntent?.relation === 'unknown' || currentIntent?.action === 'unknown'
          if (unresolved && (state.requestIntentContext?.activeGoal || value.requestIntent !== undefined || value.taskType === undefined)) {
            throw new Error('Clarify the request before preparing work')
          }
          if (state.requestIntentContext?.activeGoal && currentIntent === undefined) {
            throw new Error('Clarify whether this request continues, changes, or starts the active Goal')
          }
          const intentType = unresolved ? undefined : requestIntentTaskType(currentIntent, state.taskType ?? state.intent.taskType ?? value.taskType)
          if (value.taskType !== undefined && intentType !== undefined && value.taskType !== intentType) {
            throw new Error('The advisory taskType conflicts with the bound request action')
          }
          const taskType = intentType ?? value.taskType
          if (!taskType || taskType === 'chat' || !ACTION_TYPES.includes(taskType)) throw new Error('Answer ordinary questions directly; clarify unknown actions before preparing work')
          state.memoryOwner = memoryOwnerKind(currentIntent, taskType)
          await this.prepare(state, taskType, execution.signal, currentIntent, value.requestIntent !== undefined)
        }
        return { prepared: true, taskType: state.taskType ?? value.taskType ?? requestIntentTaskType(state.requestIntent), originalTask: state.task,
          ...(state.requestIntent ? { requestIntent: state.requestIntent } : {}), memoryOwner: state.memoryOwner, permissions: 'unchanged_native_policy' }
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
      const control = this.controlCall(execution, actual)
      if (control) {
        const turn = this.bound(execution)
        if (execution.agent?.session && this.#turns.has(execution.agent.session.id) && !turn) return denied('Stale task control request')
        if (turn) { try { this.assertCurrent(turn) } catch { return denied('Stale task control request') } }
        this.#controlExecutions.set(execution, { ...control, ...(turn ? { turn } : {}) })
        const decision = await next()
        return decision?.kind === 'cancel' ? denied('Native tool policy cancelled this call') : decision
      }
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
        if (state.confirmationResume && execution.name !== TASK_PREPARE_TOOL && this.host.ready(state.input.agent, state.input.turn)) this.acknowledgeExisting(state)
        if (state.nativeUnowned && UNOWNED_NATIVE_TOOLS.has(execution.name) && execution.parent === undefined) {
          if (await this.host.nativeOwnership?.(state.input) !== 'unowned') {
            state.nativeUnowned = false
            return denied('Native execution acquired a Kiokuko owner; its current authority is required')
          }
          this.assertCurrent(state)
          if (this.definition(execution)?.execute !== actual.execute) return denied('Native tool definition changed')
          this.#executions.set(execution, { turn: state, execute: actual.execute, nativeUnownedDigest: canonicalContentHash(execution.arguments) })
          const decision = await next()
          return decision?.kind === 'cancel' ? denied('Native tool policy cancelled this call') : decision
        }
        const skillReader = this.#skillReaders.get(state.input.agent)
        const skillRead = execution.name === 'skill' && skillReader !== undefined && actual.execute === skillReader && state.status === 'answer'
        const carrier = execution.name === 'run_code' ? preparationCarrier(execution.arguments) : undefined
        const carrierDigest = carrier ? canonicalContentHash(carrier) : undefined
        if (execution.name === 'run_code' && state.status !== 'prepared' && !carrier
          && !automaticPreparationType(state.intent, state.requestIntent, execution.name)) return denied('Clarify the requested work before code execution.')
        if (carrier) {
          if (!(state.status === 'answer' || state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn)) || state.preparationCalls.has(execution.callId)) return denied('Preparation carrier is not current')
        } else if (execution.name === TASK_PREPARE_TOOL) {
          if (actual.execute !== definition.execute || !(state.status === 'answer' || state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn)) || state.preparationCalls.has(execution.callId)) return denied('Task preparation is not current')
        } else if (!skillRead) {
          if (state.status !== 'prepared') {
            const type = automaticPreparationType(state.intent, state.requestIntent, execution.name)
            if (!type) return denied('Before tool-backed work, call prepare_requested_work with its advisory taskType. Clarify unknown actions or targets first; the original request is preserved.')
            await this.prepare(state, type, execution.signal, state.requestIntent)
          }
          if (!this.host.ready(state.input.agent, state.input.turn)) return denied('Prepared execution is no longer current')
        }
        this.assertCurrent(state)
        if (this.definition(execution)?.execute !== actual.execute) return denied('Native tool definition changed during preparation')
        this.#executions.set(execution, { turn: state, execute: actual.execute,
          ...(carrier && carrierDigest ? { carrier, carrierDigest } : {}), ...(skillRead ? { skillRead: true } : {}),
          ...(execution.name === TASK_PREPARE_TOOL ? { requestPreparation: true } : {}) })
        // Preserve native allow/deny/ask unchanged. Approval is resolved by the native registry AFTER this waterfall.
        const decision = await next()
        // DSH 0.1.5 does not understand cancel and otherwise dispatches it without running guards.
        return decision?.kind === 'cancel' ? denied('Native tool policy cancelled this call') : decision
      } catch (error) { return denied(error instanceof Error ? error.message : 'Execution preparation failed') }
    }, { prepend: true }))
    this.#disposers.push(context.on('tools/execute', async (execution: Execution, next: () => Promise<unknown>) => {
      if (execution.agent && this.host.nativeChild?.(execution.agent)) return next()
      const control = this.#controlExecutions.get(execution)
      if (control) {
        if (!this.isControl(execution)) throw new Error('Task control identity or arguments changed')
        ;(execution as { signal: AbortSignal }).signal = AbortSignal.any([execution.signal, this.#lifecycle.signal, ...(control.turn ? [control.turn.input.signal] : [])])
        if (!control.invoke) return next()
        const result = await control.invoke(control.args, execution)
        return { isError: false, value: { logs: ['Host task operation. No program was evaluated.'], result },
          content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      const proof = this.#executions.get(execution)
      if (!proof) return next() // Existing independently admitted runs keep their original path.
       const state = this.bound(execution)
       if (!state || proof.turn !== state || this.definition(execution)?.execute !== proof.execute) throw new Error('On-demand dispatch identity changed')
       this.assertCurrent(state)
       ;(execution as { signal: AbortSignal }).signal = AbortSignal.any([execution.signal, state.input.signal, this.#lifecycle.signal])
       if (proof.nativeUnownedDigest !== undefined) {
         if (!this.unownedNative(execution) || await this.host.nativeOwnership?.(state.input) !== 'unowned') {
           state.nativeUnowned = false
           throw new Error('Native unowned authority changed or became unavailable')
         }
         this.assertCurrent(state)
         return next()
       }
       if (!proof.carrier) return next()
        const carrier = preparationCarrier(execution.arguments)
        if (!(state.status === 'answer' || state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn)) || state.preparationCalls.has(execution.callId)
          || !carrier || canonicalContentHash(carrier) !== proof.carrierDigest) throw new Error('Preparation carrier was already consumed or changed')
        state.preparationCalls.add(execution.callId)
        const requestIntent = this.bindIntent(state, carrier.requestIntent)
        const clarification = executionClarification(state.task, requestIntent, state.requestIntentContext)
        if (clarification) throw new Error(clarification)
        const unresolved = requestIntent?.relation === 'unknown' || requestIntent?.action === 'unknown'
        const legacyTaskTypeAllowed = carrier.taskType !== undefined && !state.requestIntentContext?.activeGoal
          && (state.requestIntentContext?.proposals.length ?? 0) === 0
        if (unresolved && !legacyTaskTypeAllowed) throw new Error('Clarify the requested action and scope before preparing work')
        const intentType = unresolved ? undefined : requestIntentTaskType(requestIntent, state.taskType ?? state.intent.taskType ?? carrier.taskType)
        const taskType = intentType ?? carrier.taskType
        if (carrier.taskType !== undefined && taskType !== carrier.taskType) throw new Error('The advisory taskType conflicts with the bound request action')
        if (!taskType || taskType === 'chat') {
          throw new Error('Clarify the requested action and scope before preparing work')
        }
        state.memoryOwner = memoryOwnerKind(requestIntent, taskType)
        await this.prepare(state, taskType, execution.signal, requestIntent, carrier.requestIntent !== undefined)
       const result = { prepared: true, taskType: state.taskType, originalTask: state.task,
         ...(state.requestIntent ? { requestIntent: state.requestIntent } : {}), memoryOwner: state.memoryOwner,
         permissions: 'unchanged_native_policy', programExecuted: false }
       return { isError: false, value: { logs: ['Host intake prepared. No program was evaluated.'], result }, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }, { prepend: true }))
    this.#disposers.push(tools.guard(execution => {
      if (this.#stopped || execution.signal.aborted) return 'On-demand intake is stopped or cancelled'
      if (execution.agent && this.host.nativeChild?.(execution.agent)) return undefined
      if (this.isControl(execution)) return undefined
      const state = this.bound(execution), actual = this.definition(execution)
      if (!actual) return 'Unknown native tool definition'
      if (!state) {
        if (execution.agent?.session && this.#turns.has(execution.agent.session.id)) return 'Stale on-demand native turn'
        const turn = this.existingTurn(execution)
        return execution.agent && turn !== undefined && this.host.ready(execution.agent, turn) ? undefined : 'No current native request for tool execution'
      }
      const proof = this.#executions.get(execution)
      if (!proof || proof.turn !== state || proof.execute !== actual.execute || ['closed', 'stale', 'capturing'].includes(state.status)) return 'Tool execution has no current on-demand preparation'
      if (proof.nativeUnownedDigest !== undefined) return this.unownedNative(execution) ? undefined : 'Native unowned execution proof changed'
       if (proof.carrier) return (state.status === 'answer' || state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn))
         && canonicalContentHash(preparationCarrier(execution.arguments) ?? null) === proof.carrierDigest ? undefined : 'Preparation carrier is not current'
      if (proof.skillRead) return state.status === 'answer' && actual.execute === this.#skillReaders.get(state.input.agent) ? undefined : 'Conversational Skill read is not current'
      if (execution.name === TASK_PREPARE_TOOL) return actual.execute === definition.execute && (state.status === 'answer' || state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn)) ? undefined : 'Task preparation is not current'
      return state.status === 'prepared' && this.host.ready(state.input.agent, state.input.turn) ? undefined : 'Execution task is not prepared'
    }))
  }
  answerOwner(session: object & { id: string }): { agent: DemandAgent; workspace: string } | undefined {
    if (this.#stopped) return undefined
    const state = this.#turns.get(session.id)
    if (!state || state.status !== 'answer' || state.input.agent.session !== session || state.memoryOwner !== 'conversation') return undefined
    const owner = this.host.answerContext?.owner(session, this.ownerIdentity(state))
    return state.input.agent === owner?.agent ? owner : undefined
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
