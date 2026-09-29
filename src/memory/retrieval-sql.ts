import { validateMemoryTimeConstraint, type MemoryTimeConstraint } from './retrieval-contracts.js'

export function memoryTimePredicate(
  constraint: MemoryTimeConstraint | undefined,
  entryAlias = 'e',
  revisionAlias = 'r',
): { sql: string; parameters: Array<string | number> } | undefined {
  if (constraint === undefined) return undefined
  constraint = validateMemoryTimeConstraint(constraint)
  if (constraint.basis === 'recorded') {
    return {
      sql: `${revisionAlias}.created_at >= ? AND ${revisionAlias}.created_at < ?`,
      parameters: [new Date(constraint.startMs).toISOString(), new Date(constraint.endMs).toISOString()],
    }
  }
  const evidenceBase = `json_each(CASE WHEN json_valid(episode.value) THEN episode.value ELSE '{}' END, '$.evidence')`
  const manifest = `json_each(CASE WHEN json_valid(d.manifest_json) AND json_type(d.manifest_json) = 'array' THEN d.manifest_json ELSE '[]' END) AS episode`
  const occurrence = `json_extract(evidence.value, '$.occurred.timeMs')`
  return {
    sql: `EXISTS (
      SELECT 1 FROM memory_derivations AS d
       WHERE d.entry_id = ${entryAlias}.id AND d.revision = ${entryAlias}.current_revision
         AND d.state = 'ready' AND json_valid(d.manifest_json) AND json_type(d.manifest_json) = 'array'
         AND EXISTS (SELECT 1 FROM ${manifest} JOIN ${evidenceBase} AS evidence)
         AND NOT EXISTS (
           SELECT 1 FROM ${manifest}
            WHERE NOT EXISTS (SELECT 1 FROM ${evidenceBase} AS evidence)
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${manifest} JOIN ${evidenceBase} AS evidence
            WHERE json_type(evidence.value, '$.occurred') IS NOT 'object'
               OR json_extract(evidence.value, '$.occurred.version') IS NOT 1
               OR json_type(evidence.value, '$.occurred.timeMs') IS NOT 'integer'
               OR ${occurrence} < ? OR ${occurrence} >= ?
         )
    )`,
    parameters: [constraint.startMs, constraint.endMs],
  }
}
