import { canonicalContentHash } from '../serialization/validate.js'
import { MODEL_TOOL_OPERATION_NAMES, type ModelToolOperationName } from '../model-tools/contracts.js'
import { modelFacingInputSchema, modelFacingTransportSchema, modelToolContract, type JsonSchema } from '../model-tools/registry.js'
import { KiokukoError } from '../errors.js'

export const DSH_MODEL_FACING_OPERATIONS = [
  'enno_plan_submit',
  'enno_ideal_submit',
  'enno_work_report',
  'enno_finish',
  'enno_meditation_submit',
  'curator_check',
  'memory_checkpoint',
] as const satisfies readonly ModelToolOperationName[]

export type DshModelFacingOperation = (typeof DSH_MODEL_FACING_OPERATIONS)[number]

const modelFacingSet = new Set<string>(DSH_MODEL_FACING_OPERATIONS)
if (new Set(DSH_MODEL_FACING_OPERATIONS).size !== MODEL_TOOL_OPERATION_NAMES.length) {
  throw new Error('dsh tool ownership must cover the exact Kiokuko operation set once')
}

export interface DshToolExecution {
  readonly callId: string
  readonly rootCallId?: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: {
    readonly dshSessionId: string
    /** Optional logical turn metadata; native ToolExecution does not carry it. */
    readonly turn?: number
    /** Opaque native Session object used to prevent same-ID cross-lifecycle rebinding. */
    readonly nativeSession?: object
  }
  readonly parent?: unknown
  readonly origin?: 'model' | 'host'
  readonly signal: AbortSignal
  /** Native DSH turn boundary marker; absent from direct unit callers. */
  readonly concludeTurn?: () => void
}

/**
 * The execution shape supplied by dsh-tools.  This is intentionally a
 * structural type: the plugin package must not take a hard dependency on a
 * particular dsh package graph just to expose the bundle entrypoint.
 */
export interface DshNativeToolExecution {
  readonly callId: string
  readonly rootCallId?: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly id: string; readonly session?: { readonly id: string }; readonly sessionId?: string }
  readonly parent?: unknown
  readonly signal: AbortSignal
  readonly concludeTurn?: () => void
}

export interface DshToolHostBinding {
  /** Host-bound native session identity; never supplied by model arguments. */
  readonly dshSessionId?: string
  readonly runId: string
  readonly workspace: string
  readonly orchestrationId: string
  readonly deliveryId?: string
  readonly revision: number
  readonly routeEpoch: number
  readonly advisoryRoundDigest?: string
  readonly leaseToken?: string
  readonly workUnitId?: string
  readonly idempotencyKey: string
}

export interface DshToolDefinition {
  readonly name: ModelToolOperationName
  readonly description: string
  readonly parameters: JsonSchema
  readonly modelFacing: boolean
  /** dsh-tools requires this output declaration for native registration. */
  readonly output: {
    readonly schema: JsonSchema
    readonly render: (args: unknown, value: unknown) => readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly execute: (args: unknown, execution: DshToolExecution | DshNativeToolExecution) => Promise<unknown>
}

export interface DshToolHost {
  readonly bind: (execution: DshToolExecution) => Omit<DshToolHostBinding, 'idempotencyKey'>
  readonly execute: (operation: ModelToolOperationName, args: unknown, binding: DshToolHostBinding, signal?: AbortSignal) => Promise<unknown>
}

export interface DshToolRegistrationContext {
  readonly tools: {
    register(definition: DshToolDefinition): () => void
  }
}

function normalizeExecution(execution: DshToolExecution | DshNativeToolExecution): DshToolExecution {
  // Internal executions carry only the host-owned dshSessionId; native
  // executions are identified by the authoritative Agent id. Do not trust a
  // forged dshSessionId property on a native Agent to bypass session binding.
  if (execution.agent === undefined || !('id' in execution.agent)) return execution as DshToolExecution
  const session = execution.agent.session
  if (session === undefined || typeof session.id !== 'string' || session.id.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'dsh native tool execution is missing its authoritative session')
  }
  return {
    callId: execution.callId,
    ...(execution.rootCallId === undefined ? {} : { rootCallId: execution.rootCallId }),
    name: execution.name,
    arguments: execution.arguments,
    agent: {
      dshSessionId: session.id,
      nativeSession: session,
    },
    ...(execution.parent === undefined ? {} : { parent: execution.parent }),
    signal: execution.signal,
  }
}

function validCallId(callId: unknown): string {
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(callId)) {
    throw new KiokukoError('VALIDATION_ERROR', 'dsh tool call identity is invalid')
  }
  return callId
}

function validBindingText(value: unknown, label: string, maximum = 4_096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `dsh ${label} is invalid`)
  }
}

function validOperation(name: unknown): ModelToolOperationName {
  if (typeof name !== 'string' || !MODEL_TOOL_OPERATION_NAMES.includes(name as ModelToolOperationName)) {
    throw new KiokukoError('NOT_FOUND', 'dsh tool is not registered')
  }
  return name as ModelToolOperationName
}

function ownKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.keys(value)
}

function containsHostIdentity(value: unknown, forbidden: ReadonlySet<string>, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return true
  seen.add(value)
  if (ownKeys(value).some((key) => forbidden.has(key))) return true
  return Array.isArray(value)
    ? value.some((item) => containsHostIdentity(item, forbidden, seen))
    : Object.values(value).some((item) => containsHostIdentity(item, forbidden, seen))
}

/** Derive one stable idempotency key for a direct or nested dsh tool call. */
export function dshToolIdempotencyKey(execution: Pick<DshToolExecution, 'callId' | 'rootCallId' | 'name' | 'agent'>): string {
  const callId = validCallId(execution.rootCallId ?? execution.callId)
  if (execution.agent !== undefined) {
    if (typeof execution.agent.dshSessionId !== 'string' || execution.agent.dshSessionId.length === 0 || execution.agent.dshSessionId.length > 256
      || /[\p{Cc}\p{Cf}]/u.test(execution.agent.dshSessionId)
      || (execution.agent.turn !== undefined && (!Number.isSafeInteger(execution.agent.turn) || execution.agent.turn < 0))) {
      throw new KiokukoError('VALIDATION_ERROR', 'dsh agent identity is invalid')
    }
  }
  return `dsh-tool:${canonicalContentHash({
    version: 1,
    callId,
    name: validOperation(execution.name),
    agent: execution.agent === undefined
      ? null
      : { dshSessionId: execution.agent.dshSessionId, ...(execution.agent.turn === undefined ? {} : { turn: execution.agent.turn }) },
  })}`
}

/** Bind host-owned identity after model arguments have crossed the boundary. */
export function bindDshToolInvocation(
  execution: DshToolExecution,
  state: Omit<DshToolHostBinding, 'idempotencyKey'>,
): DshToolHostBinding {
  const operation = validOperation(execution.name)
  validCallId(execution.callId)
  const forbiddenFields = new Set(modelToolContract(operation).hostOwnedFields)
  if (containsHostIdentity(execution.arguments, forbiddenFields)) {
    throw new KiokukoError('SECURITY_REJECTION', 'dsh tool arguments contain host-owned identity')
  }
  validBindingText(state.runId, 'run identity')
  if (state.dshSessionId !== undefined) validBindingText(state.dshSessionId, 'session identity', 256)
  validBindingText(state.workspace, 'workspace')
  validBindingText(state.orchestrationId, 'orchestration identity')
  if (state.deliveryId !== undefined) validBindingText(state.deliveryId, 'delivery identity')
  if (state.advisoryRoundDigest !== undefined && !/^[0-9a-f]{64}$/u.test(state.advisoryRoundDigest)) {
    throw new KiokukoError('VALIDATION_ERROR', 'dsh advisory round digest is invalid')
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 1
    || !Number.isSafeInteger(state.routeEpoch) || state.routeEpoch < 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'dsh host binding is invalid')
  }
  if (state.workUnitId !== undefined) validBindingText(state.workUnitId, 'WorkUnit identity')
  if (state.leaseToken !== undefined) validBindingText(state.leaseToken, 'lease token')
  if (operation === 'enno_work_report' && (state.workUnitId === undefined || state.leaseToken === undefined)) {
    throw new KiokukoError('CONFLICT', 'dsh WorkUnit report requires the current host lease')
  }
  return Object.freeze({ ...state, idempotencyKey: dshToolIdempotencyKey(execution) })
}

function descriptionFor(operation: ModelToolOperationName): string {
  return `Kiokuko ${operation} semantic operation. Supply nested values as their native JSON types; never encode an object or array as a JSON string. Host identity, routing, lease, and idempotency fields are supplied by the dsh host. The result is a TurnOutcome: applied results carry the business response in value and the next-turn state in handoff; predictable rejections return retry or clarify without a tool transport error. The business payload contract is: ${JSON.stringify(modelFacingInputSchema(operation))}`
}

function ennoNextAction(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const outcome = value as { kind?: unknown }
  const businessValue = outcome.kind === 'applied' && 'value' in outcome
    ? (outcome as { value?: unknown }).value
    : value
  if (typeof businessValue !== 'object' || businessValue === null || Array.isArray(businessValue)) return undefined
  const ennoOduno = (businessValue as { ennoOduno?: unknown }).ennoOduno
  if (typeof ennoOduno !== 'object' || ennoOduno === null || Array.isArray(ennoOduno)) return undefined
  const nextAction = (ennoOduno as { nextAction?: unknown }).nextAction
  return typeof nextAction === 'string' && nextAction.length > 0 ? nextAction : undefined
}

function concludesDshTurn(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const outcome = value as { kind?: unknown }
  if (outcome.kind === 'retry' || outcome.kind === 'clarify' || outcome.kind === 'waiting_user') return true
  const nextAction = ennoNextAction(value)
  // Every successful phase mutation owns one model turn.  The durable seal is
  // committed with the Enno receipt before this marker is observed. Terminal
  // states are the exception: the model must consume the successful result and
  // emit the user-facing completion/blocker report before the native turn ends.
  return nextAction !== undefined && nextAction !== 'complete' && nextAction !== 'report_blocker'
}

const TERMINAL_REPORT_INSTRUCTION = "Kiokuko reached a terminal state. Do not call another tool. Return a visible final assistant response in the user's language now. Lead with the outcome; summarize what changed, the verification performed and its results, and any remaining issues or uncertainty. Do not expose internal Enno/DSH identities or protocol fields."

function renderDshToolResult(value: unknown): readonly { readonly type: 'text'; readonly text: string }[] {
  const blocks = [{
    type: 'text' as const,
    text: typeof value === 'string' ? value : JSON.stringify(value),
  }]
  const nextAction = ennoNextAction(value)
  if (nextAction === 'complete' || nextAction === 'report_blocker') {
    blocks.push({ type: 'text', text: TERMINAL_REPORT_INSTRUCTION })
  }
  return Object.freeze(blocks)
}

/** Build the exact seven-operation model tool set. */
export function createDshToolDefinitions(host: DshToolHost): readonly DshToolDefinition[] {
  return Object.freeze(MODEL_TOOL_OPERATION_NAMES.map((operation) => Object.freeze({
    name: operation,
    description: descriptionFor(operation),
    // DSH validates this transport schema before invoking the handler. Publish
    // the actual JSON shape so a nested object cannot arrive double-encoded as
    // a string, but leave requiredness and value rules to business validation.
    parameters: Object.freeze(modelFacingTransportSchema(operation)),
    modelFacing: modelFacingSet.has(operation),
    // `{}` is the dsh JSON-schema spelling for any lossless JSON value. The
    // Kiokuko operation registry owns the input/output semantic schemas; this
    // declaration only satisfies dsh's native tool registration contract.
    output: {
      schema: Object.freeze({}),
      render: (_args: unknown, value: unknown) => renderDshToolResult(value),
    },
    execute: async (args: unknown, rawExecution: DshToolExecution | DshNativeToolExecution): Promise<unknown> => {
      const normalized = normalizeExecution(rawExecution)
      if (normalized.name !== operation) throw new KiokukoError('CONFLICT', 'dsh tool definition and execution operation differ')
      // The first argument is the actual parsed tool payload. Rebind it onto
      // the execution before checking host-owned fields; never rely on a
      // duplicate metadata copy supplied by the native runtime.
      const execution = Object.freeze({ ...normalized, arguments: args })
      const binding = bindDshToolInvocation(execution, host.bind(execution))
      const value = await host.execute(operation, args, binding, execution.signal)
      // The result's nextAction, rather than the operation name, owns the turn
      // boundary. DSH appends successful tool/results before observing
      // concludeTurn. Terminal results deliberately stay open for one final,
      // visible assistant response.
      if (concludesDshTurn(value)) rawExecution.concludeTurn?.()
      return value
    },
  })))
}

/** Return the exact tools that DSH may expose to the model. */
export function createDshModelToolDefinitions(host: DshToolHost): readonly DshToolDefinition[] {
  return Object.freeze(createDshToolDefinitions(host).filter((definition) => definition.modelFacing))
}

/** Register the exact model tool set and return a reverse-order disposer. */
export function mountDshTools(ctx: DshToolRegistrationContext, host: DshToolHost): () => void {
  const disposers = createDshToolDefinitions(host).map((definition) => ctx.tools.register(definition))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** Native dsh composition boundary: expose only model-facing operations. */
export function mountDshModelTools(ctx: DshToolRegistrationContext, host: DshToolHost): () => void {
  const disposers = createDshModelToolDefinitions(host).map((definition) => ctx.tools.register(definition))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export function isDshModelFacingOperation(name: string): name is DshModelFacingOperation {
  return modelFacingSet.has(name)
}
