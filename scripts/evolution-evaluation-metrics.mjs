/** Candidate search is deliberately unbounded; evaluation, unlike search, must apply K. */
export function retrievalMetrics(candidates, relevantIds, k = 5) {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('K must be positive')
  const ids = [...new Set(candidates.map(candidate => candidate.entryId))]
  const topK = ids.slice(0, k)
  const relevantRetrieved = topK.filter(id => relevantIds.has(id)).length
  const index = ids.findIndex(id => relevantIds.has(id))
  const rank = index < 0 ? null : index + 1
  return {
    hitAtK: Number(relevantRetrieved > 0),
    recallAtK: relevantIds.size === 0 ? null : relevantRetrieved / relevantIds.size,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    reciprocalRankAtK: rank === null || rank > k ? 0 : 1 / rank,
    exactRank: rank,
    relevantCount: relevantIds.size,
    relevantRetrieved,
    candidateCount: ids.length,
    topK,
  }
}

/** Counts executed statements and returned entry rows, not prepare calls or query-plan estimates. */
export function measureDatabase(database) {
  const counters = { sqlCalls: 0, entryRowsRead: 0 }
  const instrumented = {
    filePath: database.filePath,
    close: () => database.close(),
    exec(sql) { counters.sqlCalls++; database.exec(sql) },
    prepare(sql) {
      const statement = database.prepare(sql)
      const entryRead = /\b(?:FROM|JOIN)\s+(?:entries|entry_revisions)\b/iu.test(sql)
      return Object.fromEntries(['run', 'get', 'all'].map(method => [method, (...args) => {
        counters.sqlCalls++
        const result = statement[method](...args)
        if (entryRead && method !== 'run') counters.entryRowsRead += method === 'all' ? result.length : Number(result !== undefined)
        return result
      }]))
    },
  }
  return { database: instrumented, counters }
}
