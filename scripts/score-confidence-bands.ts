/** Disjoint bands for accepted score decisions; a boundary belongs to one band. */
export function scoreConfidenceBands(values: readonly { confidence: number; correct: boolean }[]) {
  return Object.fromEntries(([
    ['[0,.5)', 0, .5], ['[.5,.8)', .5, .8], ['[.8,1]', .8, 1],
  ] as const).map(([name, lower, upper]) => {
    const band = values.filter(value => value.confidence >= lower && (upper === 1 ? value.confidence <= upper : value.confidence < upper))
    return [name, { count: band.length, accuracy: band.length ? band.filter(value => value.correct).length / band.length : null }]
  }))
}
