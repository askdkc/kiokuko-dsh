import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { projectMemoryEntry, renderMemoryFields } from '../context/memory-projection.js'
import { contextRetrievalStateHash } from '../context/selection-state.js'
import { captureProjectManifestSnapshot, resolveProjectFingerprint } from '../repository/project-fingerprint.js'
import { readEntry } from './entries.js'
import { rankedEntryHits, recallEntryHits } from './retrieval.js'
import { applyMemoryReuse, type MemoryReuseRuntime } from './reuse.js'
import type { ResolvedProjectWorkspace } from './workspaces.js'
import type { HybridSearchRuntime } from './hybrid-retrieval.js'
import { applicabilityCompatibility, type FederatedRecallResult } from './federated-retrieval.js'

export interface ProjectMemoryReuseEffect {
  runtime: MemoryReuseRuntime
  constraints: string
  /** The native core checks admission/ownership both before disclosure and after waiting. */
  assertCurrent: () => void
}

export async function reuseProjectMemory(database: SqliteDatabase, input: {
  query: string; project: ResolvedProjectWorkspace; limit: number; maxChars: number;
}, baseline: FederatedRecallResult, runtime: HybridSearchRuntime, effect: ProjectMemoryReuseEffect): Promise<FederatedRecallResult> {
  const { project } = input, before = contextRetrievalStateHash(database, [project.workspace])
  const manifest = captureProjectManifestSnapshot(project)
  const fingerprint = resolveProjectFingerprint(database, project, manifest, { readOnly: true })
  const ranked = rankedEntryHits(database, { workspace: project.workspace, query: input.query, limit: 100 }, runtime)
  const candidates = ranked.hits.flatMap(hit => {
    const entry = readEntry(database, { workspace: project.workspace, entryId: hit.entryId })
    const projection = projectMemoryEntry(database, entry)
    return projection === null ? [] : [{ hit, entry, projection }]
  })
  const selected = candidates.filter(c => !applicabilityCompatibility(c.entry, fingerprint).incompatible).slice(0, effect.runtime.maxCandidates)
  effect.assertCurrent()
  if (!selected.length) return baseline
  const result = await effect.runtime.select({ task: input.query, constraints: effect.constraints,
    binding: canonicalContentHash({ project, manifest, before }), candidates: selected.map(c => ({ entryId: c.entry.id, revision: c.entry.revision,
      projectionHash: canonicalContentHash(c.projection.projection), text: renderMemoryFields(c.projection)! })) })
  effect.assertCurrent()
  if (before !== contextRetrievalStateHash(database, [project.workspace]) || canonicalContentHash(manifest) !== canonicalContentHash(captureProjectManifestSnapshot(project))) throw new KiokukoError('CONFLICT', 'Memory or project changed during semantic selection')
  if (result.status === 'fallback') return baseline
  if (result.verdicts.length !== selected.length || result.verdicts.some(v => !['applicable', 'not_applicable', 'uncertain'].includes(v))) throw new KiokukoError('INTEGRITY_ERROR', 'Invalid memory reuse decisions')
  if (result.verdicts.every(v => v === 'uncertain')) return baseline
  const verdicts = new Map(selected.map((c, index) => [c.entry.id, result.verdicts[index]!]))
  const applied = applyMemoryReuse(candidates, candidates.map(c => verdicts.get(c.entry.id) ?? 'uncertain'))
  const memory = recallEntryHits(database, { workspace: project.workspace, query: input.query, limit: input.limit, maxChars: input.maxChars },
    { hits: applied.items.map(c => c.hit), truncated: ranked.truncated || applied.items.length > input.limit })
  const hitById = new Map(applied.items.map(c => [c.entry.id, c.hit]))
  return { ...baseline, project: { target: project, memory }, combined: { ...memory,
    items: memory.items.map(item => ({ ...item, origin: 'project' as const, selectionReasons: ['project_origin', ...hitById.get(item.id)!.reasons] })) } }
}
