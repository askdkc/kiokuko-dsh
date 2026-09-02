import { canonicalJson, canonicalContentHash } from '../serialization/validate.js'
import { findSecretInValue } from '../memory/secrets.js'
import { advisorySlotDefinitions, normalizeAdvisoryContributions, advisoryRoundAggregate } from '../enno-oduno/advisory.js'
import { advisoryContributionSchemaPublic } from '../enno-oduno/schemas.js'
import {
  ADVISORY_MAX_ROUND_BYTES,
  ADVISORY_MAX_SLOT_BYTES,
  type AdvisoryContext,
  type AdvisoryContribution,
  type AdvisoryFanoutDirective,
  type AdvisoryPhase,
  type AdvisorySlotId,
} from '../enno-oduno/types.js'

export interface DshAdvisoryCall {
  readonly phase: AdvisoryPhase
  readonly slotId: AdvisorySlotId
  readonly rank: number
  readonly role: string
  readonly instructions: string
  readonly context: AdvisoryContext
  readonly tools: readonly []
  readonly signal: AbortSignal
}

export interface DshAdvisoryRunnerDependencies {
  readonly execute: (call: DshAdvisoryCall) => Promise<unknown>
  readonly verifyReadOnly: (call: DshAdvisoryCall) => boolean | PromiseLike<boolean>
  readonly timeoutMs?: number
}

export interface DshAdvisoryRoundResult {
  readonly phase: AdvisoryPhase
  readonly inputDigest: string
  readonly contributions: readonly AdvisoryContribution[]
  readonly degraded: boolean
}

function failure(slotId: AdvisorySlotId, reasonCode: 'host_read_only_unavailable' | 'host_execution_failed' | 'host_timeout' | 'invalid_response' | 'unsafe_output'): AdvisoryContribution {
  return { slotId, outcome: reasonCode === 'host_timeout' ? 'timeout' : reasonCode === 'host_read_only_unavailable' ? 'unavailable' : 'failed', reasonCode }
}

function boundedOutput(slotId: AdvisorySlotId, value: unknown): AdvisoryContribution {
  if (findSecretInValue(value) !== undefined) return failure(slotId, 'unsafe_output')
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > ADVISORY_MAX_SLOT_BYTES) return failure(slotId, 'invalid_response')
  const parsed = advisoryContributionSchemaPublic.safeParse(value)
  return parsed.success && parsed.data.slotId === slotId ? parsed.data as AdvisoryContribution : failure(slotId, 'invalid_response')
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) child.abort(parent.reason)
  const abort = () => child.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  return () => parent.removeEventListener('abort', abort)
}

async function runSlot(
  directive: AdvisoryFanoutDirective,
  slot: AdvisoryFanoutDirective['slots'][number],
  context: AdvisoryContext,
  dependencies: DshAdvisoryRunnerDependencies,
  parentSignal: AbortSignal,
): Promise<AdvisoryContribution> {
  const controller = new AbortController()
  const unlink = linkAbort(parentSignal, controller)
  const call: DshAdvisoryCall = {
    phase: directive.phase,
    slotId: slot.slotId,
    rank: slot.rank,
    role: slot.role,
    instructions: slot.instructions,
    context,
    tools: [],
    signal: controller.signal,
  }
  try {
    try {
      if (!(await dependencies.verifyReadOnly(call))) return failure(slot.slotId, 'host_read_only_unavailable')
    } catch {
      return failure(slot.slotId, 'host_execution_failed')
    }
    if (parentSignal.aborted) return failure(slot.slotId, 'host_execution_failed')
    const timeoutMs = dependencies.timeoutMs ?? 30_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('advisory timeout'))
        reject(new Error('advisory timeout'))
      }, timeoutMs)
    })
    let unlinkParentAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      if (parentSignal.aborted) reject(new Error('advisory aborted'))
      else {
        const onAbort = () => reject(new Error('advisory aborted'))
        parentSignal.addEventListener('abort', onAbort, { once: true })
        unlinkParentAbort = () => parentSignal.removeEventListener('abort', onAbort)
      }
    })
    try {
      const output = await Promise.race([dependencies.execute(call), timeout, aborted])
      try {
        return boundedOutput(slot.slotId, output)
      } catch {
        return failure(slot.slotId, 'invalid_response')
      }
    } catch (error) {
      return error instanceof Error && error.message === 'advisory timeout'
        ? failure(slot.slotId, 'host_timeout')
        : failure(slot.slotId, 'host_execution_failed')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      unlinkParentAbort?.()
    }
  } finally {
    unlink()
  }
}

/** Execute exactly the current phase's fixed three slots with no advisor authority. */
export class DshAdvisoryRunner {
  readonly #dependencies: DshAdvisoryRunnerDependencies

  constructor(dependencies: DshAdvisoryRunnerDependencies) {
    this.#dependencies = dependencies
    const timeoutMs = dependencies.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('advisory timeoutMs must be between 1 and 120000')
  }

  async run(input: {
    readonly directive: AdvisoryFanoutDirective
    readonly signal?: AbortSignal
  }): Promise<DshAdvisoryRoundResult> {
    const expected = advisorySlotDefinitions(input.directive.phase)
    if (input.directive.slots.length !== expected.length || input.directive.slots.some((slot, index) => (
      slot.slotId !== expected[index]?.slotId || slot.rank !== expected[index]?.rank || slot.role !== expected[index]?.role
    ))) throw new Error('Advisory directive slots do not match the fixed core slot set')
    const signal = input.signal ?? new AbortController().signal
    const contributions = await Promise.all(input.directive.slots.map((slot) => runSlot(
      input.directive,
      slot,
      input.directive.context,
      this.#dependencies,
      signal,
    )))
    const normalized = normalizeAdvisoryContributions(input.directive.phase, contributions)
    if (Buffer.byteLength(canonicalJson(normalized), 'utf8') > ADVISORY_MAX_ROUND_BYTES) throw new Error('Advisory round exceeds the safety limit')
    const aggregate = advisoryRoundAggregate(normalized)
    return Object.freeze({
      phase: input.directive.phase,
      inputDigest: canonicalContentHash({ phase: input.directive.phase, slots: expected, context: input.directive.context }),
      contributions: Object.freeze(aggregate.contributions),
      degraded: aggregate.degraded,
    })
  }
}
