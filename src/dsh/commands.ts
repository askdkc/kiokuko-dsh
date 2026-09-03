import { KiokukoError } from '../errors.js'

export const PONYTAIL_MODES = ['lite', 'full', 'ultra'] as const
export type PonytailMode = (typeof PONYTAIL_MODES)[number]

export interface DshPonytailCommandContext {
  commands: {
    register: (definition: DshNativeCommandDefinition) => () => void
  }
}

export interface DshNativeCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly recordInput?: boolean
  readonly handler: (invocation: DshNativeCommandInvocation) => DshNativeCommandResult | Promise<DshNativeCommandResult>
}

export interface DshNativeCommandInvocation {
  readonly rawInput: string
  readonly signal: AbortSignal
  readonly agent?: {
    readonly id: string
    readonly session?: { readonly id: string }
    readonly sessionId?: string
  }
}

export type DshNativeCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

function parseMode(args: readonly string[]): PonytailMode {
  if (args.length !== 1 || !PONYTAIL_MODES.includes(args[0] as PonytailMode)) {
    throw new KiokukoError('VALIDATION_ERROR', 'ponytail requires exactly one mode: lite, full, or ultra')
  }
  return args[0] as PonytailMode
}

/** Own request-local Ponytail state; it never changes global configuration. */
export class DshPonytailModes {
  readonly #modes = new Map<string, PonytailMode | undefined>()
  readonly #requestByOwner = new Map<string, string>()

  begin(requestId: string, owner?: string): void {
    if (requestId.length === 0 || requestId.length > 256 || /[\p{Cc}]/u.test(requestId)) throw new KiokukoError('VALIDATION_ERROR', 'requestId is invalid')
    if (!this.#modes.has(requestId)) this.#modes.set(requestId, undefined)
    if (owner !== undefined) {
      const previous = this.#requestByOwner.get(owner)
      if (previous !== undefined && previous !== requestId) this.end(previous)
      this.#requestByOwner.set(owner, requestId)
    }
  }

  isActive(requestId: string): boolean {
    return this.#modes.has(requestId)
  }

  set(requestId: string, mode: PonytailMode): PonytailMode {
    if (!this.#modes.has(requestId)) throw new KiokukoError('CONFLICT', 'ponytail is available only for the active logical request')
    if (!PONYTAIL_MODES.includes(mode)) throw new KiokukoError('VALIDATION_ERROR', 'Unknown ponytail mode')
    this.#modes.set(requestId, mode)
    return mode
  }

  execute(args: readonly string[], owner?: string): string {
    const requestId = owner === undefined
      ? this.#modes.size === 1 ? this.#modes.keys().next().value as string : undefined
      : this.#requestByOwner.get(owner)
    if (requestId === undefined) {
      const message = this.#modes.size === 0
        ? 'ponytail is available only for an active logical request'
        : owner === undefined && this.#modes.size > 1
          ? 'ponytail requires the current request scope when multiple requests are active'
          : 'ponytail is not active for the current request'
      throw new KiokukoError('CONFLICT', message)
    }
    const mode = this.set(requestId, parseMode(args))
    return `Ponytail mode set to ${mode} for the active request.`
  }

  mode(requestId: string): PonytailMode | undefined {
    return this.#modes.get(requestId)
  }

  end(requestId: string): boolean {
    const deleted = this.#modes.delete(requestId)
    if (!deleted) return false
    for (const [owner, activeRequestId] of this.#requestByOwner) {
      if (activeRequestId === requestId) this.#requestByOwner.delete(owner)
    }
    return deleted
  }

  dispose(): void {
    this.#modes.clear()
    this.#requestByOwner.clear()
  }
}

/** Stable owner key shared by turn admission and native command dispatch. */
export function dshPonytailOwnerKey(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`
}

export function mountDshPonytailCommand(ctx: DshPonytailCommandContext, modes: DshPonytailModes): () => void {
  return ctx.commands.register({
    name: 'ponytail',
    description: 'Set the active Kiokuko request mode: lite, full, or ultra.',
    input: { hint: 'lite | full | ultra' },
    recordInput: true,
    handler: (invocation) => {
      try {
        const args = invocation.rawInput.trim().length === 0 ? [] : invocation.rawInput.trim().split(/\s+/u)
        const sessionId = invocation.agent?.session?.id ?? invocation.agent?.sessionId
        const owner = invocation.agent === undefined || sessionId === undefined
          ? undefined
          : dshPonytailOwnerKey(invocation.agent.id, sessionId)
        return { kind: 'success', text: modes.execute(args, owner) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : 'Invalid Ponytail command.' }
      }
    },
  })
}

/** Bind the command handler to one active request without leaking that request identity into the command text. */
export function executeDshPonytailCommand(modes: DshPonytailModes, requestId: string, args: readonly string[]): string {
  if (!modes.isActive(requestId)) throw new KiokukoError('CONFLICT', 'ponytail is available only for the active logical request')
  return modes.execute(args)
}
