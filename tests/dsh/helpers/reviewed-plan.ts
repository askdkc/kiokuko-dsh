import { reviewEnnoPlan, submitEnnoPlan, type EnnoServiceDependencies } from '../../../src/enno-oduno/service.js'
import { advisorySlotDefinitions } from '../../../src/enno-oduno/advisory.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'

/** Existing execution fixtures now enter through a completed synthetic draft review. */
export async function submitReviewedPlan(database: SqliteDatabase, input: any, dependencies: EnnoServiceDependencies = {}) {
  const review = await reviewEnnoPlan(database, input, async () => ({ backend: { provider: 'fixture', requestedModel: 'fixture-check' },
    contributions: advisorySlotDefinitions('planning').map(slot => ({ slotId: slot.slotId, outcome: 'completed' as const, summary: 'Synthetic complete plan review', recommendations: [], risks: [], evidence: [] })) }), new AbortController().signal)
  return submitEnnoPlan(database, { ...input, advisoryRoundDigest: review.advisoryRound!.inputDigest,
    advisoryDisposition: review.advisoryRound!.contributions.map(c => ({ slotId: c.slotId, disposition: 'adopted', rationale: 'Checked fixture review' })) }, dependencies)
}
