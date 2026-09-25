/** TypeSafe Score is the probability-weighted rubric index, subject to wire rounding. */
export function consistentScore(score: number, probabilities: readonly number[]): boolean {
  const expected = probabilities.reduce((sum, probability, index) => sum + index * probability, 0)
  return Number.isFinite(score) && Math.abs(score - expected) <= 0.001 * probabilities.length
}
