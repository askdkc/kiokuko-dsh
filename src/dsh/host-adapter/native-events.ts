import type { Context } from '@deepseek-ai/cordis'
import type { DshLogEvent } from '../session-memory-finalizer.js'
import type { DshImageAttachmentRef } from '../session-log-mirror.js'
import type { RoutableAgent } from '../model-routing.js'

export interface NativeSkills {
  registerProvider(create: (control: { readonly signal: AbortSignal }) => unknown): () => void
  snapshot?(options?: unknown): Promise<{
    readonly skills: readonly { name: string; description?: string; invocation?: { modelInvocable?: boolean } }[]
    readonly complete: boolean
  }>
}

export interface NativeTools {
  register(definition: unknown): () => void
  guard(guard: (execution: unknown) => string | undefined): () => void
  schemas?(scope?: unknown): readonly { name: string; description?: string }[] | PromiseLike<readonly { name: string; description?: string }[]>
}

export interface NativeCommands { register(...args: any[]): () => void }
export interface NativeSessions {
  get(id: string): { id: string; header?: { cwd?: string; parentSession?: string; origin?: string; delegationDepth?: number }; snapshotEvents?: () => readonly DshLogEvent[] } | undefined
  flush?(session: object): PromiseLike<unknown>
}
export interface NativeAgent {
  readonly id: string
  readonly status?: string
  readonly session?: { readonly id: string; readonly header?: { readonly cwd?: string; readonly parentSession?: string; readonly origin?: string; readonly delegationDepth?: number }; snapshotEvents?: () => readonly DshLogEvent[] }
  readonly inject?: (message: unknown) => void
  readonly steer?: (message: unknown) => void
  readonly followup?: (message: unknown) => void
}
export interface NativeAgents {
  get(id: string): NativeAgent | undefined
  list?(): readonly NativeAgent[]
}
export interface NativeAttachments {
  readImage(ref: DshImageAttachmentRef, signal?: AbortSignal): Promise<{
    readonly ref: DshImageAttachmentRef
    readonly data: Uint8Array
  }>
}

export interface AdapterContext extends Context {
  get(name: string, strict?: boolean): unknown
}

interface NativeEventArguments {
  'agent/request': [event: unknown, next: () => Promise<unknown>]
  'agent/inbox/claimed': [event: { agent: RoutableAgent; turn: number; message: unknown }]
  'llm/stream': [request: unknown, next: () => AsyncIterable<unknown>]
  'agent/created': [event: { agent: RoutableAgent }]
  'agent/request-error': [event: { agent: RoutableAgent; failure: unknown }, next: () => Promise<unknown>]
  'agent/session-start': [event: { agent: NativeAgent }]
  'tools/execute': [execution: { agent?: object; name: string; arguments: unknown }, next: () => Promise<unknown>]
  'tools/result': [execution: { agent?: NativeAgent; parent?: unknown; callId?: string; name?: string }, result: unknown]
  'agent/error': [event: { agent: NativeAgent & { sessionId?: string }; error?: unknown }]
  'session/event': [session: { id: string }, event: { type?: unknown; seq?: unknown; data?: unknown }]
  'agent/idle': [agent: NativeAgent]
  'agent/pre-step': [event: { agent?: NativeAgent }, next: () => unknown]
  'session/disposed': [session: { id: string }]
}

export type NativeEventName = keyof NativeEventArguments
export interface NativeEventOptions { readonly prepend?: boolean; readonly global?: boolean }

/** One cast at the Cordis/native boundary; the original receiver and listener remain intact. */
export function onNativeEvent<K extends NativeEventName>(
  context: object,
  name: K,
  listener: (...args: NativeEventArguments[K]) => unknown,
  options?: NativeEventOptions,
): () => void {
  const source = context as unknown as { on(name: string, listener: (...args: any[]) => unknown, options?: NativeEventOptions): () => void }
  return options === undefined ? source.on(name, listener) : source.on(name, listener, options)
}

/** Adapter for service APIs that supply their own event names and signatures. */
export function onNativeServiceEvent(context: object, name: string, listener: (...args: any[]) => unknown, options?: NativeEventOptions): () => void {
  const source = context as unknown as { on(name: string, listener: (...args: any[]) => unknown, options?: NativeEventOptions): () => void }
  return options === undefined ? source.on(name, listener) : source.on(name, listener, options)
}
