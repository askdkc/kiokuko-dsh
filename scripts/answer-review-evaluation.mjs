export const labels = ['satisfied', 'finding', 'not_applicable', 'abstain']
const rate = (n, d) => d ? n / d : null
export function summarize(cases) {
  const completed = cases.filter(row => row.status === 'completed')
  const pairs = completed.flatMap(row => row.observed.map((actual, i) => ({ expected: row.expected[i], actual })))
  const confusion = Object.fromEntries(labels.map(expected => [expected, Object.fromEntries(labels.map(actual => [actual, pairs.filter(p => p.expected === expected && p.actual === actual).length]))]))
  const tp = confusion.finding.finding, fp = labels.filter(x => x !== 'finding').reduce((n, x) => n + confusion[x].finding, 0)
  const attemptedPairs = cases.flatMap(row => (row.expected ?? []).map((expected, i) => ({ expected, actual: row.status === 'completed' ? row.observed[i] : 'failure' })))
  const allPositives = attemptedPairs.filter(p => p.expected === 'finding').length
  const allNegatives = attemptedPairs.length - allPositives
  const positives = pairs.filter(p => p.expected === 'finding').length, negatives = pairs.length - positives
  const times = completed.map(row => row.elapsedMs).sort((a,b) => a-b)
  const attemptedTimes = cases.map(row => row.elapsedMs).sort((a,b) => a-b)
  const statusCountsByReason = {}, abstainReasons = {}
  for (const row of cases.filter(row => row.status !== 'completed')) { const key = `${row.status}:${row.reason ?? 'unknown'}`; statusCountsByReason[key] = (statusCountsByReason[key] ?? 0) + 1 }
  for (const row of completed) for (const answer of row.raw) if (answer.status === 'abstained') abstainReasons[answer.reason] = (abstainReasons[answer.reason] ?? 0) + 1
  return { attempted: cases.length, completed: completed.length, completionRate: rate(completed.length,cases.length), assessedDimensions: pairs.length, attemptedDimensions: attemptedPairs.length, independentGroups: new Set(cases.map(r => r.groupId ?? r.id).filter(Boolean)).size,
    allTrialConfusion: Object.fromEntries(labels.map(expected => [expected, Object.fromEntries([...labels, 'failure'].map(actual => [actual, attemptedPairs.filter(p => p.expected === expected && p.actual === actual).length]))])),
    contradictionAsSupportedRate: rate(confusion.finding.satisfied, allPositives),
    insufficientAsSupportedRate: rate(confusion.abstain.satisfied, attemptedPairs.filter(p => p.expected === 'abstain').length),
    falseFindingRateByExpected: Object.fromEntries(labels.filter(x => x !== 'finding').map(x => [x, rate(confusion[x].finding, attemptedPairs.filter(p => p.expected === x).length)])),
    failureRate: rate(attemptedPairs.filter(p => p.actual === 'failure').length, attemptedPairs.length),
    unknownExpectationFailures: cases.filter(r => r.status !== 'completed' && !r.expected?.length).length, confusion, statusCountsByReason, abstainReasons,
    falseFindingRate: rate(fp, allNegatives), completedFalseFindingRate: rate(fp, negatives), negativeDimensions: negatives, detectionRate: rate(tp, allPositives), completedDetectionRate: rate(tp, positives), positiveDimensions: positives, findingPrecision: rate(tp,tp+fp),
    abstentionRate: rate(pairs.filter(p => p.actual === 'abstain').length,pairs.length), coverageRate: rate(pairs.filter(p => p.actual !== 'abstain').length,pairs.length),
    abstentionRateByExpected: Object.fromEntries(labels.map(x => [x, rate(confusion[x].abstain,pairs.filter(p => p.expected === x).length)])),
    meanCompletedMs: rate(times.reduce((n,t) => n+t,0),times.length), p50Ms: times.length ? times[Math.ceil(times.length*.5)-1] : null, p95Ms: times.length ? times[Math.ceil(times.length*.95)-1] : null,
    meanAttemptedMs: rate(attemptedTimes.reduce((n,t) => n+t,0),attemptedTimes.length), p95AttemptedMs: attemptedTimes.length ? attemptedTimes[Math.ceil(attemptedTimes.length*.95)-1] : null,
    clusterIntervals: clusterIntervals(cases),
    mainRechecks: cases.every(r => Number.isFinite(r.mainRechecks)) ? cases.reduce((n,r) => n+r.mainRechecks,0) : null,
    unnecessaryRechecks: cases.every(r => Number.isFinite(r.unnecessaryRechecks)) ? cases.reduce((n,r) => n+r.unnecessaryRechecks,0) : null,
    totalCost: cases.every(r => Number.isFinite(r.cost)) ? cases.reduce((n,r) => n+r.cost,0) : null,
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

// Resample source groups, never translations or repeated inference as independent cases.
function clusterIntervals(cases) {
  const groups = new Map()
  for (const row of cases) {
    const key = row.groupId ?? row.id
    if (!key || !row.expected?.length) continue
    if (!groups.has(key)) groups.set(key,[])
    groups.get(key).push(row)
  }
  const values = [...groups.values()]
  if (values.length < 2) return null
  let state = 17
  const rates = []
  for (let sample=0;sample<1000;sample++) {
    let positive=0,detected=0,negative=0,falseFinding=0
    for (let i=0;i<values.length;i++) {
      state=(Math.imul(state,1664525)+1013904223)>>>0
      for (const row of values[state%values.length]) row.expected.forEach((expected,index) => {
        const finding = row.status==='completed' && row.observed[index]==='finding'
        if (expected==='finding') {positive++;if(finding)detected++}
        else {negative++;if(finding)falseFinding++}
      })
    }
    rates.push({ detection: rate(detected,positive), falseFinding: rate(falseFinding,negative) })
  }
  const interval = key => {
    const sorted=rates.map(r=>r[key]).filter(x=>x!==null).sort((a,b)=>a-b)
    return sorted.length ? [sorted[Math.floor(sorted.length*.025)],sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.975))]] : null
  }
  return { independentGroups: values.length, method: 'source-group bootstrap', samples: 1000, detection95: interval('detection'), falseFinding95: interval('falseFinding') }
}
