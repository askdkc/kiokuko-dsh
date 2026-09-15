export type MemoryRefreshReason = 'unchanged' | 'focus_changed' | 'corpus_changed' | 'cold_resume' | 'config_changed'
  | 'budget_exhausted' | 'memory_unavailable' | 'stale_generation' | 'time_budget' | 'inactive'
export type MemoryRefreshDecision = { decision: 'reuse' | 'full' | 'skip'; reason: MemoryRefreshReason }

/** A role/revision change alone cannot justify another candidate search. */
export function decideMemoryRefresh(input: { active: boolean; previousFocus: string | null; focus: string;
  corpusChanged: boolean; configChanged: boolean; cold: boolean; fullCount: number; maxFull: number }): MemoryRefreshDecision {
  if (!input.active) return { decision: 'skip', reason: 'inactive' }
  const reason = input.cold ? 'cold_resume' : input.configChanged ? 'config_changed' : input.corpusChanged ? 'corpus_changed'
    : input.previousFocus !== input.focus ? 'focus_changed' : 'unchanged'
  if (reason === 'unchanged') return { decision: 'reuse', reason }
  return input.fullCount >= input.maxFull ? { decision: 'skip', reason: 'budget_exhausted' } : { decision: 'full', reason }
}
