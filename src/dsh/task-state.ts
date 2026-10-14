import { reopenTerminalCodingWorkflow } from './coding-workflow/service.js'
import { rotateTaskSourceInTransaction } from './task-source-history.js'
import * as z from 'zod/v4'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { TASK_TYPES, TERMINAL_RUN_STATUSES, type RunStatus, type TaskType } from '../ledger/types.js'
import { canonicalContentHash, type JsonValue } from '../serialization/validate.js'
import { executeIdempotentInTransaction } from './intake-idempotency.js'
import { assessTaskCompletion } from './task-completion.js'
import { completionVerifiers } from './completion-verifiers.js'

export const TASK_STATES = ['ToDo', 'Working', 'Pending', 'Done', 'Ignore'] as const
export type TaskState = typeof TASK_STATES[number]
export const TASK_OPERATIONS = ['start', 'wait', 'resume', 'complete', 'ignore'] as const
export type TaskOperation = typeof TASK_OPERATIONS[number]
const text = z.string().trim().min(1).max(4096)
export const TaskOperationSchema = z.object({ operation: z.enum(TASK_OPERATIONS), operationId: text.max(256),
  expectedRevision: z.number().int().positive(), expectedGeneration: z.number().int().positive().optional(),
  reason: text, evidence: z.array(text.max(512)).max(32).default([]), explicit: z.boolean().optional() }).strict()
export type TaskOperationInput = z.input<typeof TaskOperationSchema>
export interface TaskIdentity { taskId: string; sessionId: string; repositoryRoot: string }
export interface TaskLease extends TaskIdentity { revision: number; generation: number }
export const TASK_AUTHORITY = Symbol.for('kiokuko.task-authority.v1')
export interface TaskAuthorityExecution { [TASK_AUTHORITY]?: TaskLease }
export interface TaskSnapshot extends TaskIdentity {
  runId: string; type: TaskType | null; state: TaskState; revision: number; generation: number;
  runStatus: RunStatus; reason: string; evidence: string[]; allowedOps: TaskOperation[];
  request: string | null; resumedFromTerminal: boolean; sourceSessionId: string
  pendingStop?: TaskPendingStop | undefined
  unresolved?: TaskUnresolved | undefined
  previousOutcome?: TaskPreviousOutcome | undefined
}
export interface TaskPreviousOutcome { status: RunStatus; endedAt: string | null; revision: number; generation: number;
  sourceSessionId: string; ownerSessionId: string }
export interface TaskUnresolved { requestId: string; contextDigest: string; revision: number; reason: string; evidence: string[] }
export interface TaskPendingStop { operationId: string; operation: 'wait' | 'ignore'; requestedRevision: number;
  requestedGeneration: number; reason: string; evidence: string[] }
export const TaskSnapshotSchema = z.object({ taskId: text, runId: text, sessionId: text, repositoryRoot: text,
  type: z.enum(TASK_TYPES).nullable(), state: z.enum(TASK_STATES), revision: z.number().int().positive(),
  generation: z.number().int().positive(), runStatus: z.enum(['intake','active','completed','failed','cancelled','interrupted']),
  reason: z.string(), evidence: z.array(z.string()), allowedOps: z.array(z.enum(TASK_OPERATIONS)),
  request: z.string().nullable(), sourceSessionId: text, resumedFromTerminal: z.boolean(), pendingStop: z.object({ operationId: text,
    operation: z.enum(['wait','ignore']), requestedRevision: z.number().int().positive(), requestedGeneration: z.number().int().positive(),
    reason: text, evidence: z.array(z.string()) }).optional(), unresolved: z.object({ requestId: text,
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.number().int().positive(), reason: text,
    evidence: z.array(z.string()) }).optional(), previousOutcome: z.object({
    status: z.enum(['intake','active','completed','failed','cancelled','interrupted']), endedAt: z.string().nullable(),
    revision: z.number().int().positive(), generation: z.number().int().positive(), sourceSessionId: text, ownerSessionId: text,
  }).optional() }).strict()
type TaskRow = Record<string, unknown> & { run_id: string; dsh_session_id: string; task_owner_session_id: string | null; task_repository_root: string | null;
  task_state: TaskState; task_revision: number; task_generation: number; task_reason: string;
  task_evidence_json: string; task_resumed: number; task_pending_stop_json: string | null; task_unresolved_json: string | null;
  task_previous_outcome_json: string | null; ended_at: string | null;
  status: RunStatus; task_text: string | null; task_type: string | null; intake_status: string | null }
const selectTask = `SELECT r.*, a.task_text, a.status AS intake_status, json_extract(a.profile_json,'$.taskType') AS task_type
 FROM ledger_runs r LEFT JOIN run_intakes i ON i.run_id=r.run_id LEFT JOIN akinator_sessions a ON a.id=i.session_id`
function conflict(message: string): never { throw new KiokukoError('CONFLICT', message) }
const executionTerminal = (status: RunStatus) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
export function isTaskTerminal(task: Pick<TaskSnapshot, 'state'>): boolean { return task.state === 'Done' || task.state === 'Ignore' }
export function taskCanExecute(task: Pick<TaskSnapshot, 'state' | 'runStatus' | 'resumedFromTerminal' | 'pendingStop'>): boolean {
  return task.state === 'Working' && !task.pendingStop && !executionTerminal(task.runStatus)
}
/** For existing SQL admission lookups. Alias is an internal SQL identifier, never user input. */
export function taskEligibilitySql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/iu.test(alias)) throw new Error('Invalid task SQL alias')
  return `${alias}.task_state='Working' AND ${alias}.task_pending_stop_json IS NULL AND ${alias}.status IN ('intake','active')`
}
export function isTaskRunEligible(db: SqliteDatabase, taskId: string): boolean {
  return taskCanExecute(snapshot(rowFor(db, taskId)))
}
export function taskAllowedOperations(task: Pick<TaskSnapshot, 'state' | 'runStatus' | 'resumedFromTerminal' | 'pendingStop'>): TaskOperation[] {
  if (task.pendingStop) return []
  if (isTaskTerminal(task)) return ['resume']
  if (executionTerminal(task.runStatus)) return ['resume','ignore']
  if (task.state === 'ToDo') return ['start', 'wait', 'ignore']
  if (task.state === 'Working') return ['wait', 'complete', 'ignore']
  return ['resume', 'ignore']
}
function snapshot(row: TaskRow): TaskSnapshot {
  const result: TaskSnapshot = { taskId: row.run_id, runId: row.run_id, sessionId: row.task_owner_session_id ?? row.dsh_session_id,
    sourceSessionId: row.dsh_session_id,
    repositoryRoot: row.task_repository_root ?? '', type: (TASK_TYPES as readonly string[]).includes(row.task_type ?? '') ? row.task_type as TaskType : null,
    state: row.task_state, revision: row.task_revision, generation: row.task_generation, runStatus: row.status,
    reason: row.task_reason, evidence: JSON.parse(row.task_evidence_json) as string[], request: row.task_text,
    resumedFromTerminal: row.task_resumed === 1, allowedOps: [],
    ...(row.task_pending_stop_json ? { pendingStop: JSON.parse(row.task_pending_stop_json) as TaskPendingStop } : {}),
    ...(row.task_unresolved_json ? { unresolved: JSON.parse(row.task_unresolved_json) as TaskUnresolved } : {}),
    ...(row.task_previous_outcome_json ? { previousOutcome: JSON.parse(row.task_previous_outcome_json) as TaskPreviousOutcome } : {}) }
  result.allowedOps = taskAllowedOperations(result)
  return result
}
function rowFor(db: SqliteDatabase, taskId: string): TaskRow {
  const row = db.prepare(`${selectTask} WHERE r.run_id=?`).get<TaskRow>(taskId)
  if (!row) throw new KiokukoError('NOT_FOUND', 'Task does not exist')
  return row
}
export function readTaskSnapshot(db: SqliteDatabase, identity: TaskIdentity): TaskSnapshot {
  const row = rowFor(db, identity.taskId)
  if ((row.task_owner_session_id ?? row.dsh_session_id) !== identity.sessionId || row.task_repository_root !== identity.repositoryRoot)
    conflict('Task owner or repository changed')
  return snapshot(row)
}
/** Host-only initial binding; use the repository from admitted host context, never model arguments. */
export function bindTaskRepository(db: SqliteDatabase, identity: TaskIdentity): TaskSnapshot {
  const row = rowFor(db, identity.taskId)
  if (!identity.repositoryRoot.startsWith('/') || (row.task_owner_session_id ?? row.dsh_session_id) !== identity.sessionId
    || row.task_repository_root !== null && row.task_repository_root !== identity.repositoryRoot) conflict('Task owner or repository changed')
  if (row.task_repository_root === null) db.prepare(`UPDATE ledger_runs SET task_repository_root=? WHERE run_id=?
    AND COALESCE(task_owner_session_id,dsh_session_id)=? AND task_repository_root IS NULL`)
    .run(identity.repositoryRoot, identity.taskId, identity.sessionId)
  return readTaskSnapshot(db, identity)
}
/** Select only an unambiguous active task; callers may explicitly read a terminal task by ID. */
export function findSessionTask(db: SqliteDatabase, owner: Omit<TaskIdentity, 'taskId'>,
  options: { includeLatestTerminal?: boolean } = {}): TaskSnapshot | undefined {
  const rows = db.prepare(`${selectTask} WHERE COALESCE(r.task_owner_session_id,r.dsh_session_id)=? AND r.task_repository_root=?
    AND r.task_state NOT IN ('Done','Ignore') AND (r.status IN ('intake','active') OR r.task_pending_stop_json IS NOT NULL)
    ORDER BY r.updated_at DESC,r.run_id LIMIT 2`).all<TaskRow>(owner.sessionId, owner.repositoryRoot)
  const owned = rows.find(row => db.prepare('SELECT 1 FROM dsh_execution_owners WHERE dsh_session_id=? AND run_id=?').get(owner.sessionId, row.run_id))
  if (owned) return snapshot(owned)
  if (rows.length > 1) conflict('Multiple tasks match this session; select an explicit task ID')
  if (rows[0]) return snapshot(rows[0])
  const terminal = options.includeLatestTerminal ? db.prepare(`${selectTask} WHERE COALESCE(r.task_owner_session_id,r.dsh_session_id)=? AND r.task_repository_root=?
    ORDER BY r.updated_at DESC,r.run_id DESC LIMIT 1`).get<TaskRow>(owner.sessionId, owner.repositoryRoot) : undefined
  return terminal ? snapshot(terminal) : undefined
}
/** The pure validator is also the decision-provider/main-model/rebind contract. */
export function validateTaskOperation(task: TaskSnapshot, raw: TaskOperationInput): z.output<typeof TaskOperationSchema> {
  const input = TaskOperationSchema.parse(raw)
  if (input.expectedRevision !== task.revision || input.expectedGeneration !== undefined && input.expectedGeneration !== task.generation)
    conflict('Stale task revision or generation')
  if (!taskAllowedOperations(task).includes(input.operation)) conflict(`Operation ${input.operation} is not allowed in ${task.state}`)
  if (input.operation === 'resume' && (isTaskTerminal(task) || executionTerminal(task.runStatus)) && input.explicit !== true)
    conflict('A terminal task requires an explicit resume operation')
  return input
}
export function captureTaskLease(db: SqliteDatabase, identity: TaskIdentity): TaskLease {
  const task = readTaskSnapshot(db, identity)
  if (!taskCanExecute(task)) conflict('Task is not Working; start or explicitly resume it before execution')
  return { ...identity, revision: task.revision, generation: task.generation }
}
export function authorizeTaskLease(db: SqliteDatabase, lease: TaskLease): TaskSnapshot {
  const task = readTaskSnapshot(db, lease)
  if (!taskCanExecute(task) || task.revision !== lease.revision || task.generation !== lease.generation)
    conflict('Task execution authority is stale or stopped')
  return task
}
/** Host-only observation. Never expose verified/stopped booleans in model tool schemas. */
export function recordTaskEvidence(db: SqliteDatabase, identity: TaskIdentity, input: {
  ref: string; kind: 'verification' | 'stopped'; generation: number; verified: boolean; details?: JsonValue
}): void {
  const task = readTaskSnapshot(db, identity)
  if (!input.ref.trim() || input.ref.length > 512 || input.generation !== task.generation) conflict('Evidence belongs to an old task generation')
  const details = input.details ?? null
  const old = db.prepare('SELECT generation,kind,verified,details_json FROM ledger_task_evidence WHERE run_id=? AND evidence_ref=?')
    .get<{generation:number;kind:string;verified:number;details_json:string}>(identity.taskId, input.ref)
  if (old) {
    if (old.generation !== input.generation || old.kind !== input.kind || old.verified !== Number(input.verified)
      || canonicalContentHash(JSON.parse(old.details_json)) !== canonicalContentHash(details)) conflict('Evidence reference reused with changed observation')
    return
  }
  db.prepare('INSERT INTO ledger_task_evidence VALUES(?,?,?,?,?,?)')
    .run(identity.taskId, input.ref, input.generation, input.kind, Number(input.verified), JSON.stringify(details))
}
export function transitionTask(db: SqliteDatabase, identity: TaskIdentity, raw: TaskOperationInput, host?: { sourceEndSeq?: number }): TaskSnapshot {
  const parsed = TaskOperationSchema.parse(raw)
  return withImmediateTransaction(db, () => {
    // Ownership still applies when replaying a previously successful operation.
    readTaskSnapshot(db, identity)
    return executeIdempotentInTransaction(db, { scope: `task:${canonicalContentHash(identity.taskId)}`, key: parsed.operationId,
      request: { identity, ...parsed, ...(host ? { host } : {}) }, createdAt: new Date().toISOString() }, () => {
      const current = readTaskSnapshot(db, identity), input = validateTaskOperation(current, parsed)
      if (input.operation === 'start' || input.operation === 'resume') {
        const row = rowFor(db, identity.taskId)
        if (!row.intake_status || row.intake_status === 'active') conflict('Finish this task’s existing intake before starting or resuming it')
      }
      const proves = (kind: 'verification' | 'stopped') => input.evidence.some(ref => db.prepare(`SELECT 1 FROM ledger_task_evidence
        WHERE run_id=? AND evidence_ref=? AND generation=? AND kind=? AND verified=1`).get(identity.taskId, ref, current.generation, kind))
      if (input.operation === 'complete' && !proves('verification')) conflict('Completion requires current host-observed verification evidence')
      if (input.operation === 'complete') {
        const assessment = assessTaskCompletion(db, identity.taskId)
        if ((assessment.coding || assessment.required > 0) && !assessment.verified)
          conflict('Current task completion criteria are not verified')
        const enno = db.prepare(`SELECT e.workspace,e.orchestration_session_id AS orchestrationId FROM enno_contracts e
          JOIN dsh_execution_selections s ON s.run_id=e.run_id WHERE e.run_id=? AND json_extract(s.state_json,'$.mode')='enno'`)
          .get<{workspace:string;orchestrationId:string}>(identity.taskId)
        if (enno && completionVerifiers().codingProjection?.(db, { runId: identity.taskId, ...enno })?.completed !== true)
          conflict('Enno has not verified this task as completed')
      }
      if (current.state === 'Working' && ['wait','ignore'].includes(input.operation) && !proves('stopped'))
        conflict('Stopping a Working task requires a confirmed stop receipt')
      const state: TaskState = input.operation === 'complete' ? 'Done' : input.operation === 'ignore' ? 'Ignore'
        : input.operation === 'wait' ? 'Pending' : 'Working'
      if (input.operation === 'resume') rotateTaskSourceInTransaction(db, { runId: identity.taskId, sessionId: identity.sessionId,
        nextSessionId: identity.sessionId, expectedRevision: current.revision, expectedGeneration: current.generation,
        operationId: input.operationId, reason: input.reason, ...(host?.sourceEndSeq === undefined ? {} : { sourceEndSeq: host.sourceEndSeq }) }, new Date().toISOString())
      const reopen = input.operation === 'resume' && executionTerminal(current.runStatus)
      const previousOutcome: TaskPreviousOutcome | undefined = reopen ? { status: current.runStatus, endedAt: rowFor(db, identity.taskId).ended_at,
        revision: current.revision, generation: current.generation, sourceSessionId: current.sourceSessionId, ownerSessionId: current.sessionId } : current.previousOutcome
      db.prepare(`UPDATE ledger_runs SET task_state=?,task_revision=task_revision+1,task_generation=task_generation+1,
        task_reason=?,task_evidence_json=?,task_resumed=?,task_previous_outcome_json=?,
        status=CASE WHEN ?=1 THEN 'active' ELSE status END,ended_at=CASE WHEN ?=1 THEN NULL ELSE ended_at END,
        task_managed=1,updated_at=? WHERE run_id=? AND task_revision=?`)
        .run(state, input.reason, JSON.stringify(input.evidence), reopen ? 1 : Number(current.resumedFromTerminal),
          previousOutcome ? JSON.stringify(previousOutcome) : null, Number(reopen), Number(reopen),
          new Date().toISOString(), identity.taskId, current.revision)
      if (input.operation === 'resume') reopenTerminalCodingWorkflow(db, { runId: identity.taskId, sessionId: identity.sessionId,
        repositoryRoot: identity.repositoryRoot }, input.operationId, { terminalOutcome: executionTerminal(current.runStatus) || isTaskTerminal(current) })
      const updated = readTaskSnapshot(db, identity)
      if (updated.revision !== current.revision + 1) conflict('Task revision compare-and-swap failed')
      return updated as unknown as JsonValue
    }) as unknown as TaskSnapshot
  })
}
/** Durable stop request; acknowledging it is not evidence that the process stopped. */
export function requestTaskStop(db: SqliteDatabase, identity: TaskIdentity, raw: TaskOperationInput): TaskSnapshot {
  const input = TaskOperationSchema.parse(raw)
  if (input.operation !== 'wait' && input.operation !== 'ignore') conflict('Only wait or ignore can request a task stop')
  return withImmediateTransaction(db, () => {
    readTaskSnapshot(db, identity)
    return executeIdempotentInTransaction(db, { scope: `task:${canonicalContentHash(identity.taskId)}`, key: input.operationId,
      request: { identity, ...input }, createdAt: new Date().toISOString() }, () => {
      const current = readTaskSnapshot(db, identity)
      validateTaskOperation(current, input)
      if (current.state !== 'Working') conflict('A stop request requires a Working task')
      const pending: TaskPendingStop = { operationId: input.operationId, operation: input.operation as 'wait' | 'ignore',
        requestedRevision: current.revision, requestedGeneration: current.generation, reason: input.reason, evidence: input.evidence }
      db.prepare(`UPDATE ledger_runs SET task_pending_stop_json=?,task_revision=task_revision+1,task_generation=task_generation+1,
        task_reason=?,task_managed=1,updated_at=? WHERE run_id=? AND task_revision=?`)
        .run(JSON.stringify(pending), input.reason, new Date().toISOString(), identity.taskId, current.revision)
      return readTaskSnapshot(db, identity) as unknown as JsonValue
    }) as unknown as TaskSnapshot
  })
}
/** Host-only: finish the exact durable stop after all owned work is observed stopped. */
export function confirmTaskStop(db: SqliteDatabase, identity: TaskIdentity, input: {
  operationId: string; expectedRevision: number; evidenceRef: string
}): TaskSnapshot {
  return withImmediateTransaction(db, () => {
    readTaskSnapshot(db, identity)
    return executeIdempotentInTransaction(db, { scope: `task-stop-confirm:${canonicalContentHash(identity.taskId)}`, key: input.operationId,
      request: { identity, ...input }, createdAt: new Date().toISOString() }, () => {
      const current = readTaskSnapshot(db, identity), pending = current.pendingStop
      if (!pending || pending.operationId !== input.operationId || current.revision !== input.expectedRevision)
        conflict('Stop confirmation does not match the pending task operation')
      if (!db.prepare(`SELECT 1 FROM ledger_task_evidence WHERE run_id=? AND evidence_ref=? AND generation=? AND kind='stopped' AND verified=1`)
        .get(identity.taskId, input.evidenceRef, current.generation)) conflict('Task stop has not been confirmed by the host')
      db.prepare(`UPDATE ledger_runs SET task_state=?,task_pending_stop_json=NULL,task_revision=task_revision+1,
        task_generation=task_generation+1,task_evidence_json=?,updated_at=? WHERE run_id=? AND task_revision=?`)
        .run(pending.operation === 'ignore' ? 'Ignore' : 'Pending', JSON.stringify([...pending.evidence, input.evidenceRef]),
          new Date().toISOString(), identity.taskId, current.revision)
      return readTaskSnapshot(db, identity) as unknown as JsonValue
    }) as unknown as TaskSnapshot
  })
}
/** Trusted native handoff only. The original JSONL source session is immutable. */
export function transferTaskOwner(db: SqliteDatabase, identity: TaskIdentity, input: {
  sessionId: string; operationId: string; expectedRevision: number; expectedGeneration: number;
  reason: string; evidence: string[]; sourceEndSeq?: number
}): TaskSnapshot {
  text.max(256).parse(input.sessionId); text.max(256).parse(input.operationId); text.parse(input.reason)
  return withImmediateTransaction(db, () => executeIdempotentInTransaction(db, {
    scope: `task-owner:${canonicalContentHash(identity.taskId)}`, key: input.operationId,
    request: { identity, ...input }, createdAt: new Date().toISOString(),
  }, () => {
    const current = readTaskSnapshot(db, identity)
    if (current.revision !== input.expectedRevision || current.generation !== input.expectedGeneration || current.pendingStop)
      conflict('Task owner handoff is stale or a stop is unresolved')
    if (input.sessionId === identity.sessionId) conflict('Task handoff requires a new native session')
    if (current.state === 'Working' && !input.evidence.some(ref => db.prepare(`SELECT 1 FROM ledger_task_evidence
      WHERE run_id=? AND evidence_ref=? AND generation=? AND kind='stopped' AND verified=1`).get(identity.taskId, ref, current.generation)))
      conflict('Stop current task execution before transferring its owner')
    if (db.prepare(`SELECT 1 FROM ledger_runs WHERE COALESCE(task_owner_session_id,dsh_session_id)=?
      AND task_state NOT IN ('Done','Ignore') AND (status IN ('intake','active') OR task_pending_stop_json IS NOT NULL) AND run_id<>?`).get(input.sessionId, identity.taskId)
      || db.prepare('SELECT 1 FROM dsh_execution_owners WHERE dsh_session_id=? AND (run_id IS NULL OR run_id<>?)').get(input.sessionId, identity.taskId))
      conflict('The destination session already owns another task')
    const owner = db.prepare('SELECT dsh_session_id FROM dsh_execution_owners WHERE run_id=?').get<{dsh_session_id:string}>(identity.taskId)
    if (owner && owner.dsh_session_id !== identity.sessionId) conflict('Native execution owner changed before handoff')
    rotateTaskSourceInTransaction(db, { runId: identity.taskId, sessionId: identity.sessionId, nextSessionId: input.sessionId,
      expectedRevision: current.revision, expectedGeneration: current.generation, operationId: input.operationId, reason: input.reason, ...(input.sourceEndSeq === undefined ? {} : { sourceEndSeq: input.sourceEndSeq }) }, new Date().toISOString())
    db.prepare(`UPDATE ledger_runs SET task_owner_session_id=?,task_revision=task_revision+1,task_generation=task_generation+1,
      task_reason=?,task_evidence_json=?,task_managed=1,updated_at=? WHERE run_id=? AND task_revision=?`)
      .run(input.sessionId, input.reason, JSON.stringify(input.evidence), new Date().toISOString(), identity.taskId, current.revision)
    if (owner) db.prepare('UPDATE dsh_execution_owners SET dsh_session_id=? WHERE run_id=? AND dsh_session_id=?')
      .run(input.sessionId, identity.taskId, identity.sessionId)
    db.prepare(`UPDATE dsh_coding_workflows SET session_id=?,revision=revision+1,
      snapshot_json=json_set(snapshot_json,'$.sessionId',?,'$.revision',revision+1) WHERE run_id=? AND session_id=?`)
      .run(input.sessionId, input.sessionId, identity.taskId, identity.sessionId)
    db.prepare('UPDATE enno_contracts SET dsh_session_id=? WHERE run_id=? AND dsh_session_id=?')
      .run(input.sessionId, identity.taskId, identity.sessionId)
    return readTaskSnapshot(db, { ...identity, sessionId: input.sessionId }) as unknown as JsonValue
  }) as unknown as TaskSnapshot)
}
/** Persist unresolved interpretation without inventing another task or changing its request. */
export function recordTaskUnresolved(db: SqliteDatabase, identity: TaskIdentity, input: {
  operationId: string; expectedRevision: number; requestId: string; contextDigest: string; reason: string; evidence?: string[]
}): TaskSnapshot {
  text.parse(input.requestId); text.parse(input.reason); z.string().regex(/^[a-f0-9]{64}$/u).parse(input.contextDigest)
  return withImmediateTransaction(db, () => executeIdempotentInTransaction(db, {
    scope: `task-decision:${canonicalContentHash(identity.taskId)}`, key: input.operationId,
    request: { identity, operation: 'unresolved', ...input }, createdAt: new Date().toISOString(),
  }, () => {
    const current = readTaskSnapshot(db, identity)
    if (current.revision !== input.expectedRevision) conflict('Stale unresolved task revision')
    const unresolved: TaskUnresolved = { requestId: input.requestId, contextDigest: input.contextDigest,
      revision: current.revision, reason: input.reason, evidence: input.evidence ?? [] }
    db.prepare('UPDATE ledger_runs SET task_unresolved_json=? WHERE run_id=? AND task_revision=?')
      .run(JSON.stringify(unresolved), identity.taskId, current.revision)
    return readTaskSnapshot(db, identity) as unknown as JsonValue
  }) as unknown as TaskSnapshot)
}
/** Resolving one request cannot clear another request's unresolved decision. */
export function clearTaskUnresolved(db: SqliteDatabase, identity: TaskIdentity, input: {
  requestId: string; contextDigest: string; expectedRevision: number
}): TaskSnapshot {
  const task = readTaskSnapshot(db, identity)
  if (task.revision !== input.expectedRevision || task.unresolved && (task.unresolved.requestId !== input.requestId
    || task.unresolved.contextDigest !== input.contextDigest)) conflict('Unresolved decision identity changed')
  db.prepare('UPDATE ledger_runs SET task_unresolved_json=NULL WHERE run_id=? AND task_revision=?').run(identity.taskId, task.revision)
  return readTaskSnapshot(db, identity)
}
