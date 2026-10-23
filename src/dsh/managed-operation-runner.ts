import { canonicalContentHash } from '../serialization/validate.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ManagedOperationJournal } from './managed-operation-journal.js'
import type { SqliteDatabase } from '../db/adapter.js'

export interface JournalDatabase { <T>(fn: (db: SqliteDatabase) => T): Promise<T> }
export interface ManagedScope { database: JournalDatabase; scopeId: string; direct?: boolean; nested?: boolean; parentOperation?: ActiveOperation }
interface ActiveOperation extends ManagedScope { operationId: string; kind: 'process' | 'file' }
const active = new AsyncLocalStorage<ActiveOperation>()
const deniedBeforeDispatch = new WeakSet<object>()
export function managedAdmissionDenied(error: unknown): never { if (error && typeof error === 'object') deniedBeforeDispatch.add(error); throw error }
export const currentManagedOperation = () => active.getStore()
export const isManagedAdmissionDenied = (error: unknown): boolean => error instanceof ManagedDispatchDenied || !!error && typeof error === 'object' && deniedBeforeDispatch.has(error)

/** Receipts are supplied by the host adapter, never by Lisp return values. */
export async function observeManagedResult(operation: ActiveOperation, value: unknown): Promise<void> {
  const result = value as any, receipt = result?.receipt
  if (!receipt) return // A projected job ID is not a new process observation.
  const stopped = receipt?.processStopped === true
  const completed = receipt?.state !== 'denied' && (receipt?.state === 'completed' || receipt?.state === 'cancelled' || (receipt?.route === 'native' && stopped))
  const state = receipt?.state === 'denied' && receipt?.processStarted === false ? 'denied' : completed && (operation.kind === 'file' || stopped)
    ? receipt?.cancelled || receipt?.state === 'cancelled' ? receipt?.processStarted === false ? 'cancelled-before-dispatch' : 'cancelled-confirmed' : 'completed'
    : receipt?.state === 'started' && receipt?.processStarted === true ? 'running' : 'unknown'
  const code = result?.exitCode ?? result?.code ?? receipt?.exitCode
  await operation.database(db => {
    const journal = new ManagedOperationJournal(db), previous = journal.readOperation(operation.operationId)
    if (['completed','cancelled-confirmed','denied','cancelled-before-dispatch'].includes(previous.state)) return
    const next = {
    state: state as 'denied' | 'completed' | 'cancelled-confirmed' | 'cancelled-before-dispatch' | 'running' | 'unknown',
    ...(state === 'completed' ? { outcome: operation.kind === 'file' || code === 0 ? 'succeeded' as const : 'failed' as const } : {}),
    ...(typeof receipt?.operationId === 'string' ? { receiptRef: canonicalContentHash(receipt) } : {}),
  }
    if (previous.state === 'unknown' && (state === 'completed' || state === 'cancelled-confirmed' || state === 'cancelled-before-dispatch') && next.receiptRef && previous.originalRef === receipt.operationId)
      journal.reconcile(operation.operationId, {...next, receiptRef: next.receiptRef})
    else journal.transition(operation.operationId, next)
  })
  await mirrorManagedParent(operation)
}

/** A child owns the original receipt; the parent is an explicit bridge reference. */
export async function mirrorManagedParent(operation: ActiveOperation): Promise<void> {
  const parent = operation.parentOperation
  if (!parent) return
  await operation.database(db => {
    const journal = new ManagedOperationJournal(db), child = journal.readOperation(operation.operationId)
    if (journal.readScope(child.scopeId).parentId !== parent.operationId) throw new Error('Managed parent linkage mismatch')
    const previous = journal.readOperation(parent.operationId)
    if (['completed','cancelled-confirmed','denied','cancelled-before-dispatch'].includes(previous.state)) return
    if (child.state === 'prepared' || child.state === 'dispatching') return
    const next = {state:child.state,...(child.outcome?{outcome:child.outcome}:{}),
      receiptRef:child.receiptRef ?? canonicalContentHash({childOperation:child.operationId,state:child.state}),...(child.cause?{cause:child.cause}:{})}
    if (previous.state === 'unknown' && ['completed','cancelled-confirmed','denied','cancelled-before-dispatch'].includes(child.state)) journal.reconcile(parent.operationId,next)
    else if (previous.state !== 'unknown' || child.state === 'unknown') journal.transition(parent.operationId,next)
  })
}

/** No authority is granted here. Existing permission checks remain inside dispatch. */
export async function runManagedOperation<T>(scope: ManagedScope, input: { route: 'native' | 'owned'; kind: 'process' | 'file'; request: unknown; originalRef?: string }, dispatch: () => Promise<T>): Promise<T> {
  // Owned adapters reached from an already journaled bridge share the same ID.
  if (active.getStore() && !scope.nested) return dispatch()
  const operation = await scope.database(db => {
    const journal = new ManagedOperationJournal(db), owner = journal.readScope(scope.scopeId)
    const unresolvedNative = db.prepare(`SELECT 1 FROM dsh_managed_operations o JOIN dsh_managed_scopes s ON s.scope_id=o.scope_id
      WHERE json_extract(s.scope_json,'$.sessionId')=? AND json_extract(o.operation_json,'$.route')='native'
      AND o.state='unknown' LIMIT 1`).get(owner.sessionId)
    if (unresolvedNative) { journal.markIncomplete(scope.scopeId); throw new Error('Managed native operation requires reconciliation before another effect') }
    return journal.prepare(scope.scopeId, input)
  })
  if (!await scope.database(db => new ManagedOperationJournal(db).claim(operation.operationId))) throw new Error('Managed operation already dispatched')
  const context = { ...scope, operationId: operation.operationId, kind: input.kind }
  return active.run(context, async () => {
    let value: T
    try { value = await dispatch() }
    catch (error) {
      // Only a host-tagged pre-dispatch denial proves absence of effects.
      const denied = isManagedAdmissionDenied(error)
      await scope.database(db => {
        const journal = new ManagedOperationJournal(db)
        if (!['completed','denied','cancelled-before-dispatch','cancelled-confirmed'].includes(journal.readOperation(operation.operationId).state)) journal.transition(operation.operationId, { state: denied ? 'denied' : 'unknown' })
        journal.setDelivery(operation.operationId, 'not-delivered')
      })
      throw error
    }
    await observeManagedResult(context, value)
    await scope.database(db => { const journal = new ManagedOperationJournal(db); if (journal.readOperation(operation.operationId).state === 'dispatching') journal.transition(operation.operationId, {state:'unknown'}) })
    // This denotes the host adapter return, not semantic consumption by Lisp.
    await scope.database(db => new ManagedOperationJournal(db).setDelivery(operation.operationId, 'delivered'))
    return value
  })
}
export class ManagedDispatchDenied extends Error {}
