import { KiokukoError } from '../errors.js'

export const PONYTAIL_MODES = ['lite', 'full', 'ultra'] as const
export type PonytailMode = (typeof PONYTAIL_MODES)[number]

export interface DshPonytailCommandContext {
  commands: {
    /** Legacy test/dsh shim or native @deepseek-ai/dsh-commands registration. */
    register: ((name: string, handler: (args: readonly string[]) => string) => () => void)
      | ((definition: DshNativeCommandDefinition) => () => void)
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
  #activeRequestId: string | undefined
  #mode: PonytailMode | undefined

  begin(requestId: string): void {
    if (requestId.length === 0 || requestId.length > 256 || /[\p{Cc}]/u.test(requestId)) throw new KiokukoError('VALIDATION_ERROR', 'requestId is invalid')
    if (this.#activeRequestId !== undefined && this.#activeRequestId !== requestId) throw new KiokukoError('CONFLICT', 'another logical request is already active')
    this.#activeRequestId = requestId
    this.#mode = undefined
  }

  isActive(requestId: string): boolean {
    return this.#activeRequestId === requestId
  }

  set(requestId: string, mode: PonytailMode): PonytailMode {
    if (this.#activeRequestId !== requestId) throw new KiokukoError('CONFLICT', 'ponytail is available only for the active logical request')
    if (!PONYTAIL_MODES.includes(mode)) throw new KiokukoError('VALIDATION_ERROR', 'Unknown ponytail mode')
    this.#mode = mode
    return mode
  }

  execute(args: readonly string[]): string {
    if (this.#activeRequestId === undefined) throw new KiokukoError('CONFLICT', 'ponytail is available only for the active logical request')
    const mode = this.set(this.#activeRequestId, parseMode(args))
    return `Ponytail mode set to ${mode} for the active request.`
  }

  mode(requestId: string): PonytailMode | undefined {
    return this.#activeRequestId === requestId ? this.#mode : undefined
  }

  end(requestId: string): boolean {
    if (this.#activeRequestId !== requestId) return false
    this.#activeRequestId = undefined
    this.#mode = undefined
    return true
  }

  dispose(): void {
    this.#activeRequestId = undefined
    this.#mode = undefined
  }
}

export function mountDshPonytailCommand(ctx: DshPonytailCommandContext, modes: DshPonytailModes): () => void {
  // Cordis test doubles and early dsh adapters used the two-argument helper;
  // dsh-commands uses one immutable definition object. Supporting both keeps
  // the domain command independent from the host package version while making
  // the native registration the default for the real harness.
  if (ctx.commands.register.length >= 2) {
    return (ctx.commands.register as (name: string, handler: (args: readonly string[]) => string) => () => void)('ponytail', (args) => modes.execute(args))
  }
  return (ctx.commands.register as (definition: DshNativeCommandDefinition) => () => void)({
    name: 'ponytail',
    description: 'Set the active Kiokuko request mode: lite, full, or ultra.',
    input: { hint: 'lite | full | ultra' },
    recordInput: true,
    handler: (invocation) => {
      try {
        const args = invocation.rawInput.trim().length === 0 ? [] : invocation.rawInput.trim().split(/\s+/u)
        return { kind: 'success', text: modes.execute(args) }
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
