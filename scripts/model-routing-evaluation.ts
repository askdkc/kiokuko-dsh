import { ModelAutoRouteId } from '../src/dsh/model-auto/contracts.js'

export const ROUTE_LABELS = [...ModelAutoRouteId.options, 'retain'] as const
export type RouteLabel = typeof ROUTE_LABELS[number]
export type RoutingEvaluationRow = {
  readonly id: string
  readonly language: 'ja' | 'en'
  readonly consequence: 'routine' | 'high' | 'unknown'
  readonly expected: RouteLabel
  readonly status: 'completed' | 'failed'
  readonly actual?: RouteLabel
  readonly decision?: 'selected' | 'abstained'
  readonly reason?: string
  readonly confidence?: number
  readonly elapsedMs: number
  readonly inputTokens?: number | null
  readonly outputTokens?: number | null
}

/** Model-routing calls do not perform the answer-review preflight operation. */
export function routingInputCompleteness(provider: 'jev' | 'laya', protocol: 'v1' | 'strict', completed: boolean) {
  if (!completed) return 'unknown'
  return provider === 'jev' ? 'host_complete' : protocol === 'v1' ? 'unverified_v1' : 'strict_predict_contract'
}

const rate = (part: number, whole: number): number | null => whole ? part / whole : null
const percentile = (sorted: number[], p: number): number | null => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null
const routeIndex = (label: RouteLabel): number => ModelAutoRouteId.options.indexOf(label as ModelAutoRouteId)

/** Failed transport and abstention are separate from a selected, lower-capability route. */
export function summarizeModelRouting(rows: readonly RoutingEvaluationRow[], provider: 'jev' | 'laya') {
  const completed = rows.filter(row => row.status === 'completed' && row.actual !== undefined)
  const selected = completed.filter(row => row.decision === 'selected')
  const underRouted = selected.filter(row => row.expected !== 'retain' && row.actual !== 'retain'
    && routeIndex(row.actual!) < routeIndex(row.expected))
  const highConsequence = completed.filter(row => row.consequence === 'high')
  const times = completed.map(row => row.elapsedMs).sort((a, b) => a - b)
  const confusion = Object.fromEntries(ROUTE_LABELS.map(expected => [expected,
    Object.fromEntries(ROUTE_LABELS.map(actual => [actual,
      completed.filter(row => row.expected === expected && row.actual === actual).length]))]))
  const failures: Record<string, number> = {}
  for (const row of rows.filter(row => row.status === 'failed')) failures[row.reason ?? 'unknown'] = (failures[row.reason ?? 'unknown'] ?? 0) + 1
  const measuredInput = completed.filter(row => row.inputTokens !== undefined && row.inputTokens !== null)
  const measuredOutput = completed.filter(row => row.outputTokens !== undefined && row.outputTokens !== null)
  return {
    attempted: rows.length, completed: completed.length, failed: rows.length - completed.length,
    completionRate: rate(completed.length, rows.length), selected: selected.length,
    abstained: completed.filter(row => row.decision === 'abstained').length,
    confusion, agreementRate: rate(completed.filter(row => row.expected === row.actual).length, completed.length),
    underRouted: underRouted.length,
    highConsequenceUnderRouted: underRouted.filter(row => row.consequence === 'high').length,
    highConsequenceAbstentionRate: rate(highConsequence.filter(row => row.decision === 'abstained').length, highConsequence.length),
    highConfidenceUnderRouted: provider === 'jev' ? underRouted.filter(row => (row.confidence ?? 0) >= .8).length : null,
    failures, p50Ms: percentile(times, .5), p95Ms: percentile(times, .95),
    inputTokens: measuredInput.length ? measuredInput.reduce((sum, row) => sum + row.inputTokens!, 0) : null,
    outputTokens: measuredOutput.length ? measuredOutput.reduce((sum, row) => sum + row.outputTokens!, 0) : null,
    cost: null,
  }
}
