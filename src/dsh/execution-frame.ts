import path from 'node:path'
import { realpathSync } from 'node:fs'
import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash, normalizeTextLineEndings } from '../serialization/validate.js'

export type ExecutionField = 'readPaths' | 'writePaths' | 'excludedPaths' | 'constraints' | 'completion'
export interface ExecutionCondition {
  field: ExecutionField
  text: string
  source: { kind: 'user' | 'proposal'; quote: string; requestDigest: string }
  approval: 'explicit' | 'proposed' | 'approved'
  planRevision?: number
}
export interface TaskExecutionFrame {
  version: 1
  revision: number
  workspace: string
  objective: string
  requestDigests: string[]
  conditions: ExecutionCondition[]
}
const labels: Readonly<Record<string, ExecutionField>> = {
  '探索対象': 'readPaths', '読み取り対象': 'readPaths', 'read paths': 'readPaths',
  '変更可能': 'writePaths', '変更対象': 'writePaths', 'write paths': 'writePaths',
  '変更禁止': 'excludedPaths', 'excluded paths': 'excludedPaths',
  '制約': 'constraints', 'constraints': 'constraints', '完了条件': 'completion', 'done when': 'completion',
}
const fields = new Set<ExecutionField>(['readPaths', 'writePaths', 'excludedPaths', 'constraints', 'completion'])
const pathFields = new Set<ExecutionField>(['readPaths', 'writePaths', 'excludedPaths'])
const unsafeText = /[\p{Cc}\p{Cf}]/u

/** Only literal paths are machine policy; prose and glob expressions stay advice. */
export function literalExecutionPath(value: string): string | undefined {
  const text = value.trim().replace(/^`([^`]+)`$/u, '$1')
  if (!text || text.length > 4096 || unsafeText.test(text) || /[*?\[\]{}<>|]/u.test(text)
    || /(?:のみ|以外|禁止|しない|を|の下)/u.test(text)) return undefined
  return text
}

/** References and fenced/quoted examples cannot supply new authority. */
export function extractExecutionConditions(task: string): ExecutionCondition[] {
  const digest = canonicalContentHash(task)
  const result: ExecutionCondition[] = []
  let fence: string | undefined
  let section: ExecutionField | undefined
  for (const line of normalizeTextLineEndings(task).split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; section = undefined; continue }
    if (fence || /^\s*>/u.test(line) || /^(?: {4}|\t)/u.test(line)) { section = undefined; continue }
    const heading = /^(?:#{1,6}\s+)?([^:：]+)[:：]\s*(.*)$/u.exec(line)
    const field = heading ? labels[heading[1]!.trim().toLowerCase()] : undefined
    let value: string | undefined
    if (field) { section = field; value = heading![2]!.trim() }
    else if (/^#{1,6}\s/u.test(line)) { section = labels[line.replace(/^#+\s*/u, '').trim().toLowerCase()]; continue }
    else if (section && /^[-*]\s+/u.test(line)) value = line.replace(/^[-*]\s+/u, '').trim()
    else { if (line.trim()) section = undefined; continue }
    if (!section || !value || value.length > 8192) continue
    const values = pathFields.has(section) ? value.split(/[,、]/u) : [value]
    for (const item of values) {
      const text = pathFields.has(section) ? literalExecutionPath(item) : item.trim()
      if (!text || unsafeText.test(text)) continue
      result.push({ field: section, text, source: { kind: 'user', quote: line, requestDigest: digest }, approval: 'explicit' })
    }
  }
  return result
}

export function updateExecutionFrame(previous: TaskExecutionFrame | undefined, workspace: string, task: string): TaskExecutionFrame {
  const requestDigest = canonicalContentHash(task)
  if (previous?.requestDigests.at(-1) === requestDigest) return previous
  const added = extractExecutionConditions(task)
  // Explicitly restating a field replaces that field; an ordinary "continue" does not.
  const replaced = new Set(added.map(item => item.field))
  const conditions = [...(previous?.conditions ?? []).filter(item => !replaced.has(item.field)), ...added]
  return { version: 1, workspace, objective: previous?.objective ?? task,
    revision: (previous?.revision ?? 0) + (added.length || !previous ? 1 : 0),
    requestDigests: [...(previous?.requestDigests ?? []), requestDigest].slice(-256), conditions }
}

/** Optional model metadata never rejects the enclosing business operation. */
export function executionProposals(value: unknown, task: string, planRevision: number): ExecutionCondition[] {
  if (!Array.isArray(value)) return []
  const conditions: ExecutionCondition[] = []
  for (const candidate of value.slice(0, 64)) {
    if (!candidate || typeof candidate !== 'object') continue
    const { field, text, quote } = candidate as Record<string, unknown>
    if (!fields.has(field as ExecutionField) || typeof text !== 'string' || typeof quote !== 'string'
      || !text.trim() || text.length > 8192 || !quote.trim() || quote.length > 8192 || !task.includes(quote)
      || unsafeText.test(text.replace(/[\n\r\t]/gu, ''))) continue
    const normalized = pathFields.has(field as ExecutionField) ? literalExecutionPath(text) : text.trim()
    if (!normalized) continue
    conditions.push({ field: field as ExecutionField, text: normalized,
      source: { kind: 'proposal', quote, requestDigest: canonicalContentHash(task) }, approval: 'proposed', planRevision })
  }
  return conditions
}

export function readExecutionFrame(database: SqliteDatabase, runId: string): TaskExecutionFrame | undefined {
  const row = database.prepare('SELECT frame_json AS json FROM dsh_execution_frames WHERE run_id = ?').get<{ json: string }>(runId)
  if (!row) return undefined
  const frame = JSON.parse(row.json) as TaskExecutionFrame
  if (frame.version !== 1 || !Array.isArray(frame.conditions) || !Array.isArray(frame.requestDigests)
    || typeof frame.workspace !== 'string' || typeof frame.objective !== 'string'
    || !Number.isSafeInteger(frame.revision) || frame.revision < 1
    || frame.conditions.some(item => !item || !fields.has(item.field) || typeof item.text !== 'string'
      || !['explicit', 'proposed', 'approved'].includes(item.approval) || !item.source
      || typeof item.source.quote !== 'string' || typeof item.source.requestDigest !== 'string'
      || (pathFields.has(item.field) && !literalExecutionPath(item.text)))) throw new Error('Invalid execution frame')
  return frame
}
export function saveExecutionFrame(database: SqliteDatabase, runId: string, frame: TaskExecutionFrame): void {
  database.prepare(`INSERT INTO dsh_execution_frames VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET frame_json = excluded.frame_json, updated_at = excluded.updated_at`)
    .run(runId, JSON.stringify(frame), new Date().toISOString())
}

export function executionFrameText(frame: TaskExecutionFrame): string {
  const rows: string[] = []
  let remaining = 6_000
  for (const item of frame.conditions) {
    const row = `${item.field} [${item.approval}]: ${item.text}`
    if (row.length > remaining) { rows.push('Further conditions are retained in the task record and original request; this projection is partial. All recognized explicit path guards still apply.'); break }
    rows.push(row); remaining -= row.length
  }
  return ['Current task conditions (user conditions and approved proposals only grant authority).',
    `Objective: ${frame.objective.slice(0, 2000)}`, ...rows,
    'Shell and unrecognized tools are not covered by path enforcement. Evidence presentation is not proof of correctness.',
    'Optional executionHints: [{field: readPaths|writePaths|excludedPaths|constraints|completion, text, quote}] may accompany ideal/plan submission. Quote the actual user request. Invalid hints are ignored; do not retry a phase merely to supply hints.',
    'Before completion, report the outcome, verification evidence and unresolved requirements. Do not collect more evidence after a terminal result.'].join('\n')
}

/** Resolve existing ancestors too, so creation through a symlink cannot escape. */
export function canonicalExecutionPath(value: string, cwd: string): string {
  let current = path.resolve(cwd, value)
  const suffix: string[] = []
  for (;;) {
    try { return path.join(realpathSync(current), ...suffix.reverse()) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.push(path.basename(current)); current = parent
    }
  }
}
function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
export function executionPathDenial(frame: TaskExecutionFrame, operation: 'read' | 'write', paths: readonly string[]): string | undefined {
  const active = frame.conditions.filter(item => item.approval !== 'proposed')
  const allowed = active.filter(item => item.field === (operation === 'read' ? 'readPaths' : 'writePaths'))
  const excluded = operation === 'write' ? active.filter(item => item.field === 'excludedPaths') : []
  if (!allowed.length && !excluded.length) return undefined
  try {
    // Approved interpretations may narrow, but cannot silently widen explicit user bounds.
    const groups = ['explicit', 'approved'].map(approval => allowed.filter(item => item.approval === approval)
      .map(item => canonicalExecutionPath(item.text, frame.workspace)))
    const denied = excluded.map(item => canonicalExecutionPath(item.text, frame.workspace))
    for (const value of paths) {
      const candidate = canonicalExecutionPath(value, frame.workspace)
      if (groups.some(roots => roots.length && !roots.some(root => within(candidate, root))) || denied.some(root => within(candidate, root))) {
        return `Kiokuko: this ${operation} is outside the explicit or approved task paths. Explain the needed scope change; other conversation and reporting remain available.`
      }
    }
  } catch { return 'Kiokuko: the path policy for this operation cannot be resolved. Clarify the target or repair the path; conversation remains available.' }
  return undefined
}
