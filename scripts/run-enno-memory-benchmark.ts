import { performance } from 'node:perf_hooks'
import { fixture, failure } from '../tests/dsh/integration/enno-memory/fixture.js'
import { recordEntryInTransaction } from '../src/memory/entries.js'
import { withImmediateTransaction } from '../src/db/transaction.js'
import { contextRetrievalStateHash } from '../src/context/selection-state.js'
import { GLOBAL_WORKSPACE } from '../src/memory/workspaces.js'
const quantile = (values: number[], q: number) => [...values].sort((a,b)=>a-b)[Math.max(0, Math.ceil(values.length*q)-1)] ?? null
const rows: object[] = []
// Same base task and entries per mode. No user database, history, provider, artificial vectors or downloads.
for (const size of [20, 1000, 9999, 10001]) {
  for (const mode of ['off','observe','active'] as const) {
    const f = await fixture(mode)
    try {
      withImmediateTransaction(f.db, () => {
        for (let i=2; i<size; i++) recordEntryInTransaction(f.db, { workspace: f.prepared.project.workspace,
          title: `unrelated-corpus-${i}`, body: 'Isolated unrelated corpus reference.', kind: 'reference', createdBy: 'benchmark', scope: { visibility: 'project' } })
      })
      // The initial task in the fixture precedes corpus expansion equally in all modes; establish its active baseline.
      const hashStart = performance.now(); let corpusStatus = 'available'
      try { contextRetrievalStateHash(f.db, [f.prepared.project.workspace, GLOBAL_WORKSPACE], { includeEcosystem: true }) }
      catch { corpusStatus = 'unavailable' }
      const corpusProbeMs = performance.now()-hashStart
      const elapsed: number[] = []
      await f.service.refresh(f.binding())
      f.service.observeResult(f.prepared.run.runId, f.agent, f.session, f.root, failure)
      for (let repeat=0; repeat<5; repeat++) {
        const start = performance.now(); await f.service.refresh(f.binding()); elapsed.push(performance.now()-start)
      }
      rows.push({ size, mode, repetitions: elapsed.length, corpusStatus, corpusProbeMs,
        totalMs: { p50: quantile(elapsed,.5), p95: quantile(elapsed,.95), max: Math.max(...elapsed), samples: elapsed },
        injectedCorrect: f.prepared.context?.items.some(i=>i.entryId===f.correct.id) ?? false,
        fullSearches: f.observations.at(-1)?.fullSearchCount ?? 0,
        discarded: f.observations.filter(o=>o.resultDiscarded).length,
        observations: f.observations.map(o=>({decision:o.decision,reason:o.reason,corpusValidationMs:o.corpusValidationMs,
          retrievalMs:o.retrievalMs,rankingMs:o.rankingMs,deliveryMs:o.deliveryMs,totalMs:o.totalMs})),
        llmCalls: 0, remoteEmbeddingCalls: 0, billedTokens: null })
    } finally { await f.close() }
  }
}
console.log(JSON.stringify({ format:'kiokuko.enno-memory.benchmark.v1', node:process.version,
  comparison:'deterministic fixture, lexical retrieval, 8000-character presentation, 5000ms cooperative budget',
  quality:'real-model unmeasured', rerank:'not_adopted', rows }, null, 2))
