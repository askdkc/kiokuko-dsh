import type { DeepState } from './contracts.js'

export function activeMilliseconds(state: DeepState, now: number): number {
  return state.usage.activeMs + (state.usage.activeSince === null ? 0 : Math.max(0, now - state.usage.activeSince))
}
export function stopClock(state: DeepState, now: number): void {
  state.usage.activeMs = activeMilliseconds(state, now); state.usage.activeSince = null
}
export function budgetProblem(state: DeepState, now: number, kind: 'job' | 'request', tokens = 0): string | undefined {
  const limit = state.configuration.budget
  if (activeMilliseconds(state, now) >= limit.maxActiveSeconds * 1_000) return '実行時間の予算に達しました'
  if (kind === 'job' && state.usage.jobs >= limit.maxAgentJobs) return 'Agentジョブ数の上限に達しました'
  if (state.usage.requests >= limit.maxModelRequests) return 'モデル要求数の上限に達しました'
  const remaining = limit.maxTotalTokens - state.usage.tokens - state.usage.reservedTokens
  if (remaining <= 0 || tokens > remaining) return 'トークン予算に達しました（推定を含む）'
  return undefined
}
/** Explicit heuristic, not a tokenizer or monetary guarantee. */
export function estimateRequestTokens(bytes: number, maximumOutput: number): number { return Math.ceil(bytes / 3) + maximumOutput }
