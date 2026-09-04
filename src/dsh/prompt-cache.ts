import { canonicalContentHash, canonicalJson, compareCanonicalStrings } from '../serialization/validate.js'

export type DshStablePromptFragmentKind = 'system' | 'tool_schema' | 'skill' | 'memory'

export interface DshStablePromptFragment {
  readonly kind: DshStablePromptFragmentKind
  readonly id: string
  readonly value: unknown
}

export interface DshPromptCacheLayout {
  readonly cacheKey: string
  readonly provider: string
  readonly model: string
  readonly reasoning: string | null
  readonly toolSchemaDigest: string
  readonly memoryRevision: string
  readonly phase: string
  readonly fragmentJson: string
  readonly byteCount: number
}

const KIND_ORDER: Readonly<Record<DshStablePromptFragmentKind, number>> = Object.freeze({
  system: 0,
  tool_schema: 1,
  skill: 2,
  memory: 3,
})

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

/**
 * Canonicalize only stable prompt fragments. Variable conversation, tool
 * results, and model responses deliberately remain outside this cache.
 */
export function buildDshPromptCacheLayout(input: {
  readonly provider: string
  readonly model: string
  readonly reasoning?: string
  readonly toolSchema: unknown
  readonly memoryRevision: string
  readonly phase: string
  readonly fragments: readonly DshStablePromptFragment[]
}): DshPromptCacheLayout {
  const provider = boundedIdentity(input.provider, 'provider')
  const model = boundedIdentity(input.model, 'model')
  const reasoning = input.reasoning === undefined ? null : boundedIdentity(input.reasoning, 'reasoning')
  const memoryRevision = boundedIdentity(input.memoryRevision, 'memoryRevision')
  const phase = boundedIdentity(input.phase, 'phase')
  const fragments = [...input.fragments]
    .map((fragment) => ({
      kind: fragment.kind,
      id: boundedIdentity(fragment.id, 'fragment id'),
      value: fragment.value,
    }))
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || compareCanonicalStrings(left.id, right.id))
  const fragmentJson = canonicalJson(fragments)
  const toolSchemaDigest = canonicalContentHash(input.toolSchema)
  const cacheKey = canonicalContentHash({
    provider,
    model,
    reasoning,
    toolSchemaDigest,
    memoryRevision,
    phase,
  })
  return Object.freeze({
    cacheKey,
    provider,
    model,
    reasoning,
    toolSchemaDigest,
    memoryRevision,
    phase,
    fragmentJson,
    byteCount: Buffer.byteLength(fragmentJson, 'utf8'),
  })
}

export function dshProviderCacheTelemetry(usage: {
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}): { readonly providerCacheHitRate: number | null; readonly cacheReadTokens: number; readonly cacheWriteTokens: number } {
  const input = usage.inputTokens ?? 0
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  return Object.freeze({
    providerCacheHitRate: input <= 0 ? null : Math.min(1, read / input),
    cacheReadTokens: read,
    cacheWriteTokens: write,
  })
}
