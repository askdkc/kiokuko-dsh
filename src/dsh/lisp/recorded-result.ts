import { LispError, type LispOwner } from './contracts.js'
import type { LispStore, Operation } from './store.js'

/** Recover interrupted parent evidence from durable per-file receipts, never by
 * guessing from current file contents or replaying the original evaluation. */
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function storedObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!object(value)) throw new LispError('JOURNAL_INTEGRITY', '保存結果の形式が不正です。再実行せず記録を確認してください。')
  return value
}
export async function recordedResult(store: LispStore, owner: LispOwner, operation: Operation): Promise<Record<string, unknown> | null> {
  const saved = operation.result ? storedObject(operation.result) : null
  if (!saved || operation.kind !== 'lisp_eval' || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.state)) return saved
  const receipts = await store.proposalReceipts(owner, operation.operation_id)
  if (!receipts.length && !Array.isArray(saved.proposals)) return saved
  const known = new Map<string, Record<string, unknown>>()
  const policy = storedObject(operation.payload).policyVersion
  const linkedReceiptsRequired = typeof policy === 'number' && policy >= 2
  for (const change of Array.isArray(saved.changes) ? saved.changes : []) {
    if (!object(change) || typeof change.path !== 'string') throw new LispError('JOURNAL_INTEGRITY', '変更結果の対象が不正です。')
    known.set(change.path, change)
  }
  for (const receipt of receipts) {
    const result = receipt.result ? storedObject(receipt.result) : {}
    const state = ['APPLIED', 'NOT_APPLIED'].includes(receipt.state) ? receipt.state : 'UNKNOWN'
    known.set(receipt.path, { ...result, id: receipt.id, path: receipt.path, state,
      ...(receipt.state === 'ABANDONED' ? { resolution: 'ABANDONED' } : {}) })
  }
  for (const proposal of Array.isArray(saved.proposals) ? saved.proposals : []) {
    if (!object(proposal) || typeof proposal.path !== 'string') throw new LispError('JOURNAL_INTEGRITY', '変更提案の対象が不正です。')
    if (!known.has(proposal.path)) known.set(proposal.path, {
      id: operation.operation_id, path: proposal.path, state: linkedReceiptsRequired ? 'NOT_APPLIED' : 'UNKNOWN',
      reason: linkedReceiptsRequired ? 'interrupted_before_application' : 'legacy_receipt_unavailable',
    })
  }
  return { ...saved, ok: false, state: operation.state, changes: [...known.values()] }
}
