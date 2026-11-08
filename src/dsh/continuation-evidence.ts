import type { SqliteDatabase } from '../db/adapter.js'
import { applicationSourceDigest } from '../memory/application.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'
import type { CompletionAssessment } from './task-completion.js'

export function continuationProgress(
  database: SqliteDatabase,
  runId: string,
  repositoryRoot: string,
  assessment: CompletionAssessment,
): string {
  const observed = database.prepare(`
    SELECT outcome, exit_code, tap_summary_json
    FROM dsh_completion_executions WHERE run_id = ? AND call_id = ?
  `)
  const bindings = database.prepare(`
    SELECT json_extract(method_json, '$.sourcePaths') AS paths
    FROM dsh_completion_bindings WHERE run_id = ? AND criterion_id = ? AND approved = 1
  `)
  const criteria = assessment.criteria.map(({ criterionId, state, reason, evidenceRef }) => {
    let source: string | undefined
    try {
      const bound = bindings.get<{ paths: string }>(runId, criterionId)
      if (bound) source = applicationSourceDigest(repositoryRoot, JSON.parse(bound.paths) as string[])
    } catch { /* A missing or unreadable source cannot supply progress. */ }
    return canonicalContentHash({
      state, reason, source: source ?? null,
      execution: evidenceRef && state !== 'stale'
        ? observed.get(runId, evidenceRef) ?? null
        : null,
    })
  }).sort()
  // A repeated write to the same path and bytes is the same observation.
  // Only the latest observed content per bound target contributes.
  const targets = database.prepare(`
    WITH observations AS (
      SELECT target.value ->> '$.path' AS path, target.value ->> '$.after' AS digest,
             row_number() OVER (
               PARTITION BY target.value ->> '$.path' ORDER BY o.rowid DESC
             ) AS rank
      FROM dsh_owned_operations o, json_each(o.receipt_json, '$.targets') target
      WHERE o.run_id = ? AND o.state = 'completed'
        AND target.value ->> '$.path' IS NOT NULL
        AND (target.value ->> '$.before') IS NOT (target.value ->> '$.after')
    )
    SELECT path, digest FROM observations WHERE rank = 1 ORDER BY path
  `).all(runId)
  return canonicalContentHash({
    criteria, targets,
    managedOperationsReady: assessment.managedOperationsReady ?? true,
    nativeChildrenPending: assessment.nativeChildrenPending ?? false,
  })
}

export function continuationMessage(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'instructions' },
  }
}
