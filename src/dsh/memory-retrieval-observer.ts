import type { MemoryRetrievalObservation } from '../memory/hybrid-retrieval.js'

/** Emit count-only shadow diagnostics. Query text and memory identifiers are never logged. */
export function reportMemoryRetrievalObservation(value: MemoryRetrievalObservation): void {
  console.info(`[kiokuko-dsh] [info] memory retrieval observe ${JSON.stringify({
    basis: value.timeBasis,
    baselineCandidates: value.baselineCandidates,
    restrictedCandidates: value.restrictedCandidates,
    relatedCandidates: value.relatedCandidates,
    addedByRelated: value.addedByRelated,
  })}`)
}
