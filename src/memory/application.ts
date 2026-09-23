import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { captureProjectManifestSnapshot, resolveProjectFingerprint } from '../repository/project-fingerprint.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { findSecret } from './secrets.js'
import { readEntry } from './entries.js'
import { isRetrievableEntry, retrievableWorkspaceEntryCount } from './hybrid-retrieval.js'
import { hasActionableMemorySelection, memoryReasoningRequired, hasExplicitCodingIntent } from '../akinator/capabilities.js'
import { readContextDelivery } from '../context/delivery.js'
import { capturePolicy } from './capture-policy.js'
import { autoGlobalizationInstalled, enqueueAutoGlobalRecheck } from './auto-global-queue.js'
import type { ScopedContextResult } from '../context/scoped-broker.js'
import type { TaskProfile } from '../akinator/types.js'

const text = z.string().trim().min(1).max(4000).refine(value => !findSecret(value), 'Secrets are not application evidence')
const relativePath = z.string().min(1).max(512).refine(value => !path.isAbsolute(value)
  && !value.split(/[\\/]/u).some(part => part === '..' || part === '.git') && !/[\p{Cc}\p{Cf}]/u.test(value), 'Use a repository-relative path')
export const memoryApplicationReviewSchema = z.object({
  generation: z.number().int().positive(), entryId: z.string().min(1).max(256), entryRevision: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(), decision: z.enum(['adopted', 'not_applicable', 'contradicted']),
  basis: text, paths: z.array(relativePath).max(32),
  invariant: text.optional(), counterexample: text.optional(), method: text.optional(), command: text.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === 'adopted' && (!value.invariant || !value.counterexample || !value.method)) {
    ctx.addIssue({ code: 'custom', message: 'Adoption requires an invariant, counterexample and verification method' })
  }
  if (value.decision !== 'not_applicable' && value.paths.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['paths'], message: 'Source-dependent decisions require paths' })
  }
})
export type MemoryApplicationReview = z.infer<typeof memoryApplicationReviewSchema>
export interface MemoryApplicationIdentity { runId: string; workspace: string; sessionId: string; repositoryRoot: string }
interface Binding extends Record<string, unknown> {
  run_id: string; workspace: string; session_id: string; repository_root: string; delivery_id: string | null;
  generation: number; mode: 'code' | 'plan' | 'none'; retrieval: string; required_json: string; epoch: number; fingerprint_json: string | null
}
interface RequiredMemory { entryId: string; revision: number; deliveryId: string }
interface ReviewRow extends Record<string, unknown> { entry_id: string; review_revision: number; request_hash: string; review_json: string; source_digest: string }
interface ExecutionRow extends Record<string, unknown> {
  run_id: string; call_id: string; generation: number; epoch: number; command_hash: string; review_hash: string; source_digest: string; outcome: string; result_hash: string | null
}
function conflict(message: string): never { throw new KiokukoError('CONFLICT', message) }
function binding(db: SqliteDatabase, runId: string): Binding | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_memory_bindings'").get()) return undefined
  return db.prepare('SELECT * FROM task_memory_bindings WHERE run_id=?').get<Binding>(runId)
}
function assertIdentity(db: SqliteDatabase, identity: MemoryApplicationIdentity): Binding {
  const current = binding(db, identity.runId)
  const run = db.prepare('SELECT workspace,dsh_session_id,status FROM ledger_runs WHERE run_id=?').get(identity.runId)
  if (!current || current.workspace !== identity.workspace || current.session_id !== identity.sessionId
    || current.repository_root !== realpathSync(identity.repositoryRoot) || run?.workspace !== identity.workspace
    || run.dsh_session_id !== identity.sessionId || run.status !== 'active') conflict('Memory application run is not active or identity changed')
  return current
}
export function memoryApplicationMode(profile: TaskProfile): Binding['mode'] {
  if (/(?:文章|作文|文体|表記|翻訳|翻案|prose|translation|sentence)/iu.test(profile.expected ?? '') && !hasExplicitCodingIntent(profile)) return 'none'
  if (profile.taskType === 'chat' || profile.taskType === 'research') return 'none'
  if (profile.taskType === 'review' || profile.taskType === 'analysis' || profile.taskType === 'writing') return memoryReasoningRequired(profile, 'actionable') ? 'plan' : 'none'
  if (/plan only|planning only|計画のみ|実装しない|計画を作|実装計画/iu.test([profile.expected, profile.constraints].join(' '))) return 'plan'
  return profile.taskType === 'build' || profile.taskType === 'debug' || profile.taskType === 'devops' ? 'code' : 'none'
}

export function memoryRetrievalStatus(db: SqliteDatabase, workspace: string, context: ScopedContextResult | null, withheld = false): string {
  if (withheld) return 'capability_withheld'
  if (!context) return 'unavailable'
  if (context.items.length) return 'delivered'
  if (context.omissions?.some(item => item.reason === 'semantic_not_applicable')) return 'out_of_scope'
  if (context.omissions?.length) return 'filtered'
  return retrievableWorkspaceEntryCount(db, workspace) + retrievableWorkspaceEntryCount(db, 'global') === 0 ? 'no_project_or_global_memory' : 'no_match'
}

/** Native admission binds the actual delivery, never a model-supplied run or session. */
export function bindMemoryApplication(db: SqliteDatabase, identity: MemoryApplicationIdentity,
  profile: TaskProfile, context: ScopedContextResult | null, retrieval = 'delivered'): void {
  withImmediateTransaction(db, () => {
    const run = db.prepare('SELECT workspace,dsh_session_id,status FROM ledger_runs WHERE run_id=?').get(identity.runId)
    if (run?.workspace !== identity.workspace || run.dsh_session_id !== identity.sessionId || run.status !== 'active') conflict('Memory admission identity changed')
    const root = realpathSync(identity.repositoryRoot), mode = memoryApplicationMode(profile)
    const repository = db.prepare('SELECT repository_id FROM repositories WHERE workspace=?').get<{repository_id:string}>(identity.workspace)
    let fingerprintJson: string | null = null
    if (repository !== undefined) {
      try {
        fingerprintJson = JSON.stringify(resolveProjectFingerprint(db,
          { repositoryRoot: root, repositoryId: repository.repository_id, workspace: identity.workspace, source: 'local-path' },
          captureProjectManifestSnapshot({ repositoryRoot: root, repositoryId: repository.repository_id }), { readOnly: true }))
      } catch { /* An unavailable fingerprint withholds automatic proof without blocking the task. */ }
    }
    const deliveryId = context?.deliveryId ?? null
    let required: RequiredMemory[] = []
    if (deliveryId) {
      const delivery = readContextDelivery(db, { workspace: identity.workspace, deliveryId })
      if (delivery.runId !== identity.runId) conflict('Memory delivery belongs to another run')
      required = mode === 'none' ? [] : delivery.items.filter(item => hasActionableMemorySelection([item]))
        .map(item => ({ entryId: item.entryId, revision: item.entryRevision, deliveryId }))
    }
    const previous = binding(db, identity.runId)
    let invalidateReviews = previous !== undefined && previous.mode !== mode
    // A narrower follow-up query cannot erase an already delivered obligation.
    // Re-delivery of the same entry revision does not undo its existing decision.
    if (previous && mode !== 'none') {
      const previousRequired = JSON.parse(previous.required_json) as RequiredMemory[]
      const previousById = new Map(previousRequired.map(item => [item.entryId, item]))
      required = required.map(item => {
        const earlier = previousById.get(item.entryId)
        if (!earlier) return item
        if (earlier.revision !== item.revision) {
          invalidateReviews = true
          return item
        }
        return earlier
      })
      const selected = new Set(required.map(item => item.entryId))
      required.push(...previousRequired.filter(item => !selected.has(item.entryId)))
    }
    if (required.length > 128) conflict('Memory application obligation budget exceeded')
    const requiredJson = JSON.stringify(required)
    if (previous) {
      assertIdentity(db, identity)
      if (previous.delivery_id === deliveryId && previous.required_json === requiredJson && previous.mode === mode
        && previous.retrieval === retrieval && previous.fingerprint_json === fingerprintJson) return
      // A new delivery invalidates execution proof, but only a changed entry revision or mode invalidates decisions.
      db.prepare('UPDATE task_memory_bindings SET delivery_id=?,generation=generation+?,mode=?,retrieval=?,required_json=?,epoch=epoch+1,fingerprint_json=? WHERE run_id=?')
        .run(deliveryId, invalidateReviews ? 1 : 0, mode, retrieval, requiredJson, fingerprintJson, identity.runId)
    } else db.prepare('INSERT INTO task_memory_bindings(run_id,workspace,session_id,repository_root,delivery_id,generation,mode,retrieval,required_json,fingerprint_json) VALUES(?,?,?,?,?,1,?,?,?,?)')
      .run(identity.runId, identity.workspace, identity.sessionId, root, deliveryId, mode, retrieval, requiredJson, fingerprintJson)
  })
}

/** Hash only explicitly declared source/test/config paths; no contents or logs are persisted. */
export function applicationSourceDigest(root: string, paths: readonly string[]): string {
  const canonicalRoot = realpathSync(root), rows: unknown[] = []
  let bytes = 0, count = 0
  const visit = (relative: string): void => {
    relativePath.parse(relative)
    if (++count > 2048) conflict('Memory verification path budget exceeded')
    const absolute = path.resolve(canonicalRoot, relative)
    if (absolute !== canonicalRoot && !absolute.startsWith(canonicalRoot + path.sep)) conflict('Memory verification path escapes repository')
    // Check every existing ancestor: never follow a symlink into another tree.
    for (let current = absolute; current !== canonicalRoot; current = path.dirname(current)) {
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) conflict('Memory verification paths cannot contain symlinks')
    }
    const stat = lstatSync(absolute, { throwIfNoEntry: false })
    if (!stat) { rows.push([relative, 'missing']); return }
    if (stat.isDirectory()) {
      rows.push([relative, 'directory'])
      for (const child of readdirSync(absolute).sort()) visit(path.join(relative, child))
    } else if (stat.isFile()) {
      bytes += stat.size
      if (bytes > 16 * 1024 * 1024) conflict('Memory verification byte budget exceeded')
      rows.push([relative, stat.mode, canonicalContentHash(readFileSync(absolute).toString('base64'))])
    } else conflict('Memory verification path is not a regular file')
  }
  for (const relative of [...new Set(paths)].sort()) visit(relative)
  return canonicalContentHash({ root: canonicalRoot, rows })
}
function reviews(db: SqliteDatabase, current: Binding): ReviewRow[] {
  const rows = db.prepare(`SELECT r.* FROM task_memory_reviews r WHERE run_id=? AND generation=?
    AND review_revision=(SELECT MAX(review_revision) FROM task_memory_reviews q WHERE q.run_id=r.run_id AND q.generation=r.generation AND q.entry_id=r.entry_id) ORDER BY entry_id`)
    .all<ReviewRow>(current.run_id, current.generation)
  for (const row of rows) {
    const review = memoryApplicationReviewSchema.parse(JSON.parse(row.review_json))
    if (canonicalContentHash(review) !== row.request_hash || review.entryId !== row.entry_id || review.expectedRevision + 1 !== row.review_revision) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored memory review changed')
    }
  }
  return rows
}
function assertEntryCurrent(db: SqliteDatabase, item: RequiredMemory): void {
  const workspace = db.prepare('SELECT workspace FROM entries WHERE id=?').get<{workspace:string}>(item.entryId)?.workspace
  const entry = workspace ? readEntry(db, { entryId: item.entryId, workspace }) : undefined
  if (!entry || entry.status === 'superseded' || entry.revision !== item.revision || !isRetrievableEntry(db, entry)) conflict('Memory entry changed; refresh its delivery and review')
}
function recordMemoryApplicationReviewInTransaction(db: SqliteDatabase, identity: MemoryApplicationIdentity,
  requestId: string, review: MemoryApplicationReview): unknown {
  if (!requestId || requestId.length > 256) conflict('Invalid memory review request identity')
  const current = assertIdentity(db, identity), requestHash = canonicalContentHash(review)
  const replay = db.prepare('SELECT request_hash,review_revision FROM task_memory_reviews WHERE run_id=? AND request_id=?').get(identity.runId, requestId)
  if (replay) {
    if (replay.request_hash !== requestHash) conflict('Memory review request identity reused with different input')
    if (current.generation !== review.generation) conflict('Memory delivery changed')
    return { revision: replay.review_revision, provenance: 'model_reported' }
  }
  if (current.generation !== review.generation) conflict('Memory delivery changed')
  const selected = (JSON.parse(current.required_json) as RequiredMemory[]).find(item => item.entryId === review.entryId && item.revision === review.entryRevision)
  if (!selected) conflict('Memory was not selected for this delivery')
  assertEntryCurrent(db, selected)
  if (current.mode === 'code' && review.decision === 'adopted' && !review.command) conflict('Code memory adoption requires an exact native command')
  const previous = reviews(db, current).find(row => row.entry_id === review.entryId)
  if ((previous?.review_revision ?? 0) !== review.expectedRevision) conflict('Memory review revision changed')
  const revision = review.expectedRevision + 1
  db.prepare('INSERT INTO task_memory_reviews(run_id,generation,entry_id,entry_revision,review_revision,request_id,request_hash,review_json,source_digest) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(identity.runId, current.generation, review.entryId, review.entryRevision, revision, requestId, requestHash, JSON.stringify(review), applicationSourceDigest(current.repository_root, review.paths))
  if (review.decision === 'contradicted') enqueueAutoGlobalRecheck(db, review.entryId, review.entryRevision)
  return { revision, provenance: 'model_reported' }
}
export function recordMemoryApplicationReview(db: SqliteDatabase, identity: MemoryApplicationIdentity, requestId: string, raw: unknown): unknown {
  const review = memoryApplicationReviewSchema.parse(raw)
  return withImmediateTransaction(db, () => recordMemoryApplicationReviewInTransaction(db, identity, requestId, review))
}

/** One native call can resolve several independent decisions; any failure rolls them all back. */
export function recordMemoryApplicationReviewBatch(db: SqliteDatabase, identity: MemoryApplicationIdentity,
  requestId: string, raw: unknown): unknown {
  const batch = z.array(memoryApplicationReviewSchema).min(1).max(32).parse(raw)
  if (!requestId || requestId.length > 256) conflict('Invalid memory review request identity')
  return withImmediateTransaction(db, () => {
    for (const [index, review] of batch.entries()) {
      recordMemoryApplicationReviewInTransaction(db, identity,
        `batch:${canonicalContentHash({ requestId, index })}`, review)
    }
    return memoryApplicationStatus(db, identity.runId)
  })
}

export function memoryApplicationStatus(db: SqliteDatabase, runId: string) {
  const current = binding(db, runId)
  if (!current) return { supported: false as const, ready: true, pending: [], verification: 'unobserved' as const }
  const required = JSON.parse(current.required_json) as RequiredMemory[], stored = reviews(db, current)
  const items = required.map(item => {
    const row = stored.find(candidate => candidate.entry_id === item.entryId)
    let problem: string | null = null, verification = 'not_required', evidenceCallId: string | null = null
    try { assertEntryCurrent(db, item) } catch { problem = 'entry_changed' }
    if (!row) problem ??= 'decision_missing'
    else {
      const review = JSON.parse(row.review_json) as MemoryApplicationReview
      try {
        const digest = applicationSourceDigest(current.repository_root, review.paths)
        if (review.decision !== 'adopted' || current.mode !== 'code') {
          if (digest !== row.source_digest) problem ??= 'basis_changed'
          verification = 'model_reported'
        } else {
          const selected = stored.filter(row => {
            const value = JSON.parse(row.review_json) as MemoryApplicationReview
            return value.decision === 'adopted' && value.command === review.command
          })
          const latest = db.prepare(`SELECT * FROM task_memory_executions WHERE run_id=? AND generation=? AND epoch=? AND command_hash=? ORDER BY rowid DESC LIMIT 1`)
            .get<ExecutionRow>(runId, current.generation, current.epoch, canonicalContentHash(review.command))
          const evidence = latest?.outcome === 'passed'
            && latest.review_hash === canonicalContentHash(selected.map(row => row.request_hash))
            && latest.source_digest === applicationSourceDigest(current.repository_root, selected.flatMap(row => (JSON.parse(row.review_json) as MemoryApplicationReview).paths)) ? latest : undefined
          verification = evidence ? 'client_observed' : 'missing_failed_or_stale'
          evidenceCallId = evidence?.call_id ?? null
          if (!evidence) problem ??= 'verification_missing_failed_or_stale'
        }
      } catch { problem ??= 'source_unavailable' }
    }
    return { ...item, reviewRevision: row?.review_revision ?? 0, decision: row ? (JSON.parse(row.review_json) as MemoryApplicationReview).decision : null, problem, verification, evidenceCallId }
  })
  const running = db.prepare("SELECT COUNT(*) AS count FROM task_memory_executions WHERE run_id=? AND outcome='running'").get<{count:number}>(runId)!.count
  return { supported: true as const, running, generation: current.generation, deliveryId: current.delivery_id, mode: current.mode,
    retrieval: current.retrieval, ready: running === 0 && items.every(item => item.problem === null), pending: items.filter(item => item.problem !== null), items,
    verification: items.some(item => item.verification === 'client_observed') ? 'client_observed' : 'unobserved' }
}
export function assertMemoryApplicationComplete(db: SqliteDatabase, runId: string): void {
  const status = memoryApplicationStatus(db, runId)
  if (!status.ready) throw new KiokukoError('CONFLICT', 'Memory application or regression verification is incomplete', { memoryApplication: status })
}

/** Record only newly completed, host-observed applications in the run's transaction. */
export function recordCompletedMemoryApplicationsInTransaction(db: SqliteDatabase, runId: string, completedAt: string): void {
  if (!autoGlobalizationInstalled(db)) return
  const current = binding(db, runId)
  if (!current || current.mode !== 'code' || !current.fingerprint_json) return
  if (capturePolicy(db, current.workspace, current.session_id).mode !== 'allowed') return
  const state = memoryApplicationStatus(db, runId)
  if (!state.supported || !state.ready) return
  const repositoryId = db.prepare('SELECT repository_id FROM repositories WHERE workspace=?')
    .get<{repository_id:string}>(current.workspace)?.repository_id
  if (!repositoryId) return
  let rootRunId = runId
  const ancestors = new Set<string>()
  for (let depth = 0; depth < 32; depth++) {
    if (ancestors.has(rootRunId)) throw new KiokukoError('INTEGRITY_ERROR', 'Run parent chain has a cycle')
    ancestors.add(rootRunId)
    const parent = db.prepare('SELECT parent_run_id FROM ledger_runs WHERE run_id=?').get<{parent_run_id:string|null}>(rootRunId)
    if (!parent) throw new KiokukoError('INTEGRITY_ERROR', 'Run parent chain is incomplete')
    if (!parent.parent_run_id) break
    rootRunId = parent.parent_run_id
    if (depth === 31) throw new KiokukoError('INTEGRITY_ERROR', 'Run parent chain exceeds bound')
  }
  const latestReviews = reviews(db, current)
  for (const item of state.items) {
    if (item.decision !== 'adopted' || item.verification !== 'client_observed' || !item.evidenceCallId || item.problem) continue
    const workspace = db.prepare('SELECT workspace FROM entries WHERE id=?').get<{workspace:string}>(item.entryId)?.workspace
    if (!workspace || workspace === 'global') continue
    const entry = readEntry(db, {workspace, entryId:item.entryId})
    if (entry.status !== 'candidate' || entry.revision !== item.revision) continue
    const review = latestReviews.find(row => row.entry_id === item.entryId)
    if (!review) continue
    const execution = db.prepare('SELECT * FROM task_memory_executions WHERE run_id=? AND call_id=?')
      .get<ExecutionRow>(runId, item.evidenceCallId)
    if (!execution || execution.outcome !== 'passed' || !execution.result_hash || execution.generation !== current.generation
      || execution.epoch !== current.epoch || execution.source_digest !== review.source_digest) continue
    const receipt = {entry_id:item.entryId, entry_revision:item.revision, run_id:runId,
      root_run_id:rootRunId, workspace:current.workspace, repository_id:repositoryId,
      session_id:current.session_id, delivery_id:item.deliveryId, generation:current.generation,
      epoch:current.epoch, review_hash:review.request_hash, source_digest:review.source_digest,
      execution_call_id:execution.call_id, result_hash:execution.result_hash,
      fingerprint_json:current.fingerprint_json, completed_at:completedAt}
    const digest = canonicalContentHash(receipt)
    db.prepare(`INSERT OR IGNORE INTO auto_global_application_receipts
      (entry_id,entry_revision,run_id,root_run_id,workspace,repository_id,session_id,delivery_id,
       generation,epoch,review_hash,source_digest,execution_call_id,result_hash,fingerprint_json,completed_at,receipt_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(receipt),digest)
    const persisted = db.prepare('SELECT receipt_digest FROM auto_global_application_receipts WHERE entry_id=? AND entry_revision=? AND run_id=?')
      .get<{receipt_digest:string}>(item.entryId,item.revision,runId)
    if (persisted?.receipt_digest !== digest) throw new KiokukoError('INTEGRITY_ERROR', 'Memory application receipt conflicts with completed run')
    enqueueAutoGlobalRecheck(db, item.entryId, item.revision, completedAt)
  }
}

/** Host pre-execution: unknown effectful calls invalidate prior proof, including concurrent work. */
export function beginMemoryExecution(db: SqliteDatabase, identity: MemoryApplicationIdentity, callId: string, command: string | null): void {
  withImmediateTransaction(db, () => {
    const current = assertIdentity(db, identity), status = memoryApplicationStatus(db, identity.runId)
    if (!status.supported || !status.items.length) return
    if (status.items.some(item => item.problem === 'decision_missing' || item.problem === 'entry_changed' || item.problem === 'basis_changed' || item.problem === 'source_unavailable')) conflict('Use task_memory_review to resolve memory decisions before executing or editing')
    const old = db.prepare('SELECT * FROM task_memory_executions WHERE run_id=? AND call_id=?').get<ExecutionRow>(identity.runId, callId)
    if (old) conflict('Native tool call was already observed; do not replay effects')
    const selected = command ? reviews(db, current).filter(row => {
      const review = JSON.parse(row.review_json) as MemoryApplicationReview
      return review.decision === 'adopted' && review.command === command
    }) : []
    const epoch = current.epoch + (selected.length ? 0 : 1)
    if (epoch !== current.epoch) db.prepare('UPDATE task_memory_bindings SET epoch=? WHERE run_id=?').run(epoch, identity.runId)
    db.prepare('INSERT INTO task_memory_executions(run_id,call_id,generation,epoch,command_hash,review_hash,source_digest,outcome) VALUES(?,?,?,?,?,?,?,?)')
      .run(identity.runId, callId, current.generation, epoch, canonicalContentHash(command), canonicalContentHash(selected.map(row => row.request_hash)),
        applicationSourceDigest(current.repository_root, selected.flatMap(row => (JSON.parse(row.review_json) as MemoryApplicationReview).paths)), 'running')
  })
}
/** Typed native result only. Text claiming success is not an observation. */
export function completeMemoryExecution(db: SqliteDatabase, identity: MemoryApplicationIdentity, callId: string, result: unknown): void {
  withImmediateTransaction(db, () => {
    const current = assertIdentity(db, identity)
    const execution = db.prepare('SELECT * FROM task_memory_executions WHERE run_id=? AND call_id=?').get<ExecutionRow>(identity.runId, callId)
    if (!execution) return
    const r = result as { isError?: boolean; value?: { exitCode?: number; exit_code?: number; kind?: string; skipped?: boolean; timedOut?: boolean; aborted?: boolean; signal?: unknown }; content?: unknown }
    const value = r?.value, exit = value?.exitCode ?? value?.exit_code
    const rawContent = JSON.stringify(r?.content ?? '')
    const resultHash = canonicalContentHash({ exit: exit ?? null, value: value ?? null, isError: r?.isError ?? null, contentDigest: canonicalContentHash(rawContent) })
    if (execution.outcome !== 'running') {
      if (execution.result_hash !== resultHash) conflict('Native result changed on replay')
      return
    }
    const selected = reviews(db, current).filter(row => canonicalContentHash((JSON.parse(row.review_json) as MemoryApplicationReview).command ?? null) === execution.command_hash)
    let fresh = false
    try { fresh = execution.generation === current.generation && execution.epoch === current.epoch
      && execution.review_hash === canonicalContentHash(selected.map(row => row.request_hash))
      && execution.source_digest === applicationSourceDigest(current.repository_root, selected.flatMap(row => (JSON.parse(row.review_json) as MemoryApplicationReview).paths)) } catch { /* remains stale */ }
    const content = rawContent.slice(0, 64_000)
    const skipped = value?.skipped === true || /(?:# SKIP|\b[1-9]\d* (?:skipped|pending)\b|# (?:skipped|todo) [1-9])/iu.test(content)
    const unknown = rawContent.length > 64_000 || !Number.isSafeInteger(exit) || value?.kind === 'background' || skipped
    const outcome = value?.kind === 'background' ? 'running' : !fresh ? 'stale' : unknown ? 'unknown' : exit !== 0 || r?.isError || value?.timedOut || value?.aborted || value?.signal != null ? 'failed' : 'passed'
    db.prepare('UPDATE task_memory_executions SET outcome=?,exit_code=?,result_hash=? WHERE run_id=? AND call_id=? AND outcome=\'running\'')
      .run(outcome, Number.isSafeInteger(exit) ? exit! : null, resultHash, identity.runId, callId)
  })
}
