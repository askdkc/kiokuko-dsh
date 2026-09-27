export const labels = ['satisfied', 'finding', 'not_applicable', 'abstain']
const rate = (n, d) => d ? n / d : null
export function summarize(cases) {
  const completed = cases.filter(row => row.status === 'completed')
  const pairs = completed.flatMap(row => row.observed.map((actual, i) => ({ expected: row.expected[i], actual })))
  const confusion = Object.fromEntries(labels.map(expected => [expected, Object.fromEntries(labels.map(actual => [actual, pairs.filter(p => p.expected === expected && p.actual === actual).length]))]))
  const tp = confusion.finding.finding, fp = labels.filter(x => x !== 'finding').reduce((n, x) => n + confusion[x].finding, 0)
  const positives = pairs.filter(p => p.expected === 'finding').length, negatives = pairs.length - positives
  const times = completed.map(row => row.elapsedMs).sort((a,b) => a-b)
  const statusCountsByReason = {}, abstainReasons = {}
  for (const row of cases.filter(row => row.status !== 'completed')) { const key = `${row.status}:${row.reason ?? 'unknown'}`; statusCountsByReason[key] = (statusCountsByReason[key] ?? 0) + 1 }
  for (const row of completed) for (const answer of row.raw) if (answer.status === 'abstained') abstainReasons[answer.reason] = (abstainReasons[answer.reason] ?? 0) + 1
  return { attempted: cases.length, completed: completed.length, completionRate: rate(completed.length,cases.length), assessedDimensions: pairs.length, confusion, statusCountsByReason, abstainReasons,
    falseFindingRate: rate(fp, negatives), negativeDimensions: negatives, detectionRate: rate(tp, positives), positiveDimensions: positives, findingPrecision: rate(tp,tp+fp),
    abstentionRate: rate(pairs.filter(p => p.actual === 'abstain').length,pairs.length), coverageRate: rate(pairs.filter(p => p.actual !== 'abstain').length,pairs.length),
    abstentionRateByExpected: Object.fromEntries(labels.map(x => [x, rate(confusion[x].abstain,pairs.filter(p => p.expected === x).length)])),
    meanCompletedMs: rate(times.reduce((n,t) => n+t,0),times.length), p50Ms: times.length ? times[Math.ceil(times.length*.5)-1] : null, p95Ms: times.length ? times[Math.ceil(times.length*.95)-1] : null,
    totalElapsedMs: cases.reduce((n,row) => n+row.elapsedMs,0) }
}
export function schedule(examples,repetitions,seed) {
  let state = seed >>> 0; const rows = []
  for (let attempt=0; attempt<repetitions; attempt++) {
    const group = ['ja','en'].flatMap(language => examples.map(example => ({language,example,attempt})))
    for (let i=group.length-1;i>0;i--) { state = (Math.imul(state,1664525)+1013904223)>>>0; const j=state%(i+1); [group[i],group[j]]=[group[j],group[i]] }
    rows.push(...group)
  }
  return rows
}
