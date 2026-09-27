export interface ChoiceDiagnostic {
  questionId: string
  choice: string
  probabilities: { id: string; probability: number }[]
  topProbability: number
  runnerUpProbability: number
  margin: number
  confidence: number
  gate: 'confidence' | 'probability_margin'
  acceptance: { minConfidence?: number; minProbability?: number; minMargin?: number }
  status: 'selected' | 'abstained'
  reason?: 'insufficient' | 'tie' | 'uncertain'
  failedChecks: ('confidence' | 'probability' | 'margin')[]
}

export type ChoiceDiagnosticObserver = (diagnostic: ChoiceDiagnostic) => void

/** Diagnostic hooks are advisory; they cannot turn a valid decision into a fallback. */
export function emitChoiceDiagnostic(observer: ChoiceDiagnosticObserver | undefined, diagnostic: ChoiceDiagnostic): void {
  try { observer?.(diagnostic) } catch { /* An observer must not change a decision. */ }
}
