import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { ExecutionReceipt } from './owned-execution.js'
import { authorizeTaskLease, recordTaskEvidence, type TaskSnapshot } from './task-state.js'

function receiptDigest(receipt:ExecutionReceipt):string {
  const {persistence:_p,persistenceError:_error,...observation}=receipt
  return canonicalContentHash(observation as any)
}
function successful(receipt:ExecutionReceipt):boolean {
  if(receipt.state!=='completed'||receipt.authority!=='current'||receipt.error||!receipt.taskAuthority)return false
  if(receipt.kind==='kioku_exec')return receipt.processStarted===true&&receipt.exitCode===0&&receipt.signal===null
    &&receipt.cancelled===false&&receipt.timedOut===false&&receipt.outputComplete===true&&typeof receipt.outputDigest==='string'
  return ['kioku_read','kioku_write','kioku_edit','kioku_remove'].includes(receipt.kind)
    &&receipt.verification==='passed'&&receipt.targets.length===1
}
/** Called only from the host's actual completed operation, never from result
 * paging, a journal replay, model JSON, or an imported receipt. This records
 * observation provenance, not a Goal-completion verdict. */
export function recordOwnedCompletionObservation(db:SqliteDatabase,receipt:ExecutionReceipt):void {
  if(!successful(receipt))return
  authorizeTaskLease(db,receipt.taskAuthority!)
  const stored=db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND run_id=? AND session_id=? AND state=\'completed\'')
    .get<{receipt_json:string}>(receipt.operationId,receipt.runId,receipt.sessionId)
  if(!stored||receiptDigest(JSON.parse(stored.receipt_json))!==receiptDigest(receipt))return
  recordTaskEvidence(db,receipt.taskAuthority!,{ref:`observation:${receipt.evidenceRef}`,kind:'verification',generation:receipt.taskAuthority!.generation,verified:false,
    details:{source:'owned-execution',receiptDigest:receiptDigest(receipt)}})
}
/** Resolve only explicitly referenced successful observations for the exact
 * current task lease. The caller must still enforce required Goal criteria. */
export function observedTaskCompletionEvidence(db:SqliteDatabase,task:TaskSnapshot,refs:readonly string[]):string[] {
  return [...new Set(refs)].filter(ref=>{
    if(!/^owned:[a-f0-9]{64}$/u.test(ref))return false
    try {
      const row=db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND run_id=? AND state=\'completed\'')
        .get<{receipt_json:string}>(ref.slice(6),task.taskId)
      if(!row)return false
      const receipt=JSON.parse(row.receipt_json) as ExecutionReceipt,lease=receipt.taskAuthority
      if(!successful(receipt)||receipt.evidenceRef!==ref||receipt.runId!==task.taskId||receipt.repositoryRoot!==task.repositoryRoot
        ||!lease||lease.taskId!==task.taskId||lease.sessionId!==task.sessionId||lease.repositoryRoot!==task.repositoryRoot
        ||lease.revision!==task.revision||lease.generation!==task.generation)return false
      authorizeTaskLease(db,lease)
      const proof=db.prepare("SELECT details_json FROM ledger_task_evidence WHERE run_id=? AND evidence_ref=? AND generation=? AND kind='verification' AND verified=0")
        .get<{details_json:string}>(task.taskId,`observation:${ref}`,task.generation)
      if(!proof)return false
      const details=JSON.parse(proof.details_json)
      return details.source==='owned-execution'&&details.receiptDigest===receiptDigest(receipt)
    }catch{return false}
  })
}
