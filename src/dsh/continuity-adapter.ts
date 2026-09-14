import path from 'node:path'
import { canonicalContentHash } from '../serialization/validate.js'
import type { TaskExecutionFrame } from './execution-frame.js'
import type { ExecutionEvidence } from './exploration.js'
import type { EnnoOdunoState, EnnoRunSnapshot } from '../enno-oduno/types.js'
import { buildContinuationView, type ContinuityInput, type ContinuityItem, type ContinuityOwner, type ContinuitySourceRef } from '../context/continuity-view.js'

export interface ContinuitySources {
  readonly owner: ContinuityOwner
  readonly generation: string
  /** Original spelling resolved by the host to owner.workspace (e.g. macOS /var -> /private/var). */
  readonly workspaceAlias?: string
  readonly frame?: TaskExecutionFrame | undefined
  readonly evidence: readonly ExecutionEvidence[]
  readonly enno?: { readonly snapshot: EnnoRunSnapshot; readonly state: EnnoOdunoState } | undefined
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
  const enno = input.enno
  if (input.owner.mode === 'enno') {
    if (!enno) coverage = 'unavailable'
    else {
      const { snapshot, state } = enno
      if (snapshot.runId !== input.owner.runId || snapshot.repositoryRoot !== input.owner.workspace
        || snapshot.dshSessionId !== input.owner.sessionId || state.dshSessionId !== input.owner.sessionId
        || snapshot.revision !== state.contractRevision || (snapshot.routeEpoch ?? 0) !== state.routeEpoch
        || (state.directive?.workUnit?.id ?? null) !== input.owner.workUnitId || state.currentRole !== input.owner.role) {
        throw new Error('Continuity Enno binding mismatch')
      }
      sources.push({ kind: 'enno-contract', key: `${snapshot.runId}:${snapshot.orchestrationId}`,
        revision: canonicalContentHash({ revision: snapshot.revision, mutation: snapshot.mutationRevision,
          route: snapshot.routeEpoch ?? 0, directive: state.directive, nextAction: state.nextAction }) })
      const current = snapshot.workUnits.find(unit => unit.workUnit.id === input.owner.workUnitId)
      const relevant = new Set([input.owner.workUnitId, ...(current?.workUnit.dependencies ?? [])])
      // The directive already owns current criteria and nextAction. Only add related reports.
      for (const unit of snapshot.workUnits.filter(unit => relevant.has(unit.workUnit.id))) {
        if (!unit.result) continue
        const ref: ContinuitySourceRef = { kind: 'enno-work-result', key: `${snapshot.runId}:${unit.workUnit.id}`,
          revision: canonicalContentHash(unit) }
        sources.push(ref)
        items.unshift({ key: ref.key, kind: 'reported-result', text: `${unit.workUnit.id}: ${unit.result.outcome}; ${unit.result.summary}`,
          basis: 'model-report', validity: 'unknown', sources: [ref] })
      }
      // Snapshot final evidence is revision-scoped; live repository freshness is not checked here.
      for (const result of snapshot.finalEvidence.slice(0, 24)) {
        const ref: ContinuitySourceRef = { kind: 'enno-verifier', key: `${snapshot.runId}:${result.verifier.id}`, revision: canonicalContentHash(result) }
        sources.push(ref)
        items.push({ key: ref.key, kind: 'observation', basis: 'host-observation', validity: 'unknown', sources: [ref],
          text: `Recorded verifier ${result.verifier.id}: ${result.status}; exit code ${result.exitCode ?? 'unknown'}. Current repository freshness is not established by this projection.` })
      }
      if (snapshot.finalEvidence.length > 24) coverage = 'partial'
    }
  }
  return buildContinuationView({ owner: input.owner, stamp: canonicalContentHash({ generation: input.generation, frame: input.frame ?? null }),
    sources, items, coverage, omittedItems: Math.max(0, input.evidence.length - 32) + Math.max(0, (enno?.snapshot.finalEvidence.length ?? 0) - 24) })
}
