import { z } from 'zod'
import { DSH_MODEL_FACING_OPERATIONS } from './tools.js'
import { hasKnownDshToolPolicyState, operationStateDenyCode, type DshToolPolicyState } from './tool-policy.js'

export const ToolExposureConfig = z.object({ mode: z.enum(['full', 'phase']).default('full') }).strict()
export type ToolExposureConfig = z.infer<typeof ToolExposureConfig>

export type ToolExposureProjectionReason = 'projected' | 'unchanged' | 'no_owned_tools' | 'ownership_unknown' | 'unknown_state'

export function eligibleDshModelTools(state: DshToolPolicyState): ReadonlySet<string> {
  if (!hasKnownDshToolPolicyState(state)) return new Set()
  return new Set(DSH_MODEL_FACING_OPERATIONS.filter(operation => operationStateDenyCode(state, operation, 'model') === undefined))
}

/** Return the original list unless each visible Kiokuko definition is proven to be the registered host definition. */
export function projectToolsForPhase<T extends { readonly name: string }>(
  tools: readonly T[],
  state: DshToolPolicyState,
  registered: ReadonlyMap<string, { readonly execute: unknown }>,
  resolve: (name: string) => { readonly execute: unknown } | undefined,
): { readonly tools: readonly T[]; readonly reason: ToolExposureProjectionReason } {
  if (!hasKnownDshToolPolicyState(state)) return { tools, reason: 'unknown_state' }
  const candidates = tools.filter(tool => (DSH_MODEL_FACING_OPERATIONS as readonly string[]).includes(tool.name))
  if (candidates.length === 0) return { tools, reason: 'no_owned_tools' }
  const owned = new Set<string>()
  for (const candidate of candidates) {
    const expected = registered.get(candidate.name)
    if (!expected) return { tools, reason: 'ownership_unknown' }
    let actual: { readonly execute: unknown } | undefined
    try { actual = resolve(candidate.name) } catch { return { tools, reason: 'ownership_unknown' } }
    if (!actual || typeof expected.execute !== 'function' || actual.execute !== expected.execute) return { tools, reason: 'ownership_unknown' }
    owned.add(candidate.name)
  }
  const eligible = eligibleDshModelTools(state)
  const projected = tools.filter(tool => !owned.has(tool.name) || eligible.has(tool.name))
  return projected.length === tools.length
    ? { tools, reason: 'unchanged' }
    : { tools: projected, reason: 'projected' }
}
