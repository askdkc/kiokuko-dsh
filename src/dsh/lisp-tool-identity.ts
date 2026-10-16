import { AsyncLocalStorage } from 'node:async_hooks'
import { canonicalContentHash } from '../serialization/validate.js'

/** Host-minted implementation identity, never a tool-name permission grant. */
const implementations = new WeakSet<object>()
export function rememberLispImplementation(execute: object): void { implementations.add(execute) }
export function isLispImplementation(execute: unknown): boolean { return typeof execute === 'function' && implementations.has(execute) }

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
interface NativeCommandScope { execution: CommandExecution; execute: unknown; digest: string; admission: RootLispAdmission }
const commands = new AsyncLocalStorage<NativeCommandScope>()
/** A host-only, exact-call bridge. Arbitrary nested tools cannot inherit the exception. */
export function withLispNativeCommand<T>(execution: CommandExecution, execute: unknown, admission: RootLispAdmission, run: () => Promise<T>): Promise<T> {
  return commands.run({ execution, execute, admission, digest: canonicalContentHash(execution.arguments) }, run)
}
export function isLispNativeCommand(execution: CommandExecution, execute: unknown): boolean {
  const scope = commands.getStore(), expected = scope?.execution
  return !!scope && !!expected && scope.admission.current() && !execution.signal.aborted && !expected.signal.aborted
    && execution.name === expected.name && execution.callId === expected.callId && execution.agent === expected.agent
    && execution.parent === expected.parent && scope.execute === execute && scope.digest === canonicalContentHash(execution.arguments)
}

/** A capability created by the Lisp surface from the admitted root execution. */
export interface LispNativeCommands {
  assertCurrent(): void
  run(input: { program: string; argv: string[]; directory?: string | undefined; timeoutMs: number }, signal: AbortSignal): Promise<unknown>
}
