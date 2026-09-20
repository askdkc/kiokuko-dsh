import { z } from 'zod'

export const MemoryReuseConfig = z.object({
  mode: z.enum(['auto', 'off']).default('auto'),
  maxCandidates: z.number().int().min(1).max(100).default(24),
  budgetMs: z.number().int().min(1).max(600000).default(5000),
}).strict()
export type MemoryReuseConfiguration = z.infer<typeof MemoryReuseConfig>
export interface MemoryReuseCandidate {
  entryId: string
  revision: number
  projectionHash: string
  text: string
}
export type MemoryReuseVerdict = 'applicable' | 'not_applicable' | 'uncertain'
export type MemoryReuseSelection = { status: 'completed'; verdicts: readonly MemoryReuseVerdict[] } | { status: 'fallback'; reason: string }
/** Host-provided effect. The retrieval layer owns eligibility, projection and state revalidation. */
export interface MemoryReuseRuntime {
  readonly identity: string
  readonly maxCandidates: number
  select(input: { task: string; constraints: string; binding: string; candidates: readonly MemoryReuseCandidate[] }): Promise<MemoryReuseSelection>
}

/** Keep existing order within groups and leave unassessed candidates untouched. */
export function applyMemoryReuse<T>(items: readonly T[], verdicts: readonly MemoryReuseVerdict[]): { items: T[]; excluded: T[] } {
  return { items: [...items.filter((_, i) => verdicts[i] === 'applicable'), ...items.filter((_, i) => verdicts[i] !== 'applicable' && verdicts[i] !== 'not_applicable')],
    excluded: items.filter((_, i) => verdicts[i] === 'not_applicable') }
}
