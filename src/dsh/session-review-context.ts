import { realpath } from 'node:fs/promises'
import type { SqliteDatabase } from '../db/adapter.js'
import type { DshCoreRuntime } from './core-runtime.js'
import { resolveProjectWorkspaceReadOnly, GLOBAL_WORKSPACE } from '../memory/workspaces.js'
import { listContextDeliveries, readContextDelivery } from '../context/delivery.js'
import { readEntry } from '../memory/entries.js'
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js'
import { redactDshSourceText } from '../context/memory-projection.js'
import { DiffReviewError, type ReviewContext } from '../diff-review/schema.js'
import { readAkinatorSession } from '../akinator/store.js'
import { readEnnoSnapshot } from '../enno-oduno/store.js'

export interface ReviewSessionSource {
  get(sessionId: string): { id: string; header?: { cwd?: string } } | undefined
}
export interface ReviewPersistenceSource {
  stat(sessionId: string): Promise<{ header: { id: string; cwd?: string } } | undefined>
}

export interface ReviewSessionBinding { sessionId: string; cwd: string; repositoryRoot: string; repositoryId: string; workspace: string }

/** Resolve only the selected native session; never discover a root from an old Kiokuko run. */
export async function resolveReviewSession(
  runtime: Pick<DshCoreRuntime, 'withDatabase'>,
  sessions: ReviewSessionSource | undefined,
  persistence: ReviewPersistenceSource | undefined,
  sessionId: string,
): Promise<ReviewSessionBinding> {
  const live = sessions?.get(sessionId)
  const stored = live ? undefined : await persistence?.stat(sessionId)
  const cwd = live?.header?.cwd ?? stored?.header.cwd
  if ((live && live.id !== sessionId) || (stored && stored.header.id !== sessionId) || !cwd) throw new DiffReviewError('session_unavailable', 409)
  const project = await runtime.withDatabase(db => resolveProjectWorkspaceReadOnly(db, cwd, { allowDirectory: true }))
  if (!project) throw new DiffReviewError('repo_unavailable', 422)
  const canonicalCwd = await realpath(cwd)
  if (canonicalCwd !== project.repositoryRoot && !canonicalCwd.startsWith(project.repositoryRoot + '/')) {
    throw new DiffReviewError('session_workspace_mismatch', 409)
  }
  return { sessionId, cwd, repositoryRoot: project.repositoryRoot, repositoryId: project.repositoryId, workspace: project.workspace }
}

interface RunRow extends Record<string, unknown> { runId: string; status: string; startedAt: string; task: string | null; intakeId: string | null; ennoRoot: string | null }

function contextForRun(db: SqliteDatabase, binding: ReviewSessionBinding, run: RunRow): ReviewContext {
  if (!run.intakeId || run.ennoRoot && run.ennoRoot !== binding.repositoryRoot) return { source: 'unavailable', memory: 'mismatch', memories: [], reason: 'run_binding_mismatch' }
  const task = run.task ? redactDshSourceText(run.task)?.slice(0, 4000) : undefined
  const profile = readAkinatorSession(db, { workspace: binding.workspace, sessionId: run.intakeId }).profile
  const constraints = profile.constraints ? redactDshSourceText(profile.constraints)?.slice(0, 4000) : undefined
  const expected = profile.expected ? redactDshSourceText(profile.expected)?.slice(0, 4000) : undefined
  const fields = { ...(task ? { task } : {}), ...(constraints ? { constraints } : {}), ...(expected ? { expected } : {}) }
  let execution: NonNullable<ReviewContext['execution']> = []
  if (run.ennoRoot) {
    try {
      const snapshot = readEnnoSnapshot(db, { runId: run.runId, workspace: binding.workspace, orchestrationId: run.intakeId })
      execution = snapshot.finalEvidence.map(item => ({ id: item.verifier.id,
        command: redactDshSourceText([item.verifier.executable, ...item.verifier.args].join(' ')) ?? '[command withheld]',
        cwd: redactDshSourceText(item.verifier.cwd) ?? '[path withheld]',
        status: item.status === 'passed' && !item.skipped ? 'passed' : item.status === 'timeout' ? 'timeout' : 'failed',
        snapshotMatch: 'unproven', source: 'verifier-receipt' }))
    } catch { /* a broken receipt does not become successful execution evidence */ }
  }
  let deliveries: ReturnType<typeof listContextDeliveries>['items']
  try { deliveries = listContextDeliveries(db, { workspace: binding.workspace, runId: run.runId, limit: 1 }).items }
  catch { return { source: run.status === 'active' ? 'current-run' : 'completed-run', runId: run.runId, ...fields, status: run.status, memory: 'unavailable', memories: [], execution, reason: 'delivery_unavailable' } }
  const selected = deliveries[0]
  if (!selected) return { source: run.status === 'active' ? 'current-run' : 'completed-run', runId: run.runId, ...fields, status: run.status, memory: 'empty', memories: [], execution }
  let delivery: ReturnType<typeof readContextDelivery>
  try { delivery = readContextDelivery(db, { workspace: binding.workspace, deliveryId: selected.deliveryId }) }
  catch { return { source: run.status === 'active' ? 'current-run' : 'completed-run', runId: run.runId, ...fields,
    status: run.status, memory: 'unavailable', memories: [], execution, reason: 'delivery_unavailable' } }
  const memories: ReviewContext['memories'] = []
  for (const item of delivery.items.slice(0, 8)) {
    try {
      const workspace = item.origin === 'global' ? GLOBAL_WORKSPACE : binding.workspace
      const entry = readEntry(db, { workspace, entryId: item.entryId })
      if (entry.revision !== item.entryRevision || !isRetrievableEntry(db, entry)) continue
      const text = redactDshSourceText([entry.title, entry.summary ?? '', entry.body].filter(Boolean).join('\n'))
      if (text) memories.push({ entryId: entry.id, revision: entry.revision, deliveryId: delivery.deliveryId, text: text.slice(0, 3000), untrusted: true })
    } catch { /* withdrawn or invalid entries are not revived from an old delivery */ }
  }
  return { source: run.status === 'active' ? 'current-run' : 'completed-run', runId: run.runId,
    ...fields, status: run.status, memory: memories.length ? 'available' : delivery.items.length ? 'withheld' : 'empty', memories, execution }
}

/** Bounded native-session projection used after a task has ended too. */
export async function readSessionReviewContext(runtime: Pick<DshCoreRuntime, 'withDatabase'>, binding: ReviewSessionBinding, requestedRunId?: string): Promise<ReviewContext> {
  return runtime.withDatabase(db => {
    const rows = db.prepare(`SELECT lr.run_id AS runId, lr.status, lr.started_at AS startedAt,
      s.task_text AS task, ri.session_id AS intakeId, ec.repository_root AS ennoRoot
      FROM ledger_runs lr LEFT JOIN run_intakes ri ON ri.run_id=lr.run_id
      LEFT JOIN akinator_sessions s ON s.id=ri.session_id
      LEFT JOIN enno_contracts ec ON ec.run_id=lr.run_id
      WHERE lr.dsh_session_id=? AND lr.workspace=?
      ORDER BY lr.started_at DESC, lr.run_id ASC LIMIT 20`).all<RunRow>(binding.sessionId, binding.workspace)
    const active = rows.filter(row => row.status === 'active' || row.status === 'intake')
    if (active.length > 1) return { source: 'unavailable', memory: 'mismatch', memories: [], reason: 'ambiguous_active_runs' }
    const chosen = requestedRunId ? rows.find(row => row.runId === requestedRunId) : active[0] ?? (rows.length === 1 ? rows[0] : undefined)
    if (requestedRunId && !chosen) return { source: 'unavailable', memory: 'mismatch', memories: [], reason: 'run_identity_mismatch' }
    if (!chosen) return { source: 'unavailable', memory: 'empty', memories: [],
      candidates: rows.map(row => ({ runId: row.runId, task: row.task ? redactDshSourceText(row.task)?.slice(0, 200) ?? '[task withheld]' : '[task unavailable]', status: row.status, startedAt: row.startedAt })) }
    return contextForRun(db, binding, chosen)
  })
}
