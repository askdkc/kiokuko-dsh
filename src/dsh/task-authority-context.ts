import { AsyncLocalStorage } from 'node:async_hooks'
import { KiokukoError } from '../errors.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { TASK_AUTHORITY, bindTaskRepository, captureTaskLease, authorizeTaskLease, type TaskIdentity, type TaskLease, type TaskAuthorityExecution } from './task-state.js'

// DSH reconstructs ToolExecutionInput and drops extra fields and symbols.
// Keep host-only authority across that boundary without accepting model JSON.
const authority = new AsyncLocalStorage<TaskLease | null>()
export function withTaskAuthority<T>(lease: TaskLease, operation: () => T): T {
  return authority.run(Object.freeze({ ...lease }), operation)
}
export function withNoTaskAuthority<T>(operation: () => T): T { return authority.run(null, operation) }
export function hasNoTaskAuthority(): boolean { return authority.getStore() === null }
export function currentTaskAuthority(): TaskLease | undefined {
  return authority.getStore() ?? undefined
}
export function captureExecutionTaskLease(db: SqliteDatabase, identity: TaskIdentity, execution?: TaskAuthorityExecution): TaskLease {
  if (hasNoTaskAuthority()) throw new KiokukoError('CONFLICT', 'This execution started without task authority')
  const inherited = execution?.[TASK_AUTHORITY] ?? currentTaskAuthority()
  if (inherited) {
    if (inherited.taskId !== identity.taskId || inherited.sessionId !== identity.sessionId || inherited.repositoryRoot !== identity.repositoryRoot)
      throw new KiokukoError('CONFLICT', 'Task execution owner changed')
    authorizeTaskLease(db, inherited)
    return inherited
  }
  bindTaskRepository(db, identity)
  return Object.freeze(captureTaskLease(db, identity))
}
