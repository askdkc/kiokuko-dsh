import path from 'node:path'
import { canonicalContentHash } from '../serialization/validate.js'
import type { TaskExecutionFrame } from './execution-frame.js'
import type { ExecutionEvidence } from './exploration.js'
import { buildContinuationView, type ContinuityInput, type ContinuityItem, type ContinuityOwner, type ContinuitySourceRef } from '../context/continuity-view.js'

export interface ContinuitySources {
  readonly owner: ContinuityOwner
  readonly generation: string
  /** Original spelling resolved by the host to owner.workspace (e.g. macOS /var -> /private/var). */
  readonly workspaceAlias?: string
  readonly frame?: TaskExecutionFrame | undefined
  readonly evidence: readonly ExecutionEvidence[]
}

/** Adapt already committed, host-bound sources. No reads, inference, authority changes or freshness I/O. */
export function adaptContinuity(input: ContinuitySources) {
  const sources: ContinuitySourceRef[] = []
  const items: ContinuityItem[] = []
  let coverage: ContinuityInput['coverage'] = input.frame ? 'complete' : 'unavailable'
  if (input.frame && input.frame.workspace !== input.owner.workspace && input.frame.workspace !== input.workspaceAlias) throw new Error('Continuity frame owner mismatch')
  if (input.frame) sources.push({ kind: 'execution-frame', key: input.owner.runId,
    revision: canonicalContentHash(input.frame) })
  const targets = new Set(input.frame?.conditions.filter(c => c.field === 'readPaths' && c.approval !== 'proposed')
    .map(c => path.resolve(input.owner.workspace, c.text)))
  // Incompletely acquired/presented observations, exact explicit targets, then recency.
  const evidence = input.evidence.slice(-32).map((item, index) => ({ item, index,
    priority: item.acquisition !== 'full' || item.presentation !== 'full' ? 0 : item.operation.paths.some(p => targets.has(p)) ? 1 : 2 }))
    .sort((a, b) => a.priority - b.priority || b.index - a.index)
  if (input.evidence.length >= 32) coverage = 'partial'
  for (const { item } of evidence) {
    const { presentation: _presentation, ...acquired } = item
    const ref: ContinuitySourceRef = { kind: 'execution-evidence', key: `${input.owner.runId}:${item.id}`,
      revision: canonicalContentHash(acquired) }
    sources.push(ref)
    items.push({ key: ref.key, kind: 'observation', basis: 'host-observation', validity: 'historical', sources: [ref],
      text: `Paths: ${item.operation.paths.join(', ')}; requested range: ${JSON.stringify(item.operation.range)}; acquired range: ${JSON.stringify(item.acquiredRange ?? null)}; acquisition: ${item.acquisition ?? 'unknown'}; tool success: ${item.toolSucceeded ?? 'unknown'}; source event: ${item.sourceSeq ?? 'unknown'}; result digest: ${item.digest}` })
  }
  return buildContinuationView({ owner: input.owner, stamp: canonicalContentHash({ generation: input.generation, frame: input.frame ?? null }),
    sources, items, coverage, omittedItems: Math.max(0, input.evidence.length - 32) })
}
