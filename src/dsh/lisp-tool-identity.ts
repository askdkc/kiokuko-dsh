import { AsyncLocalStorage } from 'node:async_hooks'
import { canonicalContentHash } from '../serialization/validate.js'

/** Host-minted implementation identity, never a tool-name permission grant. */
const implementations = new WeakSet<object>()
export function rememberLispImplementation(execute: object): void { implementations.add(execute) }
export function isLispImplementation(execute: unknown): boolean { return typeof execute === 'function' && implementations.has(execute) }

/** Journal queries are independent of the worker; a live ref is not. */
export function isJournalLispInspection(execution: { name: string; arguments?: unknown; parent?: unknown }): boolean {
  if (execution.name !== 'lisp_inspect' || execution.parent !== undefined || !execution.arguments || typeof execution.arguments !== 'object') return false
  const args = execution.arguments as Record<string, unknown>
  if (args.ref !== undefined) return false
  if (typeof args.managedOperationId === 'string')
    return [args.resultOperationId, args.section, args.pointer, args.offset, args.limit].every(value => value === undefined)
  return args.managedOperationId === undefined && typeof args.resultOperationId === 'string'
}

const conversations = new WeakMap<object, () => boolean>()
export function rememberLispConversation(agent: object, current: () => boolean): void { conversations.set(agent, current) }
export function isLispConversation(agent: object): boolean { return conversations.get(agent)?.() === true }

export interface RootLispAdmission { current(): boolean }
const admissions = new WeakMap<object, RootLispAdmission>()
/** Lives only while this exact native root dispatch is awaiting its implementation. */
export async function withRootLispAdmission<T>(execution: object, current: () => boolean, run: () => Promise<T>): Promise<T> {
  const admission = { current: () => admissions.get(execution) === admission && current() }
  admissions.set(execution, admission)
  try { return await run() } finally { admissions.delete(execution) }
}
export function rootLispAdmission(execution: object): RootLispAdmission | undefined {
  const admission = admissions.get(execution)
  return admission?.current() ? admission : undefined
}

interface CommandExecution { name: string; callId: string; agent?: unknown; parent?: unknown; arguments: unknown; signal: AbortSignal }
interface NativeCommandScope {
  execution: CommandExecution; execute: unknown; digest: string; admission: RootLispAdmission
  argv?: readonly string[]
  observation?: Promise<unknown>
}
const commands = new AsyncLocalStorage<NativeCommandScope>()
/** A host-only, exact-call bridge. Arbitrary nested tools cannot inherit the exception. */
export function withLispNativeCommand<T>(execution: CommandExecution, execute: unknown, admission: RootLispAdmission, run: () => Promise<T>, argv?: readonly string[]): Promise<T> {
  const scope: NativeCommandScope = { execution, execute, admission, digest: canonicalContentHash(execution.arguments), ...(argv ? { argv: [...argv] } : {}) }
  return commands.run(scope, async () => {
    const result = await run()
    await scope.observation
    return result
  })
}
export function currentLispNativeCommand(execution: CommandExecution): NativeCommandScope | undefined {
  const scope = commands.getStore(), expected = scope?.execution
  return !!scope && !!expected && scope.admission.current() && !execution.signal.aborted && !expected.signal.aborted
    && execution.name === expected.name && execution.callId === expected.callId && execution.agent === expected.agent
    && execution.parent === expected.parent && scope.digest === canonicalContentHash(execution.arguments)
    ? scope : undefined
}
export function isLispNativeCommand(execution: CommandExecution, execute: unknown): boolean {
  const scope = currentLispNativeCommand(execution)
  return !!scope && scope.execute === execute
}

/** CLI denial fences receive only a frozen name/arguments/agent projection.
 * This is route selection, never an execution grant: the native dispatcher and
 * intake still validate the full exact-call capability independently.
 */
export function isLispNativeCommandFence(execution: Pick<CommandExecution, 'name' | 'arguments' | 'agent'>, execute: unknown): boolean {
  const expected = commands.getStore()?.execution
  return !!expected && isLispNativeCommand(expected, execute)
    && execution.name === expected.name && execution.agent === expected.agent
    && canonicalContentHash(execution.arguments) === canonicalContentHash(expected.arguments)
}

type OwnedCommand = Pick<CommandExecution, 'name' | 'callId' | 'agent'>
const ownedCommands = new AsyncLocalStorage<OwnedCommand & { command: string; argv: readonly string[] }>()

/** Supply argv to completion matching for the exact owned call, without granting tool access. */
export function withLispOwnedCommand<T>(execution: OwnedCommand, command: string, argv: readonly string[], run: () => Promise<T>): Promise<T> {
  return ownedCommands.run({ name: execution.name, callId: execution.callId, agent: execution.agent, command, argv: [...argv] }, run)
}
export function lispOwnedCommandArgv(execution: OwnedCommand, command: string): readonly string[] | undefined {
  const scope = ownedCommands.getStore()
  return scope?.name === execution.name && scope.callId === execution.callId && scope.agent === execution.agent
    && scope.command === command ? scope.argv : undefined
}

/** A capability created by the Lisp surface from the admitted root execution. */
export interface LispNativeCommands {
  /** Select once from host capabilities; never switch routes after a denial. */
  processRoute?: 'native' | 'owned'
  assertCurrent(): void
  run(input: { program: string; argv: string[]; directory?: string | undefined; timeoutMs: number }, signal: AbortSignal): Promise<unknown>
}
