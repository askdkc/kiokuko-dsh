import { isCodingWorkflowStatus } from './coding-workflow/host.js'
import { symbols } from '@deepseek-ai/cordis'
import {
  requestInterpretationError,
  requestInterpretationRecovery,
} from './request-interpretation-guidance.js'
import {
  collectClarificationContext,
  clarificationReply,
  reusableClarificationAnswer,
  type ClarificationContext,
} from './clarification-context.js'
import { abortable } from './boundary-worker.js'
import type { AuxiliaryRecovery } from './auxiliary-recovery.js'
import { filterRequestMemory } from './request-memory.js'
import { MemorySnapshotStale } from './memory-request-fence.js'
import type { DshUserQuestions } from './intake-questions.js'
import {
  isLispImplementation,
  isLispNativeCommand,
  withRootLispAdmission,
  rememberLispConversation,
} from './lisp-tool-identity.js'
import { ExecutionSelectionPending } from './execution-pending.js'
import type { DshAnswerContext } from './answer-context.js'
import { executionClarification } from './intake-clarification.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import { randomUUID } from 'node:crypto'
import { retainedEvents } from './context-projection.js'
import { z } from 'zod'
import { TASK_TYPES, type TaskType } from '../akinator/types.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KIOKUKO_DSH_SOURCE_KIND, isKiokukoDshSource } from './plugin-source.js'
import type { AkinatorTaskClassification } from './decisions/akinator-classification.js'
import {
  taskAllowedOperations,
  taskCanExecute,
  type TaskSnapshot,
} from './task-state.js'
import {
  createRequestIntentContext,
  unresolvedRequestIntent,
  validateMainModelRequestIntent,
  requestIntentReferenceIds,
  requestIntentRequiredReferenceIds,
  requestIntentIsUnresolved,
  requestIntentMessageRefs,
  requestIntentTaskType,
  RequestIntentSubmissionSchema,
  type RequestIntentContext,
  type RequestIntentDecision,
  type RequestIntentInterpretation,
  type RequestIntentSubmission,
} from './decisions/request-intent.js'
import {
  memoryOwnerKind,
  type MemoryOwnerIdentity,
  type MemoryOwnerKind,
} from './memory-owner.js'
import type { IntentAssessment } from './decisions/intent-assessment.js'
import type { IntakeDiagnosticObservation } from './decisions/diagnostics.js'

class RequestClarification extends Error {
  constructor(
    message: string,
    readonly assessment = false,
    readonly interpretation = false,
    readonly candidate?: RequestIntentDecision,
  ) {
    super(message)
  }
}

export type { IntakeMode } from './intake-mode.js'
export const TASK_PREPARE_TOOL = 'prepare_requested_work'
export const ON_DEMAND_GUIDANCE =
  'The original user request may be answered now without selecting a task category. Ordinary native Bash needs no memory, Goal or prepare_requested_work round trip, including when optional workflow metadata exists; native permissions and human Stop remain authoritative. Registered root Lisp tools delegate to the Lisp runtime without an optional preparation round trip; foreground processes use native Bash permissions, sandbox, approval and Stop. Explicitly prepared or protected workflow effects retain their task, Plan and coding-choice checks. Owned or explicitly enrolled work retains its authority checks. Preserve the original utterance, every requested action, negation, quotation, target uncertainty, and current-session references; never replace it with a model rewrite. Use only the supplied active Goal and proposal references from this exact native session, never another chat. Classify relation as new, same_scope_continuation, scope_change, or unknown, and action as answer, research, verify, change, operate, or unknown; do not infer either from a fixed phrase or tool name. “Check how it behaves” is verification/research even when the next tool is Bash. This interpretation grants no native permission. When the decision provider is unavailable, abstains, or returns unknown, interpret the same context in the main model; ask the user only if the action or referenced target remains unclear, and preserve active work while waiting. Native read, glob, grep, web_search and web_fetch demands can gather evidence without preparation. Do not call prepare_requested_work merely to read a plan or inspect files. prepare_requested_work accepts either the legacy taskType alone or a requestIntent with exact evidenceRefs from the supplied context. taskOperation is optional and describes a transition of an existing activeTask, not starting the requested work itself. Omit taskOperation when activeTask is null or the request does not ask for a state transition; it never accepts a rewritten task or target and never changes native permissions. Installed Skill reads need no preparation and do not activate execution. Do not prepare work merely to load a skill. Plan, Goal, cancellation, memory-owner and execution ownership still apply. If only run_code is exposed, use the exact preparation-only carrier returned by this tool contract; the host intercepts it without evaluating code.'
const ACTION_TYPES: readonly TaskType[] = TASK_TYPES.filter(
  (type) => type !== 'chat',
)
const NO_ACTIVE_GOAL_GUIDANCE =
  'The current context has no active Goal. same_scope_continuation may refer to the exact current-session conversation without a formal Goal; it grants no execution permission. scope_change requires an active Goal, task, or an explicitly selected current-session proposal. A proposal is evidence, never approval by itself. If the original request clearly specifies a self-contained task, use relation=new and the action it requests (verify for verification), with the exact current evidenceRefs. Otherwise clarify the intended target with the user. Preserve the original scope, constraints and native permissions.'

const preparationFieldsSchema = z
  .object({
    taskType: z.enum(ACTION_TYPES).optional(),
    requestIntent: RequestIntentSubmissionSchema.optional(),
  })
  .strict()
type PreparationRequest = z.infer<typeof preparationFieldsSchema>
function parsePreparationRequest(
  value: unknown,
): PreparationRequest | undefined {
  const parsed = preparationFieldsSchema.safeParse(value)
  return parsed.success &&
    (parsed.data.taskType !== undefined ||
      parsed.data.requestIntent !== undefined)
    ? parsed.data
    : undefined
}

export interface DemandAgent {
  readonly ctx?: unknown
  readonly id: string
  cancel?(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  followup?(message: any): unknown
  readonly session?: {
    readonly id: string
    snapshotEvents?(): readonly DshLogEvent[]
  }
}
export interface DemandInput {
  readonly agent: DemandAgent
  readonly turn: number
  readonly step: number
  readonly messages: readonly unknown[]
  readonly signal: AbortSignal
}
interface Execution {
  readonly agent?: DemandAgent
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly signal: AbortSignal
  readonly parent?: unknown
  readonly token?: symbol
}
interface Definition {
  readonly name: string
  readonly execute: (...args: any[]) => unknown
}
interface NativeTools {
  readonly setExecutor?: unknown
  register(definition: any): () => void
  get(name: string, agent?: unknown): Definition | undefined
  guard(callback: (execution: Execution) => string | undefined): () => void
}
interface Dependencies {
  readonly assess?: (
    input: DemandInput,
    context: RequestIntentContext,
    decision: RequestIntentDecision,
    recoveryAttempt?: number,
  ) => Promise<IntentAssessment | undefined>
  readonly diagnostic?: (
    input: DemandInput,
    observation: IntakeDiagnosticObservation,
  ) => Promise<void>
  readonly questions?: DshUserQuestions

  readonly answerContext?: DshAnswerContext | undefined
  readonly recovery?: AuxiliaryRecovery
  readonly nativeChild?: (agent: DemandAgent) => boolean
  readonly validate: (input: DemandInput) => Promise<void>
  /** Positive host authority lookup; unavailable storage must reject, never mean absent. */
  readonly nativeOwnership?: (
    input: DemandInput,
  ) => Promise<'unowned' | 'owned'>
  readonly prepareNativeCoding?: (
    input: DemandInput,
    task: string,
    requestIntentContext?: RequestIntentContext,
  ) => Promise<void>
  /** Exact idempotent request replay; never accepts a new turn as continuation. */
  readonly replay?: (input: DemandInput) => Promise<boolean>
  /** Finalize or preserve the prior native turn only after its matching boundary is observed. */
  readonly advance?: (
    input: DemandInput,
    requestIntent?: RequestIntentDecision,
  ) => Promise<void>
  /** Route an answer to a pending host-owned confirmation before model generation. */
  readonly resumeConfirmation?: (input: DemandInput) => Promise<boolean>
  readonly existing: (
    input: DemandInput,
    requestIntent?: RequestIntentDecision,
  ) => Promise<boolean>
  readonly classify: (
    input: DemandInput,
    task: string,
  ) => Promise<AkinatorTaskClassification>
  readonly requestContext?: (
    input: DemandInput,
    task: string,
  ) => Promise<RequestIntentContext | undefined>
  readonly interpret?: (
    input: DemandInput,
    task: string,
  ) => Promise<RequestIntentInterpretation | undefined>
  readonly prepare: (
    input: DemandInput,
    taskType: TaskType,
    requestIntent?: RequestIntentDecision,
    requestIntentContext?: RequestIntentContext,
  ) => Promise<boolean>
  readonly ready: (agent: DemandAgent, turn?: number) => boolean
}
interface Turn {
  readonly input: DemandInput
  readonly session: NonNullable<DemandAgent['session']>
  readonly nativeSignal: AbortSignal
  readonly task: string
  readonly humanContents: ReadonlyMap<string, string>
  status: 'capturing' | 'answer' | 'preparing' | 'prepared' | 'closed' | 'stale'
  intent: AkinatorTaskClassification
  requestIntent?: RequestIntentDecision
  requestIntentContext?: RequestIntentContext
  requestIntentContextDigest?: string
  preparedIntentDigest?: string
  guidance?: { readonly id: string; readonly text: string }
  assessment?: { digest: string; result: IntentAssessment }
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
  memoryDeferred?: boolean
  auxiliaryReceipt?: unknown
  recoveryAfterFinish?: boolean
  readonly preparationCalls: Set<string>
  readonly controller: AbortController
}
function humanMessages(messages: readonly unknown[]): any[] {
  return messages.filter(
    (value: any) =>
      value?.role === 'user' && (!value.source || value.source.kind === 'user'),
  )
}
function humanTask(messages: readonly unknown[]): string {
  return humanMessages(messages)
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : (message.content ?? [])
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text),
    )
    .join('\n')
    .trim()
}
function humanId(message: any): string {
  return typeof message.id === 'string'
    ? message.id
    : canonicalContentHash(message)
}
function eventTurn(event: { data?: unknown } | undefined): number | undefined {
  const data = event?.data as { turn?: unknown } | undefined
  return Number.isSafeInteger(data?.turn) ? (data!.turn as number) : undefined
}
/** Tool names select advice only; admission and native permissions remain authoritative. */
function automaticPreparationType(
  intent: AkinatorTaskClassification,
  requestIntent: RequestIntentDecision | undefined,
  name: string,
): TaskType | undefined {
  if (requestIntent !== undefined && requestIntentIsUnresolved(requestIntent)) {
    // Gathering evidence grants no change/process authority. An active Goal
    // still requires its reference to be resolved before opening another run.
    return [
      'read',
      'read_image',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
      'cordis_inspect_list',
      'cordis_inspect_query',
      'kioku_read',
      'job_output',
      'job_list',
      'list_subagent_models',
    ].includes(name)
      ? 'research'
      : undefined
  }
  if (requestIntent?.action === 'answer') return undefined
  const interpreted = requestIntentTaskType(requestIntent, intent.taskType)
  if (interpreted && interpreted !== 'chat') return interpreted
  if (intent.taskType && intent.taskType !== 'chat') return intent.taskType
  return [
    'read',
    'read_image',
    'glob',
    'grep',
    'web_search',
    'web_fetch',
    'cordis_inspect_list',
    'cordis_inspect_query',
    'kioku_read',
    'job_output',
    'job_list',
    'list_subagent_models',
  ].includes(name)
    ? 'research'
    : undefined
}
// Native inspection and session-local planning carry no project mutation authority.
const NATIVE_EVIDENCE_READS = new Set([
  'cordis_inspect_list',
  'cordis_inspect_query',
  'kioku_read',
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'job_output',
  'job_list',
  'list_subagent_models',
  'todo_write',
])
const UNOWNED_NATIVE_TOOLS = new Set([
  'cordis_inspect_list',
  'cordis_inspect_query',
  'kioku_read',
  'bash',
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'job_output',
  'job_list',
  'list_subagent_models',
  'todo_write',
  'skill',
])
function denied(reason: string): { kind: 'deny'; reason: string } {
  return { kind: 'deny', reason }
}
/** A protocol carrier, not JavaScript evaluation. Only this exact JSON-literal call is recognized. */
export function preparationCarrier(
  value: unknown,
): PreparationRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const args = value as Record<string, unknown>
  if (
    Object.keys(args).sort().join(',') !== 'code,description' ||
    typeof args.description !== 'string' ||
    !args.description.trim() ||
    typeof args.code !== 'string' ||
    args.code.length > 8192
  )
    return undefined
  const code = args.code.trim().replace(/;$/u, '')
  const prefix = 'return await tools.prepare_requested_work('
  if (!code.startsWith(prefix) || !code.endsWith(')')) return undefined
  try {
    const input = JSON.parse(code.slice(prefix.length, -1)) as unknown
    const parsed = parsePreparationRequest(input)
    if (!parsed || code !== prefix + JSON.stringify(input) + ')')
      return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Conversation entry and execution intake are distinct; neither this mode nor a type hint grants native permission. */
export class OnDemandIntake {
  private async diagnose(
    state: Turn,
    observation: Omit<IntakeDiagnosticObservation, 'context' | 'decision'>,
  ): Promise<void> {
    try {
      await this.host.diagnostic?.(state.input, {
        ...observation,
        ...(state.requestIntentContext
          ? { context: state.requestIntentContext }
          : {}),
        ...(state.requestIntent ? { decision: state.requestIntent } : {}),
      })
    } catch {
      /* Diagnostic loss cannot authorize or veto work. */
    }
  }
  readonly #turns = new Map<string, Turn>()
  readonly #clarificationContexts = new WeakMap<
    object,
    Map<string, ClarificationContext>
  >()
  readonly #clarifications = new Map<
    string,
    {
      agent: DemandAgent
      turn: number
      key: string
      status: 'waiting' | 'queued'
      result?: unknown
      operation?: Promise<unknown> | undefined
    }
  >()
  readonly #executions = new WeakMap<
    object,
    {
      turn: Turn
      execute: Definition['execute']
      carrier?: PreparationRequest
      carrierDigest?: string
      skillRead?: boolean
      evidenceReadDigest?: string
      requestPreparation?: boolean
      nativeUnownedDigest?: string
      nativeCommandDigest?: string
      nativeLispDigest?: string
    }
  >()
  readonly #executorTransports = new WeakMap<
    object,
    {
      definition: Definition
      runtime: { run: Definition['execute'] }
      current: () => unknown
    }
  >()
  readonly #disposers: (() => void)[] = []
  readonly #pending = new Set<Promise<unknown>>()
  readonly #controlTools = new Map<string, Definition['execute']>()
  readonly #controlExecutions = new WeakMap<
    object,
    {
      turn?: Turn
      execute: Definition['execute']
      digest: string
      invoke?: Definition['execute']
      args?: unknown
    }
  >()
  readonly #lifecycle = new AbortController()
  #tools?: NativeTools
  #startupSkillReader: Definition['execute'] | undefined
  #startupQuestionTool: Definition['execute'] | undefined
  readonly #questionTools = new WeakMap<
    DemandAgent,
    Definition['execute'] | undefined
  >()
  readonly #planTools = new WeakMap<
    DemandAgent,
    Definition['execute'] | undefined
  >()
  readonly #skillReaders = new WeakMap<
    DemandAgent,
    Definition['execute'] | undefined
  >()
  #stopped = false
  constructor(
    private readonly host: Dependencies,
    private readonly options: { onlyWhenDeferred?: boolean } = {},
  ) {}
  private recoveryCurrent(state:Turn):boolean {
    return !this.#stopped && !state.nativeSignal.aborted && state.input.agent.session===state.session
      && (!state.input.signal.aborted || state.recoveryAfterFinish===true)
      && this.#turns.get(state.input.agent.session?.id??'')===state && state.status!=='stale'
      && (state.status!=='closed'||state.recoveryAfterFinish===true)
  }
  private memoryCheck<T>(state:Turn,operation:(input:DemandInput)=>Promise<T>):Promise<T> {
    const signal=AbortSignal.any([state.input.signal,AbortSignal.timeout(1000)])
    return abortable(operation({...state.input,signal}),signal)
  }
  private async deferMemory(state:Turn):Promise<void> {
    this.assertCurrent(state)
    await this.host.validate(state.input)
    state.memoryDeferred=true;state.answerContextReady=false
    this.host.answerContext?.retire(state.input.agent)
    const source={sessionId:state.input.agent.session!.id,turn:state.input.turn,origin:'answer-context' as const,
      sourceDigest:canonicalContentHash(state.task),contextDigest:canonicalContentHash(state.input.messages)}
    state.auxiliaryReceipt=await this.host.recovery?.defer({source,current:()=>this.recoveryCurrent(state),
      check:async signal=>{
        await this.host.validate({...state.input,signal})
        await this.host.answerContext?.prepare({...state.input,signal},state.task,state.intent.taskType??null,state.memoryOwner)
        signal.throwIfAborted()
        return {state:'verified',reason:'memory_rechecked'}
      },verified:()=>{if(this.recoveryCurrent(state)){state.memoryDeferred=false;state.answerContextReady=this.host.answerContext!==undefined}}
    },'memory_unavailable')??{storage:'unavailable',state:'pending',workMayContinue:true,memoryAdopted:false}
  }
  private async deferAssessment(state:Turn,context:RequestIntentContext,decision:RequestIntentDecision,digest:string):Promise<void> {
    let verified:IntentAssessment|undefined
    state.auxiliaryReceipt=await this.host.recovery?.defer({source:{sessionId:state.input.agent.session!.id,turn:state.input.turn,
      origin:'intent-assessment',sourceDigest:canonicalContentHash(state.task),contextDigest:digest},
      current:()=>this.recoveryCurrent(state)&&state.assessment?.digest===digest&&canonicalContentHash([state.requestIntentContext,decision])===digest,
      check:async(signal,attempt)=>{
        await this.host.validate({...state.input,signal})
        const result=await this.host.assess?.({...state.input,signal},context,decision,attempt)
        signal.throwIfAborted()
        if(!result)return {state:'rejected',reason:'assessment_disabled'}
        if(result.outcome==='consistent'){verified=result;return {state:'verified',reason:'semantic_rechecked'}}
        return {state:result.semantic==='contradicted'?'rejected':'retry_wait',reason:result.semantic==='contradicted'?'semantic_contradicted':'assessment_unresolved'}
      },verified:async()=>{
        if(verified&&this.recoveryCurrent(state)&&state.assessment?.digest===digest&&canonicalContentHash([state.requestIntentContext,decision])===digest){
          state.assessment={digest,result:verified};await this.diagnose(state,{kind:'assessment',assessment:verified})
        }
      }},'assessment_unresolved')??{storage:'unavailable',state:'pending',workMayContinue:true,memoryAdopted:false}
  }
  /** Exact host-owned implementations, never a name-only execution bypass. */
  registerControlTool(definition: Definition): () => void {
    this.#controlTools.set(definition.name, definition.execute)
    return () => {
      if (this.#controlTools.get(definition.name) === definition.execute)
        this.#controlTools.delete(definition.name)
    }
  }
  isControl(execution: Execution): boolean {
    const proof = this.#controlExecutions.get(execution)
    return (
      !this.#stopped &&
      !execution.signal.aborted &&
      !!proof &&
      (!proof.turn ||
        (this.bound(execution) === proof.turn &&
          !proof.turn.input.signal.aborted &&
          !['closed', 'stale'].includes(proof.turn.status))) &&
      this.definition(execution)?.execute === proof.execute &&
      canonicalContentHash(execution.arguments) === proof.digest &&
      (proof.invoke
        ? [...this.#controlTools].some(
            ([name, invoke]) =>
              invoke === proof.invoke &&
              this.#tools?.get(name, execution.agent)?.execute === invoke,
          )
        : this.#controlTools.get(execution.name) === proof.execute ||
          this.conversationControl(execution, this.definition(execution)!))
    )
  }
  controlTask(execution: Execution): string | undefined {
    return this.isControl(execution)
      ? this.#controlExecutions.get(execution)?.turn?.task
      : undefined
  }
  /** Observational/conversational calls still traverse native policy; never grant effect authority. */
  private conversationControl(
    execution: Execution,
    actual: Definition,
  ): boolean {
    const state = this.bound(execution)
    return (
      !!state &&
      state.status === 'answer' &&
      execution.parent === undefined &&
      ((execution.name === 'ask_user_question' &&
        actual.execute === this.#questionTools.get(state.input.agent)) ||
        (execution.name === 'exit_plan_mode' &&
          actual.execute === this.#planTools.get(state.input.agent)) ||
        isCodingWorkflowStatus(actual, execution.arguments))
    )
  }
  private controlCall(
    execution: Execution,
    actual: Definition,
  ):
    | {
        execute: Definition['execute']
        digest: string
        invoke?: Definition['execute']
        args?: unknown
      }
    | undefined {
    if (
      this.#controlTools.get(execution.name) === actual.execute ||
      this.conversationControl(execution, actual)
    )
      return {
        execute: actual.execute,
        digest: canonicalContentHash(execution.arguments),
      }
    if (
      execution.name !== 'run_code' ||
      !execution.arguments ||
      typeof execution.arguments !== 'object' ||
      Array.isArray(execution.arguments)
    )
      return undefined
    const value = execution.arguments as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'code,description' ||
      typeof value.code !== 'string' ||
      value.code.length > 8192 ||
      typeof value.description !== 'string' ||
      !value.description.trim()
    )
      return undefined
    const code = value.code.trim().replace(/;$/u, '')
    for (const [name, invoke] of this.#controlTools) {
      if (this.#tools?.get(name, execution.agent)?.execute !== invoke) continue
      const prefix = `return await tools.${name}(`
      if (!code.startsWith(prefix) || !code.endsWith(')')) continue
      try {
        const args: unknown = JSON.parse(code.slice(prefix.length, -1))
        if (code === prefix + JSON.stringify(args) + ')')
          return {
            execute: actual.execute,
            digest: canonicalContentHash(execution.arguments),
            invoke,
            args,
          }
      } catch {
        /* Nonliteral programs keep ordinary execution admission. */
      }
    }
    return undefined
  }
  private watch<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise)
    void promise.then(
      () => this.#pending.delete(promise),
      () => this.#pending.delete(promise),
    )
    return promise
  }
  /** True only while the previous turn has no matching turn/end in the session log. */
  private turnIsOpen(state: Turn): boolean {
    const events = state.input.agent.session?.snapshotEvents?.() ?? []
    return !events.some(
      (event) =>
        event.type === 'turn/end' && eventTurn(event) === state.input.turn,
    )
  }
  private existingTurn(execution: Execution): number | undefined {
    const last = execution.agent?.session
      ?.snapshotEvents?.()
      .filter(
        (event) => event.type === 'turn/start' || event.type === 'turn/end',
      )
      .at(-1)
    return last?.type === 'turn/start' ? eventTurn(last) : undefined
  }
  private acknowledgeExisting(state: Turn): void {
    this.assertCurrent(state)
    state.existing = true
    state.status = 'prepared'
    const taskType = requestIntentTaskType(
      state.requestIntent,
      state.intent.taskType,
    )
    if (taskType !== undefined) state.taskType = taskType
    state.preparedIntentDigest = canonicalContentHash({
      taskType: state.taskType ?? null,
      requestIntent: state.requestIntent ?? null,
    })
  }

  /** Availability only: never capture a turn or publish execution intent before turn/start. */
  async prepareNativeCapabilities(input: DemandInput): Promise<void> {
    if (!this.host.prepareNativeCoding) return
    input = {
      ...input,
      signal: AbortSignal.any([input.signal, this.#lifecycle.signal]),
    }
    input.signal.throwIfAborted()
    const task = humanTask(input.messages)
    if (!task) return
    // These are genuine queued-message references, used only for the advisory
    // Lisp choice. capture() later obtains the current source-bound context.
    const context = createRequestIntentContext({
      task,
      messageRefs: requestIntentMessageRefs(input.messages, task),
    })
    try {
      await this.host.prepareNativeCoding(input, task, context)
    } catch (error) {
      input.signal.throwIfAborted()
      // The Lisp choice retains cancellation. The actual turn consumes it
      // through capture(), so Stop closes that turn and keeps unrelated input.
      if ((error as { code?: unknown })?.code !== 'ASK_CANCELLED') throw error
    }
  }

  /** True means ordinary text may continue; false leaves an existing execution on its original path. */
  async capture(input: DemandInput): Promise<boolean> {
    input.signal.throwIfAborted()
    if (!this.#stopped && this.host.nativeChild?.(input.agent)) return false
    if (
      this.#stopped ||
      !input.agent.session ||
      !Number.isSafeInteger(input.turn) ||
      input.turn < 1
    )
      throw new Error('Invalid on-demand intake identity')
    input = {
      ...input,
      signal: AbortSignal.any([input.signal, this.#lifecycle.signal]),
    }
    const sessionId = input.agent.session!.id
    this.host.recovery?.active(sessionId)
    const previous = this.#turns.get(sessionId)
    if (previous) {
      if (
        previous.input.agent !== input.agent ||
        previous.input.agent.session !== input.agent.session ||
        input.turn < previous.input.turn
      )
        throw new Error('Stale on-demand intake identity')
      if (previous.input.turn === input.turn) {
        if (previous.status === 'closed')
          throw new Error('On-demand turn is closed')
        const fresh = humanMessages(input.messages).filter(
          (message) =>
            previous.humanContents.get(humanId(message)) !==
            canonicalContentHash(message),
        )
        if (!fresh.length) {
          if (previous.capture && !(await previous.capture)) return false
          if (previous.status === 'stale')
            throw (
              previous.captureError ??
              new Error('Previous on-demand request is stale')
            )
          return previous.status !== 'prepared'
        }
        previous.status = 'stale'
        previous.controller.abort(new Error('Human instructions changed'))
        // A new native batch can contain only the steering message. Preserve
        // the original request while replacing changed messages by identity.
        const merged = new Map(
          previous.input.messages.map((message) => [humanId(message), message]),
        )
        for (const message of input.messages)
          merged.set(humanId(message), message)
        input = { ...input, messages: [...merged.values()] }
      }
      if (
        previous.input.turn !== input.turn &&
        !humanMessages(input.messages).length &&
        this.host.ready(input.agent)
      ) {
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
      // A superseded capture is only a live turn while its own boundary stays open.
      // Once turn/end exists for it, the host has finished that turn; its failure
      // must not refuse every later human request for the rest of the session.
      if (
        previous.input.turn !== input.turn &&
        !['closed', 'prepared'].includes(previous.status) &&
        this.turnIsOpen(previous)
      )
        throw new Error('Previous on-demand turn has not ended')
      previous.controller.abort(
        new Error('A newer native turn superseded this request'),
      )
    } else if (
      !humanMessages(input.messages).length &&
      this.host.ready(input.agent)
    ) {
      await this.host.validate(input)
      input.signal.throwIfAborted()
      await this.host.advance?.(input)
      return false
    }
    this.host.answerContext?.retire(input.agent)
    // Install the pending state synchronously, before any host or classifier awaits.
    const controller = new AbortController()
    const state: Turn = {
      session: input.agent.session!, nativeSignal: input.signal,
      input: {
        ...input,
        signal: AbortSignal.any([input.signal, controller.signal]),
        messages: Object.freeze(structuredClone([...input.messages])),
      },
      task: humanTask(input.messages),
      humanContents: new Map(
        humanMessages(input.messages).map((message) => [
          humanId(message),
          canonicalContentHash(message),
        ]),
      ),
      status: 'capturing',
      intent: { deferInference: true },
      memoryOwner: 'none',
      preparationCalls: new Set(),
      controller,
    }
    this.#turns.set(sessionId, state)
    rememberLispConversation(
      input.agent,
      () =>
        !this.options.onlyWhenDeferred &&
        !this.#stopped &&
        this.#turns.get(sessionId) === state &&
        state.status === 'answer' &&
        !state.input.signal.aborted &&
        this.host.nativeChild?.(input.agent) !== true,
    )
    const promise = (async () => {
      await this.host.validate(input)
      this.assertCurrent(state)
      // Presets and later host plugins register readers after mount. Pin the
      // validated owner's first reader once, including absence; never rebind it.
      if (!this.#skillReaders.has(input.agent))
        this.#skillReaders.set(
          input.agent,
          this.#startupSkillReader ??
            this.#tools?.get('skill', input.agent)?.execute,
        )
      if (!this.#questionTools.has(input.agent))
        this.#questionTools.set(
          input.agent,
          this.#startupQuestionTool ??
            this.#tools?.get('ask_user_question', input.agent)?.execute,
        )
      if (!this.#planTools.has(input.agent))
        this.#planTools.set(
          input.agent,
          this.#tools?.get('exit_plan_mode', input.agent)?.execute,
        )
      if (!humanMessages(input.messages).length)
        throw new Error(
          'Original human input is required before on-demand intake',
        )
      // Native authority is independent of optional memory, Skills and model
      // classification. Never manufacture an owned task merely to run Bash.
      if (
        !this.options.onlyWhenDeferred &&
        (await this.host.nativeOwnership?.(state.input)) === 'unowned'
      ) {
        this.assertCurrent(state)
        const context =
          (await this.host.requestContext?.(state.input, state.task)) ??
          createRequestIntentContext({
            task: state.task,
            messageRefs: requestIntentMessageRefs(
              state.input.messages,
              state.task,
            ),
          })
        this.assertCurrent(state)
        await this.host.prepareNativeCoding?.(state.input, state.task, context)
        this.assertCurrent(state)
        state.nativeUnowned = true
        if (context) {
          state.requestIntentContext = context
          state.requestIntentContextDigest = canonicalContentHash(context)
          state.requestIntent = unresolvedRequestIntent(
            context,
            'native_unowned_request',
          )
        }
        state.status = 'answer'
        await this.diagnose(state, { kind: 'native_unowned' })
        await this.diagnose(state, { kind: 'resume' })
        return true
      }
      if(this.host.prepareNativeCoding){
        const context=await this.host.requestContext?.(state.input,state.task)
          ?? createRequestIntentContext({task:state.task,messageRefs:requestIntentMessageRefs(state.input.messages,state.task)})
        this.assertCurrent(state)
        await this.host.prepareNativeCoding(state.input,state.task,context)
        this.assertCurrent(state)
      }
      try {
        state.intent = await this.host.classify(input, state.task)
      } catch {
        input.signal.throwIfAborted()
        state.intent = { deferInference: true }
      }
      try {
        const interpreted = await this.host.interpret?.(state.input, state.task)
        if (interpreted) {
          state.requestIntentContext = interpreted.context
          state.requestIntent = interpreted.decision
          state.requestIntentContextDigest = canonicalContentHash(
            interpreted.context,
          )
        }
      } catch (error) {
        input.signal.throwIfAborted()
      }
      const pendingClarification = this.#clarifications.get(sessionId)
      await this.diagnose(state, { kind: 'interpretation' })
      await this.diagnose(state, { kind: 'resume' })
      if (
        pendingClarification?.agent === input.agent &&
        state.requestIntent &&
        !requestIntentIsUnresolved(state.requestIntent) &&
        !executionClarification(
          state.task,
          state.requestIntent,
          state.requestIntentContext,
        )
      )
        this.#clarifications.delete(sessionId)
      state.memoryOwner = memoryOwnerKind(
        state.requestIntent,
        state.intent.taskType,
      )
      this.assertCurrent(state)
      if (previous?.input.turn !== input.turn)
        await this.host.advance?.(input, state.requestIntent)
      this.assertCurrent(state)
      const resumeConfirmation =
        previous?.input.turn !== input.turn && state.task
          ? ((await this.host.resumeConfirmation?.(input)) ?? false)
          : false
      if (
        process.env.KIOKUKO_INTENT_DEBUG === '1' &&
        previous?.input.turn !== input.turn
      ) {
        console.error('on-demand confirmation route', {
          turn: input.turn,
          previousTurn: previous?.input.turn,
          hasTask: state.task.length > 0,
          resumeConfirmation,
        })
      }
      if (resumeConfirmation) {
        this.assertCurrent(state)
        state.confirmationResume = true
        state.status = 'answer'
        if (previous?.taskType !== undefined) state.taskType = previous.taskType
        this.host.answerContext?.retire(input.agent)
        return false
      }
      if (
        process.env.KIOKUKO_INTENT_DEBUG === '1' &&
        previous?.input.turn !== input.turn &&
        state.task &&
        this.host.resumeConfirmation
      ) {
        console.error(
          'confirmation resume not selected',
          input.turn,
          state.task.length,
        )
      }
      if (state.task && (await this.host.replay?.(state.input))) {
        this.acknowledgeExisting(state)
        return false
      }
      const assessmentConsistent =
        state.requestIntent && state.requestIntent.action !== 'answer'
          ? await this.assess(state, state.requestIntent)
          : true
      const canContinue =
        assessmentConsistent &&
        state.requestIntent?.relation === 'same_scope_continuation' &&
        !requestIntentIsUnresolved(state.requestIntent) &&
        state.requestIntent.action !== 'answer'
      if (
        previous?.input.turn !== input.turn &&
        state.task &&
        canContinue &&
        (await this.host.existing(input, state.requestIntent))
      ) {
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
      const requestIntentUnresolved =
        state.requestIntent !== undefined &&
        requestIntentIsUnresolved(state.requestIntent)
      const requestAsAnswer = state.requestIntent?.action === 'answer'
      const knownIntent =
        this.host.interpret === undefined
          ? !state.intent.deferInference &&
            state.intent.taskType !== undefined &&
            state.intent.taskType !== 'chat'
          : state.requestIntent !== undefined &&
            !requestIntentUnresolved &&
            !requestAsAnswer &&
            state.requestIntent.relation !== 'unknown' &&
            state.requestIntent.action !== 'unknown'
      const missingExecutionDetail =
        executionClarification(
          state.task,
          state.requestIntent,
          state.requestIntentContext,
        ) ||
        (state.requestIntentContext?.activeTask &&
          !taskCanExecute(state.requestIntentContext.activeTask))
      if (
        this.options.onlyWhenDeferred &&
        knownIntent &&
        !missingExecutionDetail &&
        assessmentConsistent
      ) {
        this.#turns.delete(sessionId)
        state.status = 'closed'
        controller.abort(
          new Error('Known intent continues through eager admission'),
        )
        return false
      }
      // The current request is on the conversational path until actual admission.
      // Provisional intent cannot select a different run's memory validator.
      state.memoryOwner = 'conversation'
      try { await this.memoryCheck(state, input=>this.host.answerContext?.prepare(
        input,
        state.task,
        state.intent.taskType ?? null,
        state.memoryOwner,
      )??Promise.resolve())
      state.answerContextReady = this.host.answerContext !== undefined
      } catch {state.input.signal.throwIfAborted();await this.deferMemory(state)}
      this.assertCurrent(state)
      state.status = 'answer'
      return true
    })()
    this.watch(promise)
    state.capture = promise
    try {
      return await promise
    } catch (error) {
      if (this.#turns.get(sessionId) === state) {
        const cancelled =
          (error as { code?: unknown })?.code === 'ASK_CANCELLED'
        state.status = cancelled ? 'closed' : 'stale'
        state.captureError = error
        // DSH classifies cancellation from its own turn signal, not error.code.
        // Abort only this current attempt and preserve unrelated queued input.
        if (cancelled && !input.signal.aborted)
          input.agent.cancel?.({ kind: 'user' }, { keepInbox: true })
      }
      throw error
    } finally {
      delete state.capture
    }
  }
  private assertCurrent(state: Turn): void {
    state.input.signal.throwIfAborted()
    if (
      this.#stopped ||
      this.#turns.get(state.input.agent.session!.id) !== state ||
      ['closed', 'stale'].includes(state.status)
    )
      throw new Error('On-demand request changed or closed')
  }
  private bound(execution: Execution): Turn | undefined {
    const agent = execution.agent,
      state = agent?.session && this.#turns.get(agent.session.id)
    if (
      !state ||
      state.input.agent !== agent ||
      state.input.agent.session !== agent.session
    )
      return undefined
    if (state.existing && this.existingTurn(execution) !== state.input.turn)
      return undefined
    const starts = agent.session
      .snapshotEvents?.()
      .filter((event) => event.type === 'turn/start')
    const latest = eventTurn(starts?.at(-1))
    if (latest !== undefined && latest !== state.input.turn) return undefined
    return state
  }
  private ownerIdentity(state: Turn): MemoryOwnerIdentity {
    const session = state.input.agent.session!
    return {
      agentId: state.input.agent.id,
      sessionId: session.id,
      turn: state.input.turn,
      requestDigest: canonicalContentHash(state.task),
    }
  }
  private definition(execution: Execution): Definition | undefined {
    try {
      const registered = this.#tools?.get(execution.name, execution.agent)
      if (registered) return registered
      const transport = this.#executorTransports.get(execution)
      return transport &&
        transport.current() === transport.runtime &&
        transport.runtime.run === transport.definition.execute
        ? transport.definition
        : undefined
    } catch {
      return undefined
    }
  }
  /** Bind a reserved PTC transport only after its actual provider projects it.
   * The runtime function is an identity check; dispatch still belongs to DSH.
   * A native or missing executor cannot obtain a preparation-only carrier here. */
  private async bindExecutorTransport(
    execution: Execution,
    context: { get?(name: string, required?: boolean): any },
  ): Promise<void> {
    if (
      execution.name !== 'run_code' ||
      execution.parent !== undefined ||
      typeof execution.token !== 'symbol' ||
      typeof this.#tools?.setExecutor !== 'function' ||
      !context.get
    )
      return
    // Cordis returns fresh contextual proxies; compare the underlying service,
    // never invoke it outside the selected executor's dispatch.
    const owner = execution.agent?.ctx as
      { get?(name: string, required?: boolean): any } | undefined
    const services = typeof owner?.get === 'function' ? owner : context
    const current = () => {
      const value = services.get!('ptcRuntime', false)
      return value?.[symbols.original] ?? value
    }
    const runtime = current(),
      prompt = services.get!('systemPrompt', false)
    if (
      typeof runtime?.run !== 'function' ||
      typeof prompt?.assemble !== 'function'
    )
      return
    const projected = await prompt.assemble({
      scope: execution.agent,
      agent: execution.agent,
    })
    execution.signal.throwIfAborted()
    if (
      current() !== runtime ||
      projected.tools.length !== 1 ||
      projected.tools[0]?.name !== 'run_code' ||
      !projected.sections.some(
        (section: { name: string }) => section.name === 'tools:sdk',
      )
    )
      return
    this.#executorTransports.set(execution, {
      definition: { name: 'run_code', execute: runtime.run },
      runtime,
      current,
    })
  }
  private async assess(
    state: Turn,
    decision: RequestIntentDecision | undefined,
  ): Promise<boolean> {
    if (
      !this.host.assess ||
      decision?.action === 'answer' ||
      decision?.action === 'research' ||
      requestIntentIsUnresolved(decision)
    )
      return true
    if (!decision || !state.requestIntentContext)
      throw new RequestClarification(
        'The source or candidate is unresolved',
        true,
      )
    const context = state.requestIntentContext,
      digest = canonicalContentHash([context, decision])
    if (
      state.assessment?.digest !== digest ||
      (state.assessment.result.outcome === 'unavailable' && !this.host.recovery)
    ) {
      let result:IntentAssessment|undefined
      const started=performance.now(),deadline=AbortSignal.timeout(1500)
      const signal=AbortSignal.any([state.input.signal,deadline])
      try {result=await abortable(this.host.assess({...state.input,signal},context,decision),signal)}
      catch {state.input.signal.throwIfAborted();result={semantic:'unavailable',semanticInputDigest:canonicalContentHash([context,decision]),
        detector:{state:'unavailable',reason:deadline.aborted?'timeout':'process_failed',elapsedMs:Math.ceil(performance.now()-started)},outcome:'unavailable'}}
      this.assertCurrent(state)
      if (!result) {
        await this.diagnose(state, { kind: 'assessment_disabled' })
        return true
      } // Explicit mode=off: no detector verdict or new authority.
      if (
        canonicalContentHash([state.requestIntentContext, decision]) !== digest
      )
        throw new Error('Assessment source changed')
      state.assessment = { digest, result }
      await this.diagnose(state, { kind: 'assessment', assessment: result })
      if(result.outcome!=='consistent')await this.deferAssessment(state,context,decision,digest)
    }
    return state.assessment!.result.outcome === 'consistent'
  }
  private async prepare(
    state: Turn,
    taskType: TaskType,
    signal: AbortSignal,
    requestIntent?: RequestIntentDecision,
    explicitIntent = false,
  ): Promise<void> {
    this.assertCurrent(state)
    signal.throwIfAborted()
    if (state.selectionPending) throw new ExecutionSelectionPending()
    const resolved = requestIntent ?? state.requestIntent
    try {
      await this.host.diagnostic?.(state.input, {
        kind: 'interpretation',
        ...(state.requestIntentContext
          ? { context: state.requestIntentContext }
          : {}),
        ...(resolved ? { decision: resolved } : {}),
      })
    } catch {
      /* Advisory only. */
    }
    if (resolved?.action === 'change' && resolved.changeScope === 'unknown') {
      throw new RequestClarification(
        'The requested change scope is unresolved. Specify implementation or document using the current request evidence before preparing work.',
      )
    }
    if (
      resolved &&
      requestIntentIsUnresolved(resolved) &&
      (state.requestIntentContext?.activeGoal ||
        state.requestIntentContext?.activeTask)
    ) {
      throw new RequestClarification(
        'Clarify the request before preparing work',
      )
    }
    if (!(await this.assess(state, resolved)))
      throw new RequestClarification(
        'Independent source comparison or finite-domain verification requires clarification',
        true,
        false,
        resolved,
      )
    const activeTask = state.requestIntentContext?.activeTask
    if (
      activeTask &&
      resolved?.relation === 'same_scope_continuation' &&
      !taskCanExecute(activeTask) &&
      !resolved.taskOperation
    ) {
      throw new RequestClarification(
        'The current task requires an explicit user-selected state operation before execution.',
      )
    }
    const clarification = executionClarification(
      state.task,
      resolved,
      state.requestIntentContext,
    )
    if (clarification) throw new RequestClarification(clarification)
    if (!ACTION_TYPES.includes(taskType))
      throw new Error(
        'Answer conversational questions directly; prepare_requested_work is for requested work',
      )
    if (
      state.status === 'prepared' &&
      state.confirmationResume &&
      explicitIntent &&
      (state.requestIntent?.relation === 'unknown' ||
        state.requestIntent?.action === 'unknown')
    )
      state.status = 'answer'
    if (state.status === 'prepared') {
      if (state.taskType !== taskType)
        throw requestInterpretationError(
          'Prepared intent cannot be replaced within a turn',
          state.requestIntent,
          state.requestIntentContext,
          true,
        )
      if (
        explicitIntent &&
        state.preparedIntentDigest !==
          canonicalContentHash({
            taskType,
            requestIntent: requestIntent ?? null,
          })
      ) {
        throw requestInterpretationError(
          'Prepared interpretation cannot be replaced within a turn',
          state.requestIntent,
          state.requestIntentContext,
          true,
        )
      }
      return
    }
    if (state.preparation) {
      await state.preparation
      this.assertCurrent(state)
      return
    }
    state.nativeUnowned = false
    state.status = 'preparing'
    state.taskType = taskType
    const operation = (async () => {
      // Retain exact original messages. The only caller-supplied input is an advisory task type.
      const admitted = await this.host.prepare(
        {
          ...state.input,
          signal: AbortSignal.any([state.input.signal, signal]),
        },
        taskType,
        requestIntent ?? state.requestIntent,
        state.requestIntentContext,
      )
      this.assertCurrent(state)
      signal.throwIfAborted()
      if (!admitted || !this.host.ready(state.input.agent, state.input.turn))
        throw new Error(
          'Execution preparation did not admit this exact request',
        )
      const preparedIntent = requestIntent ?? state.requestIntent
      if (preparedIntent !== undefined) state.requestIntent = preparedIntent
      state.preparedIntentDigest = canonicalContentHash({
        taskType,
        requestIntent: state.requestIntent ?? null,
      })
      state.status = 'prepared'
      this.#clarifications.delete(state.input.agent.session!.id)
      delete state.confirmationResume
    })()
    this.watch(operation)
    state.preparation = operation
    try {
      await operation
    } catch (error) {
      if (!['closed', 'stale'].includes(state.status)) {
        // A declined selection preserves this request for a conversational acknowledgement.
        // It is not admission: preparation remains consumed and tools still need a ready host.
        state.selectionPending =
          error instanceof ExecutionSelectionPending &&
          !state.input.signal.aborted &&
          !signal.aborted
        // Preparation failure is not a change of human authority. Keep the
        // captured request retryable, but never revive Stop/cancellation. A
        // new call must pass host admission and native permission checks again.
        state.status =
          state.input.signal.aborted || signal.aborted || this.#stopped
            ? 'stale'
            : 'answer'
        delete state.preparedIntentDigest
        delete state.taskType
        state.memoryOwner = 'none'
      }
      throw error
    } finally {
      delete state.preparation
    }
  }
  /** A question is a waiting state, never an execution grant. */
  awaitingClarification(agent: DemandAgent): boolean {
    const pending = agent.session && this.#clarifications.get(agent.session.id)
    if (this.#stopped || pending?.agent !== agent) return false
    const boundary = agent.session
      ?.snapshotEvents?.()
      .filter((event) => event.type === 'turn/end')
      .at(-1)
    const data = boundary?.data as
      { turn?: number; reason?: { kind?: string } } | undefined
    if (
      data?.turn !== undefined &&
      data.turn >= pending.turn &&
      ['aborted', 'error', 'max-tokens', 'blocked'].includes(
        data.reason?.kind ?? '',
      )
    ) {
      this.#clarifications.delete(agent.session!.id)
      return false
    }
    return true
  }
  private async clarify(
    state: Turn,
    executionSignal: AbortSignal,
    reason: RequestClarification,
  ): Promise<unknown> {
    this.assertCurrent(state)
    const signal = AbortSignal.any([
      executionSignal,
      state.input.signal,
      state.controller.signal,
    ])
    const context = state.requestIntentContext
    const sessionId = state.input.agent.session!.id
    // Compose from the decision the caller actually bound. Falling back to
    // state.requestIntent alone can read a stale 'unknown' action after an
    // explicit action was supplied, fabricating a target nobody omitted.
    const decision = reason.candidate ?? state.requestIntent
    // An established answer already states the requested action. Converting it
    // into a question asks the human to restate what they just said, and the
    // queued reply changes the dedupe key, so the same question repeats.
    if (decision?.action === 'answer' && !requestIntentIsUnresolved(decision)) {
      if (state.status === 'answer' && !state.existing)
        state.requestIntent = decision
      return {
        prepared: false,
        status: 'answer_directly',
        originalTask: state.task,
        requestIntent: decision,
        currentReferences: context
          ? requestIntentRequiredReferenceIds(context)
          : [],
        permissions: 'unchanged_native_policy',
        nextAction: 'answer_directly',
        detail:
          'No execution workflow is prepared for this answer. Answer from the captured request and current evidence. Native read/search tools remain available under their existing permissions; use the selected Lisp route where required. Collect missing evidence without asking the human to repeat an established action or target. This result grants no change or command authority.',
      }
    }
    const scope =
      (decision?.action === 'change' && decision.changeScope === 'unknown') ||
      reason.message.startsWith('The requested change scope')
    const target = !!executionClarification(state.task, decision, context)
    const transition =
      context?.activeTask && !taskCanExecute(context.activeTask)
    const question = reason.assessment
      ? '現在の依頼と実行候補の対象・操作・制約を照合できませんでした。今回の対象と希望する操作、以前の指示を変更する範囲を教えてください。'
      : transition
        ? `現在のタスクは ${context!.activeTask!.state} です。続けるために、どの操作を希望しますか？（${taskAllowedOperations(context!.activeTask!).join(' / ')}）`
        : target
          ? 'どの具体的なファイル・項目・相手・操作を対象にしますか？'
          : scope
            ? '変更するのは文章だけですか、それともコード・テスト・設定も含みますか？'
            : decision?.action === 'unknown'
              ? 'その対象に、具体的に何をしてほしいですか？'
              : null
    // Internal relationship classification belongs to the model. An unresolved
    // classifier is not evidence that the human omitted an action or target.
    if (reason.interpretation || question === null)
      return {
        prepared: false,
        status: 'request_interpretation_required',
        originalTask: state.task,
        requestInterpretation: requestInterpretationRecovery(
          reason.candidate ?? state.requestIntent,
          context,
        ),
        currentReferences: context
          ? requestIntentRequiredReferenceIds(context)
          : [],
        permissions: 'unchanged_native_policy',
        nextAction: 'submit_current_request_intent',
        detail:
          'Interpret the captured user request and current host references in the main model. A taskType label alone is not an action or approval. Ask the human only if the action or referenced target is actually unclear.',
      }
    if (
      reason.assessment &&
      state.assessment?.result.outcome === 'unavailable'
    ) {
      const a = state.assessment.result
      return {
        prepared: false,
        status: 'assessment_unavailable',
        semantic: a.semantic,
        semanticChecks: a.semanticChecks ?? [],
        detector:
          a.detector.state === 'unavailable'
            ? a.detector.reason
            : a.detector.result.status,
        originalTask: state.task,
        permissions: 'unchanged_native_policy',
        preparedExecutionAllowed: false,
        nextAction: 'report_assessment_unavailable',
        recovery:
          'Preserve the request and report the unavailable assessment. Do not repeat clarification, claim preparation succeeded, or switch tools to bypass this preparation boundary.',
        detail:
          '原文照合または有限領域検査を利用できません。実行は準備されていません。',
      }
    }
    // An inconclusive detector is not evidence that the human omitted a target.
    // Return the submitted interpretation for repair; keep preparation denied.
    if (
      reason.assessment &&
      state.assessment?.result.semantic === 'insufficient' &&
      reason.candidate
    ) {
      const assessment = state.assessment.result
      const issues = assessment.semanticIssues ?? []
      const unresolved = assessment.semanticChecks?.filter(check => issues.includes(check.criterion)) ?? []
      const providerUncertain = issues.length > 0 && unresolved.length === issues.length && unresolved.every(check =>
        check.status === 'abstained' && (check.reason === 'uncertain' || check.reason === 'tie'))
      return {
        prepared: false,
        status: 'assessment_rejected',
        semantic: state.assessment.result.semantic,
        semanticIssues: state.assessment.result.semanticIssues ?? [],
        semanticChecks: assessment.semanticChecks ?? [],
        originalTask: state.task,
        requestIntent: reason.candidate,
        currentReferences: context
          ? requestIntentRequiredReferenceIds(context)
          : [],
        availableReferences: context ? requestIntentReferenceIds(context) : [],
        permissions: 'unchanged_native_policy',
        nextAction: providerUncertain ? 'report_assessment_uncertainty' : 'revise_request_intent_or_report_conflict',
        detail: providerUncertain
          ? 'The independent provider abstained because of confidence or tied choices. This does not establish ambiguity in the user request or an incorrect candidate. Preserve the request and candidate and report the unresolved provider assessment. Do not resubmit an identical candidate, change its meaning merely to obtain acceptance, ask the human for internal classification fields, or bypass preparation. No work is prepared.'
          : 'The independent comparison did not establish the submitted candidate. Re-read the captured request, answers, active task and same-session plan. Cite an existing proposal only when the request adopts it. Correct the candidate or report the specific unresolved comparison; do not repeat an identical submission or ask the human to supply internal classification fields. Ask a concrete question only if the source itself leaves an action or target ambiguous. No work is prepared.',
      }
    }
    const replies =
      this.#clarificationContexts.get(state.input.agent) ??
      new Map<string, ClarificationContext>()
    const clarification = collectClarificationContext(
      humanMessages(state.input.messages).map((message) => ({
        id: humanId(message),
        text: humanTask([message]),
      })),
      replies,
    )
    const answerScope = canonicalContentHash({
      activeTask: context?.activeTask ?? null,
      activeGoal: context?.activeGoal ?? null,
      proposals: context?.proposals ?? [],
    })
    const answered = reusableClarificationAnswer(
      clarification,
      question,
      answerScope,
    )
    if (answered) this.#clarifications.delete(sessionId)
    if (answered && reason.assessment)
      return {
        prepared: false,
        status: 'assessment_rejected',
        semantic: state.assessment?.result.semantic,
        semanticIssues: state.assessment?.result.semanticIssues ?? [],
        semanticChecks: state.assessment?.result.semanticChecks ?? [],
        detector:
          state.assessment?.result.detector.state === 'available'
            ? state.assessment.result.detector.result.status
            : state.assessment?.result.detector.reason,
        originalTask: state.task,
        currentReferences: context
          ? requestIntentRequiredReferenceIds(context)
          : [],
        permissions: 'unchanged_native_policy',
        nextAction: 'revise_request_intent_or_report_conflict',
        detail:
          'The current candidate still conflicts with, or is not established by, the source including the latest answer. Revise the candidate using that answer or explain the specific unresolved conflict. Do not repeat an identical submission or the answered question.',
      }
    if (answered)
      return {
        prepared: false,
        status: 'clarification_answer_available',
        question,
        questionId: answered.questionId,
        answer: answered.value,
        originalTask: clarification.sources
          .map((source) => source.text)
          .join('\n'),
        permissions: 'unchanged_native_policy',
        currentReferences: context
          ? requestIntentRequiredReferenceIds(context)
          : [],
        nextAction: 'submit_current_request_intent',
      }
    const key = canonicalContentHash({
      context: context ?? null,
      task: state.task,
      humanEvidence: [...state.humanContents],
      question,
    })
    const previous = this.#clarifications.get(sessionId)
    if (previous?.agent === state.input.agent && previous.key === key)
      return previous.operation ?? previous.result
    const id = `request-clarification-${key.slice(0, 20)}`
    const result = {
      prepared: false,
      status: 'awaiting_clarification',
      question,
      questionId: id,
      originalTask: state.task,
      ...(requestIntentIsUnresolved(state.requestIntent)
        ? {
            requestInterpretation: requestInterpretationRecovery(
              state.requestIntent,
              context,
            ),
          }
        : {}),
      ...(reason.assessment
        ? {
            semantic: state.assessment?.result.semantic,
            semanticIssues: state.assessment?.result.semanticIssues ?? [],
            semanticChecks: state.assessment?.result.semanticChecks ?? [],
          }
        : {}),
      permissions: 'unchanged_native_policy',
      nextAction: this.host.questions ? 'wait_for_user' : 'ask_user_once',
    }
    const pending = {
      agent: state.input.agent,
      turn: state.input.turn,
      key,
      status: 'waiting' as 'waiting' | 'queued',
      result: result as unknown,
      operation: undefined as Promise<unknown> | undefined,
    }
    this.#clarifications.set(sessionId, pending)
    await this.diagnose(state, {
      kind: 'question',
      questionRef: id,
      reason: transition
        ? 'transition_required'
        : target
          ? 'target_unknown'
          : scope
            ? 'scope_unknown'
            : 'clarification_required',
    })
    if (!this.host.questions || !state.input.agent.followup) return result
    const operation = (async () => {
      try {
        const response = await abortable(
          this.host.questions!.ask({
            agent: state.input.agent,
            signal,
            questions: [
              {
                id,
                question,
                ...(scope && !target && !transition
                  ? {
                      options: [
                        { label: '文章のみ' },
                        { label: 'コード・テスト・設定を含む' },
                      ],
                    }
                  : {}),
              },
            ],
          }),
          signal,
        )
        signal.throwIfAborted()
        this.assertCurrent(state)
        if (
          this.#clarifications.get(sessionId) !== pending ||
          pending.status !== 'waiting'
        )
          return result
        await this.host.validate(state.input)
        signal.throwIfAborted()
        this.assertCurrent(state)
        const current = this.host.requestContext
          ? await this.host.requestContext(state.input, state.task)
          : (await this.host.interpret?.(state.input, state.task))?.context
        signal.throwIfAborted()
        this.assertCurrent(state)
        if (
          context &&
          (!current ||
            canonicalContentHash(current) !== canonicalContentHash(context))
        ) {
          if (current) {
            state.requestIntentContext = current
            state.requestIntent = unresolvedRequestIntent(
              current,
              'clarification_context_changed',
            )
            state.requestIntentContextDigest = canonicalContentHash(current)
          }
          pending.result = {
            ...result,
            ...(current
              ? {
                  currentReferences: requestIntentRequiredReferenceIds(current),
                }
              : {}),
            status: 'clarification_context_changed',
            detail:
              'The task or current evidence changed while awaiting the answer. Refresh the current request before asking again.',
          }
          return pending.result
        }
        const answer = response.answers[0]
        const value = answer?.custom?.trim() || answer?.selected[0]?.trim()
        if (answer?.id !== id || !value || value.length > 8192) return result
        // Preserve actual native sources and answers once; never recursively quote an earlier generated envelope.
        // label the actual UI answer separately, and re-enter ordinary native
        // capture. The reply itself is never mapped to execution authority.
        const answerMessageId = randomUUID()
        const reply = clarificationReply(clarification, {
          id: answerMessageId,
          questionId: id,
          question,
          value,
          scope: answerScope,
        })
        const content = reply.content
        signal.throwIfAborted()
        this.assertCurrent(state)
        replies.set(answerMessageId, reply.context)
        this.#clarificationContexts.set(state.input.agent, replies)
        state.input.agent.followup!({
          id: answerMessageId,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: content }],
        })
        await this.diagnose(state, {
          kind: 'answer',
          questionRef: id,
          answerRef: answerMessageId,
        })
        pending.status = 'queued'
        pending.result = {
          ...result,
          status: 'clarification_answer_queued',
          answer: value,
          answerRef: answerMessageId,
          nextAction: 'await_queued_answer_capture',
          detail:
            'The answer is already queued as native user input. Do not ask it again or reuse old references. Continue only after the host captures the queued answer and supplies its current references.',
        }
        return pending.result
      } catch (error) {
        if (signal.aborted) {
          if (this.#clarifications.get(sessionId) === pending)
            this.#clarifications.delete(sessionId)
          throw error
        }
        // Dismissal remains unapproved. A failed surface or host read can be
        // retried explicitly instead of retaining a dead pending question.
        if ((error as { code?: unknown })?.code === 'ASK_CANCELLED')
          return result
        if (this.#clarifications.get(sessionId) === pending)
          this.#clarifications.delete(sessionId)
        return {
          ...result,
          status: 'clarification_unavailable',
          nextAction: 'retry_preparation',
          detail:
            'The question or its current context could not be read. No work was prepared and no answer was queued. Retry explicitly after restoring the question surface or host storage.',
        }
      } finally {
        pending.operation = undefined
      }
    })()
    pending.operation = operation
    return this.watch(operation)
  }
  private async bindIntent(
    state: Turn,
    submission?: RequestIntentSubmission,
  ): Promise<RequestIntentDecision | undefined> {
    if (!submission) {
      if (
        requestIntentIsUnresolved(state.requestIntent) &&
        this.host.interpret
      ) {
        const current = await this.host.interpret(state.input, state.task)
        this.assertCurrent(state)
        if (current) {
          state.requestIntentContext = current.context
          state.requestIntentContextDigest = canonicalContentHash(
            current.context,
          )
          state.requestIntent = current.decision
        }
      }
      if (
        requestIntentIsUnresolved(state.requestIntent) &&
        state.requestIntentContext &&
        state.requestIntent?.source === 'unresolved' &&
        (state.requestIntent.relation === 'unknown' ||
          state.requestIntent.action === 'unknown' ||
          state.requestIntent.unresolvedReason !==
            'provider_abstained_or_uncertain') &&
        !this.#clarifications.has(state.input.agent.session!.id)
      ) {
        throw new RequestClarification(
          'The main model must interpret the current request before preparing work',
          false,
          true,
        )
      }
      if (
        state.requestIntent?.action === 'change' &&
        state.requestIntent.changeScope === 'unknown'
      ) {
        throw new RequestClarification(
          'The requested change scope is unresolved. Specify implementation or document using the current request evidence before preparing work.',
        )
      }
      return state.requestIntent
    }
    if (
      !state.requestIntentContext ||
      state.requestIntentContextDigest !==
        canonicalContentHash(state.requestIntentContext)
    ) {
      throw new Error('Request interpretation context is stale')
    }
    const result = validateMainModelRequestIntent(
      submission,
      state.requestIntentContext,
    )
    if (!result.ok) {
      switch (result.reason) {
        case 'no_active_goal':
          throw new Error(
            `Request relation ${submission.relation} cannot be used without an active Goal. ${NO_ACTIVE_GOAL_GUIDANCE}`,
          )
        case 'missing_reference':
          throw new Error(
            'Request interpretation is missing required current message or active Goal references. Use the exact current evidenceRefs from the supplied context.',
          )
        case 'unknown_reference':
          throw new Error(
            'Request interpretation references another request, stale revision, or unknown proposal. Use only the exact current evidenceRefs from the supplied context.',
          )
        case 'unresolved_intent':
          throw new RequestClarification(
            'Request relation or action is unresolved. Interpret the original request and current context; clarify with the user if its action or target remains unclear.',
          )
        case 'invalid_submission':
          throw new Error(
            'Invalid request interpretation. Supply a relation, action and unique exact current evidenceRefs.',
          )
        case 'invalid_task_operation': {
          const task = state.requestIntentContext.activeTask
          if (!task)
            throw new Error(
              'No active SQLite task is supplied in the current request context. taskOperation describes a transition of an existing task, not starting the requested work. To prepare the original request, omit taskOperation and retry with the same exact current evidenceRefs. Native permissions remain unchanged.',
            )
          const allowed = taskAllowedOperations(task)
          throw new Error(
            `The proposed task operation ${submission.taskOperation} is not allowed for the current SQLite task state ${task.state} (run status ${task.runStatus}, revision ${task.revision}, generation ${task.generation}). Allowed state operations: ${allowed.join(', ') || 'none'}. If no state transition is requested, omit taskOperation and retry with the exact current evidenceRefs. Otherwise use task_operation or /kioku-task with an allowed explicit operation; terminal resume requires an explicit operation, and native permissions and required evidence remain unchanged.`,
          )
        }
      }
    }
    const bound = result.decision
    if (bound.action === 'change' && bound.changeScope === 'unknown') {
      throw new RequestClarification(
        'Determine requestIntent.changeScope from the captured request and plan in the main model. Ask a concrete human question only if the source itself leaves that choice unclear.',
        false,
        true,
        bound,
      )
    }
    const prior = state.requestIntent
    if (
      prior?.source === 'decision-provider' &&
      prior.relation !== 'unknown' &&
      prior.action !== 'unknown'
    ) {
      if (prior.relation !== bound.relation || prior.action !== bound.action) {
        throw new Error(
          'Main-model interpretation conflicts with the configured decision provider',
        )
      }
      return { ...prior, evidence: bound.evidence }
    }
    return bound
  }
  async answerMessages(
    input: DemandInput,
    messages: readonly unknown[],
  ): Promise<readonly unknown[]> {
    const state = this.#turns.get(input.agent.session!.id)
    // Native pre-step may augment its payload while downstream hooks run.
    // Project the immutable human batch captured before that waterfall.
    if (state?.input.turn === input.turn && state.input.agent !== input.agent)
      throw new Error('Answer projection native agent changed')
    let projected =
      state?.input.turn === input.turn &&
      !state.nativeUnowned &&
      state.answerContextReady &&
      !state.confirmationResume &&
      this.host.answerContext
        ? await this.memoryCheck(state,input=>this.host.answerContext!.project(
            input,
            messages,
            this.ownerIdentity(state),
          )).catch(async()=>{state.input.signal.throwIfAborted();await this.deferMemory(state);return filterRequestMemory(messages,new Map())})
        : messages
    if(state?.memoryDeferred)projected=filterRequestMemory(projected,new Map())
    return this.guidance(
      projected,
      state?.input.turn === input.turn ? state : undefined,
    )
  }
  async beforeRequest(agent: DemandAgent): Promise<void> {
    const state = agent.session && this.#turns.get(agent.session.id)
    if (
      state &&
      !state.nativeUnowned &&
      state.answerContextReady &&
      state.input.agent === agent &&
      state.status === 'answer' &&
      this.pending(agent)
    ) {
      await this.memoryCheck(state,input=>this.host.answerContext?.beforeRequest(
        input,
        this.ownerIdentity(state),
      )??Promise.resolve()).catch(async()=>{state.input.signal.throwIfAborted();await this.deferMemory(state)})
    }
  }
  async fence(
    agent: DemandAgent,
    request: {
      sessionId?: string
      purpose?: string
      messages?: readonly unknown[]
    },
  ): Promise<void> {
    const state = agent.session && this.#turns.get(agent.session.id)
    const requireRebuild = () => {
      if (Array.isArray(request.messages) && filterRequestMemory(request.messages, new Map()).length !== request.messages.length)
        throw new MemorySnapshotStale()
    }
    // Native requests are immutable after assembly. Rebuild before dispatch;
    // never edit the provider request or let quarantined memory pass through.
    if (state?.input.agent === agent && state.memoryDeferred) requireRebuild()
    if (
      state &&
      !state.nativeUnowned &&
      state.answerContextReady &&
      state.input.agent === agent &&
      state.status === 'answer' &&
      this.pending(agent)
    ) {
      await this.memoryCheck(state,input=>this.host.answerContext?.fence(
        input,
        request,
        this.ownerIdentity(state),
      )??Promise.resolve()).catch(async error => {
        state.input.signal.throwIfAborted()
        if (error instanceof MemorySnapshotStale) throw error
        await this.deferMemory(state)
        requireRebuild()
      })
    }
  }
  guidance(messages: readonly unknown[], state?: Turn): readonly unknown[] {
    const context = state?.requestIntentContext
    const interpretation = state?.requestIntent
    const intentText = context
      ? `\n\nCurrent request references and same-session work (host-bound, advisory only):\n${JSON.stringify(
          {
            references: requestIntentReferenceIds(context),
            requiredReferences: requestIntentRequiredReferenceIds(context),
            activeGoal: context.activeGoal ?? null,
            activeTask: context.activeTask ?? null,
            proposals: context.proposals.map(
              ({ id, revision, digest, text }) => ({
                id,
                revision,
                digest,
                text,
                evidenceRef: `proposal:${canonicalContentHash([id, revision, digest])}`,
              }),
            ),
            decision: interpretation
              ? {
                  relation: interpretation.relation,
                  action: interpretation.action,
                  source: interpretation.source,
                  policyVersion: interpretation.policyVersion,
                  evidence: interpretation.evidence,
                  unresolvedReason: interpretation.unresolvedReason ?? null,
                }
              : null,
          },
        )}\nInclude every requiredReferences entry in requestIntent.evidenceRefs. Add a proposal evidenceRef only when the current user request actually adopts or refers to that proposal; do not copy all proposals automatically. Use only these exact references. The original human message remains unchanged.`
      : ''
    const text =
      ON_DEMAND_GUIDANCE +
      intentText +
      (state?.memoryDeferred?`\nOptional memory is quarantined and excluded from this request. Native permissions still apply. Deferred checks: ${JSON.stringify(this.host.recovery?.status(state.session.id)??[state.auxiliaryReceipt])}`:'')+
      (context && !context.activeGoal && !context.activeTask
        ? `\n${NO_ACTIVE_GOAL_GUIDANCE}`
        : '')
    // Retry the same host-owned snapshot with the same identity. A changed
    // snapshot or a new captured turn receives a fresh origin.
    const origin =
      state?.guidance?.text === text
        ? state.guidance
        : { id: randomUUID(), text }
    if (state) state.guidance = origin
    const message = {
      id: origin.id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: KIOKUKO_DSH_SOURCE_KIND,
        form: 'snapshot',
        sections: [{ name: 'on-demand-intake', text }],
      },
    }
    const digest = canonicalContentHash(message)
    const sameOrigin = (value: any): boolean =>
      value?.role === 'user' &&
      value.id === origin.id &&
      isKiokukoDshSource(value.source) &&
      canonicalContentHash(value) === digest
    let delivered = retainedEvents(state?.input.agent.session ?? {}).some(
      (event) => event.type === 'user/message' && sameOrigin(event.data),
    )
    const projected = messages.filter((value) => {
      if (!sameOrigin(value)) return true
      if (delivered) return false
      delivered = true
      return true
    })
    return delivered ? projected : [...projected, message]
  }

  snapshot(sessionId: string):
    | {
        task: string
        taskType: TaskType | null
        status: string
        turn: number
        requestIntent?: RequestIntentDecision
        memoryOwner: MemoryOwnerKind
        auxiliary?: readonly unknown[]
      }
    | undefined {
    const state = this.#turns.get(sessionId)
    return (
      state && {
        task: state.task,
        taskType: state.taskType ?? state.intent.taskType ?? null,
        status: state.status,
        turn: state.input.turn,
        ...(state.requestIntent
          ? { requestIntent: structuredClone(state.requestIntent) }
          : {}),
        memoryOwner: state.memoryOwner,
        ...(state.auxiliaryReceipt?{auxiliary:this.host.recovery?.status(sessionId)??[state.auxiliaryReceipt]}:{}),
      }
    )
  }
  /** Refresh only authority facts after a committed control operation; retain the exact human request. */
  taskStateChanged(task: TaskSnapshot): void {
    const state = this.#turns.get(task.sessionId)
    if (
      !state ||
      ['closed', 'stale'].includes(state.status) ||
      state.input.signal.aborted ||
      !state.requestIntentContext
    )
      return
    state.nativeUnowned = false
    const previous = state.requestIntentContext.activeTask
    if (
      previous?.taskId === task.taskId &&
      previous.revision === task.revision &&
      previous.generation === task.generation
    )
      return
    const context = createRequestIntentContext({
      ...state.requestIntentContext,
      activeTask: task,
      ...(state.requestIntentContext.activeGoal?.runId === task.runId
        ? {}
        : { activeGoal: undefined }),
    })
    if (!context) return
    state.requestIntentContext = context
    state.requestIntentContextDigest = canonicalContentHash(context)
    state.requestIntent = unresolvedRequestIntent(context, 'task_state_changed')
    state.status = 'answer'
    state.existing = false
    state.memoryOwner = 'none'
    delete state.preparedIntentDigest
  }
  /** A current host-validated control call, never arbitrary code or a name-based exemption. */
  /** Exact registered native-tool proof, never a model flag or a generic task-control bypass. */
  unownedNative(execution: Execution): boolean {
    const state = this.bound(execution),
      proof = this.#executions.get(execution)
    return (
      !this.#stopped &&
      !execution.signal.aborted &&
      UNOWNED_NATIVE_TOOLS.has(execution.name) &&
      execution.parent === undefined &&
      !!state &&
      state.nativeUnowned === true &&
      state.status === 'answer' &&
      !state.input.signal.aborted &&
      !!proof &&
      proof.turn === state &&
      proof.execute === this.definition(execution)?.execute &&
      proof.nativeUnownedDigest === canonicalContentHash(execution.arguments)
    )
  }
  /** Direct native Bash follows native permissions, independently of optional task intake. */
  nativeCommand(execution: Execution): boolean {
    const state = this.bound(execution),
      actual = this.definition(execution),
      proof = this.#executions.get(execution)
    if (
      !this.options.onlyWhenDeferred &&
      !this.#stopped &&
      actual &&
      isLispNativeCommand(execution, actual.execute)
    )
      return (
        !proof ||
        (proof.turn === state &&
          proof.execute === actual.execute &&
          proof.nativeCommandDigest ===
            canonicalContentHash(execution.arguments))
      )
    if (
      this.options.onlyWhenDeferred ||
      this.#stopped ||
      execution.signal.aborted ||
      execution.name !== 'bash' ||
      execution.parent !== undefined ||
      !state ||
      state.input.signal.aborted ||
      !actual ||
      (execution.agent && this.host.nativeChild?.(execution.agent))
    )
      return false
    try {
      this.assertCurrent(state)
    } catch {
      return false
    }
    return (
      !proof ||
      (proof.turn === state &&
        proof.execute === actual.execute &&
        proof.nativeCommandDigest === canonicalContentHash(execution.arguments))
    )
  }
  /** Delegate real root Lisp tools to their own effect/lease/approval authority. */
  nativeLisp(execution: Execution): boolean {
    const state = this.bound(execution),
      actual = this.definition(execution),
      proof = this.#executions.get(execution)
    if (
      this.options.onlyWhenDeferred ||
      this.#stopped ||
      execution.signal.aborted ||
      execution.parent !== undefined ||
      !state ||
      state.status !== 'answer' ||
      state.input.signal.aborted ||
      !actual ||
      !isLispImplementation(actual.execute) ||
      (execution.agent && this.host.nativeChild?.(execution.agent))
    )
      return false
    try {
      this.assertCurrent(state)
    } catch {
      return false
    }
    return (
      !proof ||
      (proof.turn === state &&
        proof.execute === actual.execute &&
        proof.nativeLispDigest === canonicalContentHash(execution.arguments))
    )
  }
  preparationOnly(execution: Execution): boolean {
    if (this.isControl(execution)) return true
    const state = this.bound(execution),
      proof = this.#executions.get(execution)
    if (
      this.#stopped ||
      execution.signal.aborted ||
      execution.parent !== undefined ||
      !state ||
      state.input.signal.aborted ||
      !proof ||
      proof.turn !== state ||
      this.definition(execution)?.execute !== proof.execute ||
      state.preparationCalls.has(execution.callId)
    )
      return false
    if (proof.carrier)
      return (
        execution.name === 'run_code' &&
        state.status === 'answer' &&
        canonicalContentHash(
          preparationCarrier(execution.arguments) ?? null,
        ) === proof.carrierDigest
      )
    return (
      proof.requestPreparation === true &&
      execution.name === TASK_PREPARE_TOOL &&
      (state.status === 'answer' ||
        (state.existing === true &&
          state.status === 'prepared' &&
          this.host.ready(state.input.agent, state.input.turn)))
    )
  }
  pending(agent: DemandAgent): boolean {
    const state = agent.session && this.#turns.get(agent.session.id)
    return (
      !!state &&
      !state.confirmationResume &&
      state.input.agent === agent &&
      !['prepared', 'closed', 'stale'].includes(state.status)
    )
  }
  /** An admitted host continuation still needs capture to retire the previous turn's receipt. */
  continuing(agent: DemandAgent): boolean {
    return !this.#stopped && this.host.ready(agent)
  }
  /** Exact captured task at a native lifecycle boundary, never a later selected task. */
  boundaryTask(session: object & { id: string }, turn: number) {
    const state = this.#turns.get(session.id),
      task = state?.requestIntentContext?.activeTask
    if (
      state?.input.agent.session !== session ||
      state.input.turn !== turn ||
      !task ||
      task.state !== 'Working'
    )
      return undefined
    return {
      agent: state.input.agent,
      expected: {
        taskId: task.taskId,
        revision: task.revision,
        generation: task.generation,
      },
    }
  }
  finish(session: object & { id: string }, turn: number): void {
    const state = this.#turns.get(session.id)
    if (state?.input.agent.session === session && state.input.turn === turn) {
      const boundary=[...(state.input.agent.session.snapshotEvents?.()??[])].reverse().find(e=>e.type==='turn/end'&&(e.data as any)?.turn===turn)
      state.recoveryAfterFinish=(boundary?.data as any)?.reason?.kind==='completed'
      state.status = 'closed'
      state.controller.abort(new Error('Native turn ended'))
      this.host.answerContext?.retire(state.input.agent)
    }
  }
  mount(
    context: {
      get?(name: string, required?: boolean): any
      on(
        name: string,
        listener: (...args: any[]) => any,
        options?: { prepend?: boolean; global?: boolean },
      ): () => void
    },
    tools: NativeTools,
    systemPrompt?: { section(section: any): () => void },
  ): void {
    if (!tools.get || !tools.guard || !tools.register)
      throw new Error(
        'On-demand intake requires native tool identity and monotonic guards',
      )
    this.#tools = tools
    if(this.host.recovery)this.#disposers.push(context.on('agent/idle',(payload:DemandAgent|{agent:DemandAgent})=>{
      const agent='agent' in payload?payload.agent:payload
      const state=agent.session&&this.#turns.get(agent.session.id)
      if(state?.input.agent===agent&&state.session===agent.session)void this.host.recovery!.idle(agent.session!.id)
    },{global:true}))
    // Preserve an already installed reader across replacement before capture.
    // When absent, capture binds the validated agent's installed preset reader.
    this.#startupSkillReader = tools.get('skill')?.execute
    // Trust the validated host registry, not a later same-name replacement.
    this.#startupQuestionTool = tools.get('ask_user_question')?.execute
    if (systemPrompt && !this.options.onlyWhenDeferred)
      this.#disposers.push(
        systemPrompt.section({
          name: 'kiokuko:on-demand-intake',
          order: -99999,
          text:
            'On-demand host contract: text answers do not require execution intake. The public prepare_requested_work tool accepts an advisory taskType or a source-bound requestIntent; task_prepare/task_answer remain host-only. ' +
            ON_DEMAND_GUIDANCE,
        }),
      )
    const definition = {
      name: TASK_PREPARE_TOOL,
      modelFacing: true,
      description:
        'Prepare the exact original user request for tool-backed work. Supply either legacy advisory taskType or requestIntent with exact evidenceRefs from the host context; never rewrite the task or invent a target. This does not grant native tool permissions. Answer ordinary questions directly; clarify unknown actions or targets first.',
      parameters: {
        ...JSON.parse(JSON.stringify(z.toJSONSchema(preparationFieldsSchema))),
        anyOf: [{ required: ['taskType'] }, { required: ['requestIntent'] }],
      },
      output: {
        schema: {},
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: JSON.stringify(value) },
        ],
      },
      execute: async (args: unknown, execution: Execution) => {
        const state = this.bound(execution)
        const value = parsePreparationRequest(args)
        if (
          !state ||
          execution.name !== TASK_PREPARE_TOOL ||
          this.definition(execution)?.execute !== definition.execute ||
          !value
        )
          throw new Error('Invalid task preparation request')
        if (
          state.preparationCalls.has(execution.callId) ||
          !(
            state.status === 'answer' ||
            (state.status === 'prepared' &&
              this.host.ready(state.input.agent, state.input.turn))
          )
        )
          throw new Error('Task preparation was already consumed for this turn')
        state.preparationCalls.add(execution.callId)
        try {
          this.assertCurrent(state)
          execution.signal.throwIfAborted()
          const suppliedIntent = await this.bindIntent(
            state,
            value.requestIntent,
          )
          if (
            suppliedIntent?.action === 'answer' &&
            !requestIntentIsUnresolved(suppliedIntent)
          )
            throw new RequestClarification(
              'Answer the captured request without execution preparation',
              false,
              false,
              suppliedIntent,
            )
          if (state.existing) {
            const boundIntent = suppliedIntent
            if (
              boundIntent?.relation === 'same_scope_continuation' &&
              !requestIntentIsUnresolved(boundIntent) &&
              boundIntent.action !== 'answer'
            ) {
              const intentType = requestIntentTaskType(
                boundIntent,
                state.taskType ?? state.intent.taskType ?? value.taskType,
              )
              if (
                value.taskType !== undefined &&
                intentType !== undefined &&
                value.taskType !== intentType
              ) {
                throw new Error(
                  'The advisory taskType conflicts with the bound request action',
                )
              }
              state.requestIntent = boundIntent
            } else {
              if (
                !boundIntent ||
                requestIntentIsUnresolved(boundIntent) ||
                boundIntent.action === 'answer'
              ) {
                throw new RequestClarification(
                  'Clarify whether this request continues, changes, or starts work before preparing it',
                )
              }
              const intentType = requestIntentTaskType(
                boundIntent,
                state.taskType ?? state.intent.taskType ?? value.taskType,
              )
              if (
                !intentType ||
                intentType === 'chat' ||
                (value.taskType !== undefined && value.taskType !== intentType)
              ) {
                throw new Error(
                  'The advisory taskType conflicts with the bound request action',
                )
              }
              state.existing = false
              state.status = 'answer'
              state.memoryOwner = memoryOwnerKind(boundIntent, intentType)
              await this.prepare(
                state,
                intentType,
                execution.signal,
                boundIntent,
                value.requestIntent !== undefined,
              )
            }
          } else {
            const currentIntent = suppliedIntent ?? state.requestIntent
            const unresolved =
              currentIntent !== undefined &&
              requestIntentIsUnresolved(currentIntent)
            if (unresolved) {
              throw new RequestClarification(
                'Clarify the request before preparing work',
              )
            }
            if (
              state.requestIntentContext?.activeGoal &&
              currentIntent === undefined
            ) {
              throw new RequestClarification(
                'Clarify whether this request continues, changes, or starts the active Goal',
              )
            }
            const intentType = unresolved
              ? undefined
              : requestIntentTaskType(
                  currentIntent,
                  state.taskType ?? state.intent.taskType ?? value.taskType,
                )
            if (
              value.taskType !== undefined &&
              intentType !== undefined &&
              value.taskType !== intentType
            ) {
              throw new Error(
                'The advisory taskType conflicts with the bound request action',
              )
            }
            const taskType = intentType ?? value.taskType
            if (
              !taskType ||
              taskType === 'chat' ||
              !ACTION_TYPES.includes(taskType)
            )
              throw new RequestClarification(
                'Answer ordinary questions directly; clarify unknown actions before preparing work',
                false,
                false,
                currentIntent,
              )
            state.memoryOwner = memoryOwnerKind(currentIntent, taskType)
            await this.prepare(
              state,
              taskType,
              execution.signal,
              currentIntent,
              value.requestIntent !== undefined,
            )
          }
          return {
            prepared: true,
            taskType:
              state.taskType ??
              value.taskType ??
              requestIntentTaskType(state.requestIntent),
            originalTask: state.task,
            ...(state.requestIntent
              ? { requestIntent: state.requestIntent }
              : {}),
            ...(state.requestIntent &&
            requestIntentIsUnresolved(state.requestIntent)
              ? {
                  requestInterpretation: requestInterpretationRecovery(
                    state.requestIntent,
                    state.requestIntentContext,
                    true,
                  ),
                }
              : {}),
            memoryOwner: state.memoryOwner,
            permissions: 'unchanged_native_policy',
          }
        } catch (error) {
          if (!(error instanceof RequestClarification)) throw error
          return this.clarify(state, execution.signal, error)
        }
      },
    }
    this.#disposers.push(tools.register(definition))
    this.#disposers.push(
      context.on(
        'tools/pre-execute',
        async (execution: Execution, next: () => Promise<any>) => {
          if (this.#stopped || execution.signal.aborted)
            return denied('On-demand intake is stopped or cancelled')
          if (execution.agent && this.host.nativeChild?.(execution.agent)) {
            const decision = await next()
            return decision?.kind === 'cancel'
              ? denied('Native tool policy cancelled this call')
              : decision
          }
          await this.bindExecutorTransport(execution, context)
          const actual = this.definition(execution)
          if (!actual || typeof actual.execute !== 'function')
            return denied('Unknown native tool definition')
          const control = this.controlCall(execution, actual)
          if (control) {
            const turn = this.bound(execution)
            if (
              execution.agent?.session &&
              this.#turns.has(execution.agent.session.id) &&
              !turn
            )
              return denied('Stale task control request')
            if (turn) {
              try {
                this.assertCurrent(turn)
              } catch {
                return denied('Stale task control request')
              }
            }
            this.#controlExecutions.set(execution, {
              ...control,
              ...(turn ? { turn } : {}),
            })
            const decision = await next()
            return decision?.kind === 'cancel'
              ? denied('Native tool policy cancelled this call')
              : decision
          }
          const state = this.bound(execution)
          if (!state) {
            if (
              execution.agent?.session &&
              this.#turns.has(execution.agent.session.id)
            )
              return denied('Stale on-demand native turn')
            const turn = this.existingTurn(execution)
            if (
              !execution.agent ||
              turn === undefined ||
              !this.host.ready(execution.agent, turn)
            )
              return denied('No current native request for tool execution')
            const decision = await next()
            return decision?.kind === 'cancel'
              ? denied('Native tool policy cancelled this call')
              : decision
          }
          try {
            this.assertCurrent(state)
            if (
              state.confirmationResume &&
              execution.name !== TASK_PREPARE_TOOL &&
              this.host.ready(state.input.agent, state.input.turn)
            )
              this.acknowledgeExisting(state)
            if (this.nativeCommand(execution)) {
              this.#executions.set(execution, {
                turn: state,
                execute: actual.execute,
                nativeCommandDigest: canonicalContentHash(execution.arguments),
              })
              const decision = await next()
              return decision?.kind === 'cancel'
                ? denied('Native tool policy cancelled this call')
                : decision
            }
            if (this.nativeLisp(execution)) {
              this.#executions.set(execution, {
                turn: state,
                execute: actual.execute,
                nativeLispDigest: canonicalContentHash(execution.arguments),
              })
              const decision = await next()
              return decision?.kind === 'cancel'
                ? denied('Native tool policy cancelled this call')
                : decision
            }
            // Evidence gathering does not decide the request's action or scope.
            // In particular, an inherited owner must not turn a read into an
            // immutable research preparation before the main model can interpret it.
            if (
              state.status === 'answer' &&
              !state.nativeUnowned &&
              execution.parent === undefined &&
              NATIVE_EVIDENCE_READS.has(execution.name)
            ) {
              const clarification = executionClarification(
                state.task,
                state.requestIntent,
                state.requestIntentContext,
              )
              if (clarification) return denied(clarification)
              this.#executions.set(execution, {
                turn: state,
                execute: actual.execute,
                evidenceReadDigest: canonicalContentHash(execution.arguments),
              })
              const decision = await next()
              return decision?.kind === 'cancel'
                ? denied('Native tool policy cancelled this call')
                : decision
            }
            if (
              state.nativeUnowned &&
              UNOWNED_NATIVE_TOOLS.has(execution.name) &&
              execution.parent === undefined
            ) {
              if (
                (await this.host.nativeOwnership?.(state.input)) !== 'unowned'
              ) {
                state.nativeUnowned = false
                return denied(
                  'Native execution acquired a Kiokuko owner; its current authority is required',
                )
              }
              this.assertCurrent(state)
              if (this.definition(execution)?.execute !== actual.execute)
                return denied('Native tool definition changed')
              this.#executions.set(execution, {
                turn: state,
                execute: actual.execute,
                nativeUnownedDigest: canonicalContentHash(execution.arguments),
              })
              const decision = await next()
              return decision?.kind === 'cancel'
                ? denied('Native tool policy cancelled this call')
                : decision
            }
            const skillReader = this.#skillReaders.get(state.input.agent)
            const skillRead =
              execution.name === 'skill' &&
              skillReader !== undefined &&
              actual.execute === skillReader &&
              state.status === 'answer'
            const carrier =
              execution.name === 'run_code'
                ? preparationCarrier(execution.arguments)
                : undefined
            const carrierDigest = carrier
              ? canonicalContentHash(carrier)
              : undefined
            if (
              execution.name === 'run_code' &&
              state.status !== 'prepared' &&
              !carrier &&
              !automaticPreparationType(
                state.intent,
                state.requestIntent,
                execution.name,
              )
            )
              return denied('Clarify the requested work before code execution.')
            if (carrier) {
              if (
                !(
                  state.status === 'answer' ||
                  (state.status === 'prepared' &&
                    this.host.ready(state.input.agent, state.input.turn))
                ) ||
                state.preparationCalls.has(execution.callId)
              )
                return denied('Preparation carrier is not current')
            } else if (execution.name === TASK_PREPARE_TOOL) {
              if (
                actual.execute !== definition.execute ||
                !(
                  state.status === 'answer' ||
                  (state.status === 'prepared' &&
                    this.host.ready(state.input.agent, state.input.turn))
                ) ||
                state.preparationCalls.has(execution.callId)
              )
                return denied('Task preparation is not current')
            } else if (!skillRead) {
              if (state.status !== 'prepared') {
                const type = automaticPreparationType(
                  state.intent,
                  state.requestIntent,
                  execution.name,
                )
                if (!type)
                  return denied(
                    'Before tool-backed work, call prepare_requested_work with its advisory taskType. Clarify unknown actions or targets first; the original request is preserved.',
                  )
                await this.prepare(
                  state,
                  type,
                  execution.signal,
                  state.requestIntent,
                )
              }
              if (!this.host.ready(state.input.agent, state.input.turn))
                return denied('Prepared execution is no longer current')
            }
            this.assertCurrent(state)
            if (this.definition(execution)?.execute !== actual.execute)
              return denied('Native tool definition changed during preparation')
            this.#executions.set(execution, {
              turn: state,
              execute: actual.execute,
              ...(carrier && carrierDigest ? { carrier, carrierDigest } : {}),
              ...(skillRead ? { skillRead: true } : {}),
              ...(execution.name === TASK_PREPARE_TOOL
                ? { requestPreparation: true }
                : {}),
            })
            // Preserve native allow/deny/ask unchanged. Approval is resolved by the native registry AFTER this waterfall.
            const decision = await next()
            // DSH 0.1.5 does not understand cancel and otherwise dispatches it without running guards.
            return decision?.kind === 'cancel'
              ? denied('Native tool policy cancelled this call')
              : decision
          } catch (error) {
            if (error instanceof RequestClarification) {
              try {
                const result = await this.clarify(
                  state,
                  execution.signal,
                  error,
                )
                return denied(
                  `Execution was not prepared; no work was executed. ${JSON.stringify(result)}`,
                )
              } catch (cancelled) {
                return denied(
                  cancelled instanceof Error
                    ? cancelled.message
                    : 'Clarification cancelled',
                )
              }
            }
            return denied(
              error instanceof Error
                ? error.message
                : 'Execution preparation failed',
            )
          }
        },
        { prepend: true },
      ),
    )
    this.#disposers.push(
      context.on(
        'tools/execute',
        async (execution: Execution, next: () => Promise<unknown>) => {
          if (execution.agent && this.host.nativeChild?.(execution.agent))
            return next()
          const control = this.#controlExecutions.get(execution)
          if (control) {
            if (!this.isControl(execution))
              throw new Error('Task control identity or arguments changed')
            ;(execution as { signal: AbortSignal }).signal = AbortSignal.any([
              execution.signal,
              this.#lifecycle.signal,
              ...(control.turn ? [control.turn.input.signal] : []),
            ])
            if (!control.invoke) return next()
            const result = await control.invoke(control.args, execution)
            return {
              isError: false,
              value: {
                logs: ['Host task operation. No program was evaluated.'],
                result,
              },
              content: [{ type: 'text', text: JSON.stringify(result) }],
            }
          }
          const proof = this.#executions.get(execution)
          if (!proof) return next() // Existing independently admitted runs keep their original path.
          const state = this.bound(execution)
          if (
            !state ||
            proof.turn !== state ||
            this.definition(execution)?.execute !== proof.execute
          )
            throw new Error('On-demand dispatch identity changed')
          this.assertCurrent(state)
          ;(execution as { signal: AbortSignal }).signal = AbortSignal.any([
            execution.signal,
            state.input.signal,
            this.#lifecycle.signal,
          ])
          if (proof.nativeCommandDigest !== undefined) {
            if (!this.nativeCommand(execution))
              throw new Error('Native command identity or arguments changed')
            return next()
          }
          if (proof.nativeLispDigest !== undefined) {
            if (!this.nativeLisp(execution))
              throw new Error('Native Lisp identity or arguments changed')
            return withRootLispAdmission(
              execution,
              () => this.nativeLisp(execution),
              next,
            )
          }
          if (proof.evidenceReadDigest !== undefined) {
            if (
              state.status !== 'answer' ||
              execution.parent !== undefined ||
              !NATIVE_EVIDENCE_READS.has(execution.name) ||
              canonicalContentHash(execution.arguments) !==
                proof.evidenceReadDigest
            )
              throw new Error(
                'Native evidence read identity or arguments changed',
              )
            return next()
          }
          if (proof.nativeUnownedDigest !== undefined) {
            if (
              !this.unownedNative(execution) ||
              (await this.host.nativeOwnership?.(state.input)) !== 'unowned'
            ) {
              state.nativeUnowned = false
              throw new Error(
                'Native unowned authority changed or became unavailable',
              )
            }
            this.assertCurrent(state)
            return next()
          }
          if (!proof.carrier) return next()
          const carrier = preparationCarrier(execution.arguments)
          if (
            !(
              state.status === 'answer' ||
              (state.status === 'prepared' &&
                this.host.ready(state.input.agent, state.input.turn))
            ) ||
            state.preparationCalls.has(execution.callId) ||
            !carrier ||
            canonicalContentHash(carrier) !== proof.carrierDigest
          )
            throw new Error(
              'Preparation carrier was already consumed or changed',
            )
          state.preparationCalls.add(execution.callId)
          try {
            const requestIntent = await this.bindIntent(
              state,
              carrier.requestIntent,
            )
            if (
              requestIntent?.action === 'answer' &&
              !requestIntentIsUnresolved(requestIntent)
            )
              throw new RequestClarification(
                'Answer the captured request without execution preparation',
                false,
                false,
                requestIntent,
              )
            const clarification = executionClarification(
              state.task,
              requestIntent,
              state.requestIntentContext,
            )
            if (clarification) throw new RequestClarification(clarification)
            const unresolved =
              requestIntent !== undefined &&
              requestIntentIsUnresolved(requestIntent)
            if (unresolved)
              throw new RequestClarification(
                'Clarify the requested action and scope before preparing work',
              )
            const intentType = unresolved
              ? undefined
              : requestIntentTaskType(
                  requestIntent,
                  state.taskType ?? state.intent.taskType ?? carrier.taskType,
                )
            const taskType = intentType ?? carrier.taskType
            if (carrier.taskType !== undefined && taskType !== carrier.taskType)
              throw new Error(
                'The advisory taskType conflicts with the bound request action',
              )
            if (!taskType || taskType === 'chat') {
              throw new RequestClarification(
                'Clarify the requested action and scope before preparing work',
                false,
                false,
                requestIntent,
              )
            }
            state.memoryOwner = memoryOwnerKind(requestIntent, taskType)
            await this.prepare(
              state,
              taskType,
              execution.signal,
              requestIntent,
              carrier.requestIntent !== undefined,
            )
            const result = {
              prepared: true,
              taskType: state.taskType,
              originalTask: state.task,
              ...(state.requestIntent
                ? { requestIntent: state.requestIntent }
                : {}),
              ...(state.requestIntent &&
              requestIntentIsUnresolved(state.requestIntent)
                ? {
                    requestInterpretation: requestInterpretationRecovery(
                      state.requestIntent,
                      state.requestIntentContext,
                      true,
                    ),
                  }
                : {}),
              memoryOwner: state.memoryOwner,
              permissions: 'unchanged_native_policy',
              programExecuted: false,
            }
            return {
              isError: false,
              value: {
                logs: ['Host intake prepared. No program was evaluated.'],
                result,
              },
              content: [{ type: 'text', text: JSON.stringify(result) }],
            }
          } catch (error) {
            if (!(error instanceof RequestClarification)) throw error
            const result = {
              ...((await this.clarify(
                state,
                execution.signal,
                error,
              )) as object),
              programExecuted: false,
            }
            return {
              isError: false,
              value: {
                logs: ['Execution was not prepared. No program was evaluated.'],
                result,
              },
              content: [{ type: 'text', text: JSON.stringify(result) }],
            }
          }
        },
        { prepend: true },
      ),
    )
    this.#disposers.push(
      tools.guard((execution) => {
        if (this.#stopped || execution.signal.aborted)
          return 'On-demand intake is stopped or cancelled'
        if (execution.agent && this.host.nativeChild?.(execution.agent))
          return undefined
        if (this.isControl(execution)) return undefined
        const state = this.bound(execution),
          actual = this.definition(execution)
        if (!actual) return 'Unknown native tool definition'
        if (!state) {
          if (
            execution.agent?.session &&
            this.#turns.has(execution.agent.session.id)
          )
            return 'Stale on-demand native turn'
          const turn = this.existingTurn(execution)
          return execution.agent &&
            turn !== undefined &&
            this.host.ready(execution.agent, turn)
            ? undefined
            : 'No current native request for tool execution'
        }
        const proof = this.#executions.get(execution)
        if (
          !proof ||
          proof.turn !== state ||
          proof.execute !== actual.execute ||
          ['closed', 'stale', 'capturing'].includes(state.status)
        )
          return 'Tool execution has no current on-demand preparation'
        if (proof.nativeCommandDigest !== undefined)
          return this.nativeCommand(execution)
            ? undefined
            : 'Native command identity or arguments changed'
        if (proof.nativeLispDigest !== undefined)
          return this.nativeLisp(execution)
            ? undefined
            : 'Native Lisp identity or arguments changed'
        if (proof.evidenceReadDigest !== undefined)
          return state.status === 'answer' &&
            execution.parent === undefined &&
            NATIVE_EVIDENCE_READS.has(execution.name) &&
            canonicalContentHash(execution.arguments) ===
              proof.evidenceReadDigest
            ? undefined
            : 'Native evidence read identity or arguments changed'
        if (proof.nativeUnownedDigest !== undefined)
          return this.unownedNative(execution)
            ? undefined
            : 'Native unowned execution proof changed'
        if (proof.carrier)
          return (state.status === 'answer' ||
            (state.status === 'prepared' &&
              this.host.ready(state.input.agent, state.input.turn))) &&
            canonicalContentHash(
              preparationCarrier(execution.arguments) ?? null,
            ) === proof.carrierDigest
            ? undefined
            : 'Preparation carrier is not current'
        if (proof.skillRead)
          return state.status === 'answer' &&
            actual.execute === this.#skillReaders.get(state.input.agent)
            ? undefined
            : 'Conversational Skill read is not current'
        if (execution.name === TASK_PREPARE_TOOL)
          return actual.execute === definition.execute &&
            (state.status === 'answer' ||
              (state.status === 'prepared' &&
                this.host.ready(state.input.agent, state.input.turn)))
            ? undefined
            : 'Task preparation is not current'
        return state.status === 'prepared' &&
          this.host.ready(state.input.agent, state.input.turn)
          ? undefined
          : 'Execution task is not prepared'
      }),
    )
  }
  answerOwner(
    session: object & { id: string },
  ): { agent: DemandAgent; workspace: string } | undefined {
    if (this.#stopped) return undefined
    const state = this.#turns.get(session.id)
    if (
      !state ||
      state.status !== 'answer' ||
      state.input.agent.session !== session ||
      state.memoryOwner !== 'conversation'
    )
      return undefined
    const owner = this.host.answerContext?.owner(
      session,
      this.ownerIdentity(state),
    )
    return state.input.agent === owner?.agent ? owner : undefined
  }
  retire(agent: DemandAgent): void {
    this.host.answerContext?.retire(agent)
    const state = agent.session && this.#turns.get(agent.session.id)
    if (
      state?.input.agent !== agent ||
      state.input.agent.session !== agent.session
    )
      return
    state.controller.abort(new Error('Native agent disposed'))
    state.status = 'closed'
    this.#turns.delete(agent.session!.id)
    this.#clarifications.delete(agent.session!.id)
  }
  stop(): void {
    this.#clarifications.clear()
    this.#stopped = true
    this.#lifecycle.abort(new Error('On-demand intake stopped'))
  }
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending])
  }
  async dispose(): Promise<void> {
    this.stop()
    await this.drain()
    for (const dispose of this.#disposers.reverse()) dispose()
  }
}
