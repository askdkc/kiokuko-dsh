import { canonicalContentHash } from '../serialization/validate.js'
import { MODEL_TOOL_OPERATION_NAMES, type ModelToolOperationName } from '../model-tools/contracts.js'
import { modelFacingInputSchema, modelToolContract, type JsonSchema } from '../model-tools/registry.js'
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

export const DSH_HOST_ONLY_OPERATIONS = [
  'task_prepare',
  'task_answer',
  'enno_advice_submit',
  'enno_advice_read',
  'enno_answer',
  'enno_verify_prepare',
  'curator_globalize',
] as const satisfies readonly ModelToolOperationName[]

export type DshModelFacingOperation = (typeof DSH_MODEL_FACING_OPERATIONS)[number]
export type DshHostOnlyOperation = (typeof DSH_HOST_ONLY_OPERATIONS)[number]

const modelFacingSet = new Set<string>(DSH_MODEL_FACING_OPERATIONS)
const hostOnlySet = new Set<string>(DSH_HOST_ONLY_OPERATIONS)

if (new Set([...DSH_MODEL_FACING_OPERATIONS, ...DSH_HOST_ONLY_OPERATIONS]).size !== MODEL_TOOL_OPERATION_NAMES.length) {
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
  readonly agent?: { readonly id: string; readonly session?: { readonly id: string }; readonly sessionId?: string; readonly turn?: number }
  readonly parent?: unknown
  readonly signal: AbortSignal
}

export interface DshToolHostBinding {
  /** Host-bound native session identity; never supplied by model arguments. */
  readonly dshSessionId?: string
  readonly runId: string
  readonly workspace: string
  readonly orchestrationId: string
  readonly revision: number
  readonly routeEpoch: number
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
      ...(execution.agent.turn === undefined ? {} : { turn: execution.agent.turn }),
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
  return `Kiokuko ${operation} semantic operation. Host identity, routing, lease, and idempotency fields are supplied by the dsh host.`
}

/** Build the exact operation set; only model-facing tools receive wire schemas. */
export function createDshToolDefinitions(host: DshToolHost): readonly DshToolDefinition[] {
  return Object.freeze(MODEL_TOOL_OPERATION_NAMES.map((operation) => Object.freeze({
    name: operation,
    description: descriptionFor(operation),
    parameters: modelFacingSet.has(operation) ? modelFacingInputSchema(operation) : Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
    modelFacing: modelFacingSet.has(operation),
    // `{}` is the dsh JSON-schema spelling for any lossless JSON value. The
    // Kiokuko operation registry owns the input/output semantic schemas; this
    // declaration only satisfies dsh's native tool registration contract.
    output: {
      schema: Object.freeze({}),
      render: (_args: unknown, value: unknown) => Object.freeze([{
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value),
      }]),
    },
    execute: async (args: unknown, rawExecution: DshToolExecution | DshNativeToolExecution): Promise<unknown> => {
      const normalized = normalizeExecution(rawExecution)
      if (normalized.name !== operation) throw new KiokukoError('CONFLICT', 'dsh tool definition and execution operation differ')
      // The first argument is the actual parsed tool payload. Rebind it onto
      // the execution before checking host-owned fields; never rely on a
      // duplicate metadata copy supplied by the native runtime.
      const execution = Object.freeze({ ...normalized, arguments: args })
      const binding = bindDshToolInvocation(execution, host.bind(execution))
      return host.execute(operation, args, binding, execution.signal)
    },
  })))
}

/** Register only tools that dsh may expose to the model. Host-only operations
 * remain available to the explicit Kiokuko host adapter, never as model tools. */
export function createDshModelToolDefinitions(host: DshToolHost): readonly DshToolDefinition[] {
  return Object.freeze(createDshToolDefinitions(host).filter((definition) => definition.modelFacing))
}

/** Register all operations and return a reverse-order disposer. */
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

export function isDshHostOnlyOperation(name: string): name is DshHostOnlyOperation {
  return hostOnlySet.has(name)
}
