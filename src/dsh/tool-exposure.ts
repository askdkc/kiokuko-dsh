import { z } from 'zod'
import { DSH_LEAN_DESCRIPTION_OPERATIONS, DSH_MODEL_FACING_OPERATIONS, leanDshToolDescription } from './tools.js'
import { hasKnownDshToolPolicyState, operationStateDenyCode, type DshToolPolicyState } from './tool-policy.js'
import { TASK_TYPES, type TaskType } from '../akinator/types.js'
import type { ModelRoute } from './model-configuration.js'

export const ToolExposureConfig = z.object({ mode: z.enum(['auto', 'full', 'phase', 'lean']).default('auto') }).strict()
export type ToolExposureConfig = z.infer<typeof ToolExposureConfig>

export type ResolvedToolExposureMode = 'full' | 'phase' | 'lean' | 'minimal'
export interface ToolExposureDecision {
  readonly mode: ResolvedToolExposureMode
  readonly reason: string
}

/** Decide presentation only; admission, ownership and runtime bindings are host concerns. */
export function resolveToolExposureMode(input: {
  mode: ToolExposureConfig['mode']; taskType: TaskType | null
  selectionMode: 'normal' | 'enno'; state: DshToolPolicyState;
  /** @deprecated Native projection does not depend on provider metadata. */
  route?: ModelRoute | undefined
}): ToolExposureDecision {
  if (input.mode !== 'auto') return { mode: input.mode, reason: 'explicit' }
  if (!hasKnownDshToolPolicyState(input.state)) return { mode: 'full', reason: 'unknown_state' }
  if (input.selectionMode === 'enno') return { mode: 'lean', reason: 'enno' }
  if (input.taskType === null || !TASK_TYPES.includes(input.taskType)) return { mode: 'full', reason: 'unknown_task' }
  if (['chat', 'research', 'analysis', 'writing', 'review'].includes(input.taskType)) return { mode: 'minimal', reason: 'task_minimal' }
  if (input.state.phase !== 'normal') return { mode: 'full', reason: 'normal_state_mismatch' }
  return { mode: 'lean', reason: 'task_execution' }
}

/** @deprecated Legacy OpenAI route query; native tool projection no longer uses this whitelist. */
export function supportsLeanToolExposureRoute(route: ModelRoute | undefined): boolean {
  return route?.family === 'openai' && route.connection === 'api'
    && (route.protocol === 'responses' || route.protocol === 'chat-completions')
}

export type ToolExposureProjectionReason = 'projected' | 'unchanged' | 'no_owned_tools' | 'ownership_unknown' | 'unknown_state' | 'unsupported_schema'

export interface ToolExposureMetrics {
  readonly toolCountBefore: number
  readonly toolCountAfter: number
  readonly taskFilteredCount: number
  readonly phaseFilteredCount: number
  readonly descriptionTransformedCount: number
  readonly descriptionBytesBefore: number
  readonly descriptionBytesAfter: number
  readonly parameterBytesBefore: number | null
  readonly parameterBytesAfter: number | null
  /** Unowned/native tools remain untouched because registration provenance is unavailable. */
  readonly unownedSurfaceReductionCount: 0
  readonly unownedSurfaceReductionReason: 'registration_provenance_unavailable'
}

export interface ToolExposureProjection<T> {
  readonly tools: readonly T[]
  readonly reason: ToolExposureProjectionReason
  readonly metrics: ToolExposureMetrics
}

interface PresentedTool {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

export function eligibleDshModelTools(state: DshToolPolicyState): ReadonlySet<string> {
  if (!hasKnownDshToolPolicyState(state)) return new Set()
  return new Set(DSH_MODEL_FACING_OPERATIONS.filter(operation => operationStateDenyCode(state, operation, 'model') === undefined))
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function parameterBytes(tools: readonly PresentedTool[]): number | null {
  try {
    return tools.reduce((total, tool) => {
      const serialized = JSON.stringify(tool.parameters ?? null)
      return serialized === undefined ? Number.NaN : total + byteLength(serialized)
    }, 0)
  } catch {
    return null
  }
}

function metrics<T extends PresentedTool>(original: readonly T[], projected: readonly T[], phaseFilteredCount: number, descriptionTransformedCount: number, taskFilteredCount = 0): ToolExposureMetrics {
  const before = parameterBytes(original)
  const after = parameterBytes(projected)
  return {
    toolCountBefore: original.length,
    toolCountAfter: projected.length,
    taskFilteredCount,
    phaseFilteredCount,
    descriptionTransformedCount,
    descriptionBytesBefore: original.reduce((total, tool) => total + byteLength(tool.description ?? ''), 0),
    descriptionBytesAfter: projected.reduce((total, tool) => total + byteLength(tool.description ?? ''), 0),
    parameterBytesBefore: Number.isNaN(before) ? null : before,
    parameterBytesAfter: Number.isNaN(after) ? null : after,
    unownedSurfaceReductionCount: 0,
    unownedSurfaceReductionReason: 'registration_provenance_unavailable',
  }
}

function unchanged<T extends PresentedTool>(tools: readonly T[], reason: ToolExposureProjectionReason): ToolExposureProjection<T> {
  return { tools, reason, metrics: metrics(tools, tools, 0, 0) }
}

function verifiedOwnedNames<T extends { readonly name: string }>(
  tools: readonly T[],
  state: DshToolPolicyState,
  registered: ReadonlyMap<string, { readonly execute: unknown }>,
  resolve: (name: string) => { readonly execute: unknown } | undefined,
): { readonly owned: ReadonlySet<string>; readonly reason?: ToolExposureProjectionReason } {
  if (!hasKnownDshToolPolicyState(state)) return { owned: new Set(), reason: 'unknown_state' }
  const candidates = tools.filter(tool => (DSH_MODEL_FACING_OPERATIONS as readonly string[]).includes(tool.name))
  if (candidates.length === 0) return { owned: new Set(), reason: 'no_owned_tools' }
  const owned = new Set<string>()
  for (const candidate of candidates) {
    const expected = registered.get(candidate.name)
    if (!expected) return { owned: new Set(), reason: 'ownership_unknown' }
    let actual: { readonly execute: unknown } | undefined
    try { actual = resolve(candidate.name) } catch { return { owned: new Set(), reason: 'ownership_unknown' } }
    if (!actual || typeof expected.execute !== 'function' || actual.execute !== expected.execute) {
      return { owned: new Set(), reason: 'ownership_unknown' }
    }
    owned.add(candidate.name)
  }
  return { owned }
}

function phaseProjection<T extends { readonly name: string }>(tools: readonly T[], owned: ReadonlySet<string>, state: DshToolPolicyState): readonly T[] {
  const eligible = eligibleDshModelTools(state)
  return tools.filter(tool => !owned.has(tool.name) || eligible.has(tool.name))
}

/** Return the original list unless each visible Kiokuko definition is proven to be the registered host definition. */
export function projectToolsForPhase<T extends PresentedTool>(
  tools: readonly T[],
  state: DshToolPolicyState,
  registered: ReadonlyMap<string, { readonly execute: unknown }>,
  resolve: (name: string) => { readonly execute: unknown } | undefined,
): ToolExposureProjection<T> {
  if (!hasKnownDshToolPolicyState(state)) return unchanged(tools, 'unknown_state')
  const ownership = verifiedOwnedNames(tools, state, registered, resolve)
  if (ownership.reason) return unchanged(tools, ownership.reason)
  const filtered = phaseProjection(tools, ownership.owned, state)
  const phaseFilteredCount = tools.length - filtered.length
  const projected = phaseFilteredCount === 0 ? tools : filtered
  const reason = phaseFilteredCount === 0 ? 'unchanged' : 'projected'
  return { tools: projected, reason, metrics: metrics(tools, projected, phaseFilteredCount, 0) }
}

/** Apply phase eligibility and exact-schema description deduplication to Kiokuko tools only. */
export function projectToolsForLean<T extends PresentedTool>(
  tools: readonly T[],
  state: DshToolPolicyState,
  registered: ReadonlyMap<string, { readonly execute: unknown }>,
  resolve: (name: string) => { readonly execute: unknown } | undefined,
): ToolExposureProjection<T> {
  if (!hasKnownDshToolPolicyState(state)) return unchanged(tools, 'unknown_state')
  const ownership = verifiedOwnedNames(tools, state, registered, resolve)
  if (ownership.reason) return unchanged(tools, ownership.reason)
  const eligibleTools = phaseProjection(tools, ownership.owned, state)
  const phaseFilteredCount = tools.length - eligibleTools.length
  const ownedLeanTools = eligibleTools.filter(tool => (DSH_LEAN_DESCRIPTION_OPERATIONS as readonly string[]).includes(tool.name))
  const compactDescriptions = new Map<string, string>()
  for (const tool of ownedLeanTools) {
    if (typeof tool.description !== 'string') return unchanged(tools, 'unsupported_schema')
    const compact = leanDshToolDescription(tool.name, tool.description)
    if (compact === undefined) return unchanged(tools, 'unsupported_schema')
    compactDescriptions.set(tool.name, compact)
  }
  let descriptionTransformedCount = 0
  const presented = eligibleTools.map(tool => {
    const description = compactDescriptions.get(tool.name)
    if (description === undefined || description === tool.description) return tool
    descriptionTransformedCount++
    return { ...tool, description } as T
  })
  const projected = phaseFilteredCount === 0 && descriptionTransformedCount === 0 ? tools : presented
  return {
    tools: projected,
    reason: phaseFilteredCount === 0 && descriptionTransformedCount === 0 ? 'unchanged' : 'projected',
    metrics: metrics(tools, projected, phaseFilteredCount, descriptionTransformedCount),
  }
}

/** Remove only identity-verified owned definitions; external tools retain their objects and order. */
export function projectToolsForMinimal<T extends PresentedTool>(
  tools: readonly T[], state: DshToolPolicyState,
  registered: ReadonlyMap<string, { readonly execute: unknown }>,
  resolve: (name: string) => { readonly execute: unknown } | undefined,
): ToolExposureProjection<T> {
  const ownership = verifiedOwnedNames(tools, state, registered, resolve)
  if (ownership.reason) return unchanged(tools, ownership.reason)
  const projected = tools.filter(tool => !ownership.owned.has(tool.name))
  return { tools: projected, reason: 'projected', metrics: metrics(tools, projected, 0, 0, tools.length - projected.length) }
}
