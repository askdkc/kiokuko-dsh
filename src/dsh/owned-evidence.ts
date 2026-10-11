import type { SqliteDatabase } from '../db/adapter.js'
import { applicationSourceDigest } from '../memory/application.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { ReviewEvidence } from '../memory/review/contracts.js'
import type { ExecutionReceipt } from './owned-execution.js'

export function ownedRunEvidence(db:SqliteDatabase,runId:string,sessionId:string):ExecutionReceipt[] {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_owned_operations'").get())return []
  return db.prepare('SELECT operation_id,generation,receipt_json FROM dsh_owned_operations WHERE run_id=? AND session_id=? ORDER BY rowid DESC LIMIT 256')
    .all<{operation_id:string;generation:string;receipt_json:string}>(runId,sessionId).reverse().flatMap(row=>{
      const receipt=JSON.parse(row.receipt_json) as ExecutionReceipt
      return receipt.runId===runId&&receipt.sessionId===sessionId&&receipt.operationId===row.operation_id&&receipt.generation===row.generation?[receipt]:[]
    })
}
/** Delivery is bounded; durable receipt rows are never discarded or shortened. */
export function boundedOwnedEvidence(receipts:ExecutionReceipt[],maxBytes=64*1024) {
  const items:ExecutionReceipt[]=[];let bytes=0
  for(const receipt of [...receipts].reverse()) {
    const size=Buffer.byteLength(JSON.stringify(receipt))
    if(bytes+size>maxBytes)continue
    bytes+=size;items.unshift(receipt)
  }
  return {items,omitted:receipts.length-items.length}
}
export function ownedReviewEvidence(receipts:ExecutionReceipt[],events:readonly {seq:number;type:string;data?:unknown}[]):ReviewEvidence[] {
  return receipts.flatMap(receipt=>{
    const event=events.find(event=>event.type==='tool/result'&&JSON.stringify(event.data).includes(receipt.operationId))
    if(!event)return []
    const text=JSON.stringify({hostObserved:true,receipt,semanticLessonVerified:false})
    const basis={role:'tool_observation' as const,sourceSeqs:[event.seq],text}
    return [{id:receipt.evidenceRef,...basis,normalizedSourceHash:canonicalContentHash(basis),eligibleForNewMemory:receipt.state==='completed'}]
  })
}
export function linkOwnedMemoryEvidence(db:SqliteDatabase,entry:{id:string;revision:number},receipts:ExecutionReceipt[],ids:readonly string[],owner:{runId:string;sessionId:string;workspace:string}):void {
  const revision=db.prepare('SELECT 1 FROM entry_revisions WHERE entry_id=? AND revision=? AND workspace=?').get(entry.id,entry.revision,owner.workspace)
  if(!revision)throw new Error('Owned memory evidence entry scope mismatch')
  for(const id of ids.filter(id=>id.startsWith('owned:'))) {
    const receipt=receipts.find(receipt=>receipt.evidenceRef===id)
    if(!receipt || receipt.runId!==owner.runId || receipt.sessionId!==owner.sessionId)throw new Error('Owned memory evidence is missing or belongs to another run')
    const observed=db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=? AND run_id=? AND session_id=?').get<{receipt_json:string}>(receipt.operationId,owner.runId,owner.sessionId)
    if(!observed||canonicalContentHash(JSON.parse(observed.receipt_json))!==canonicalContentHash(receipt))throw new Error('Owned memory evidence differs from stored host observation')
    db.prepare('INSERT OR IGNORE INTO memory_execution_links VALUES(?,?,?)').run(entry.id,entry.revision,receipt.operationId)
  }
}
export function memoryExecutionEvidence(db:SqliteDatabase,entryId:string,revision:number) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_execution_links'").get())return []
  return db.prepare(`SELECT o.receipt_json FROM memory_execution_links l JOIN dsh_owned_operations o ON o.operation_id=l.operation_id
    WHERE l.entry_id=? AND l.revision=?`).all<{receipt_json:string}>(entryId,revision).map(row=>{
      const receipt=JSON.parse(row.receipt_json) as ExecutionReceipt
      const checks=(receipt.checks??[]).map(check=>{
        const observed=db.prepare('SELECT outcome FROM dsh_completion_executions WHERE run_id=? AND call_id=?').get<{outcome:string}>(receipt.runId,receipt.operationId)
        let current:string|undefined
        try{current=applicationSourceDigest(receipt.repositoryRoot,check.sourcePaths)}catch{/* missing sources remain unknown */}
        return {...check,state:current===undefined?'unknown':current!==check.sourceDigest?'stale':observed?.outcome??check.outcome}
      })
      return {evidenceRef:receipt.evidenceRef,runId:receipt.runId,sessionId:receipt.sessionId,generation:receipt.generation,
        repositoryRoot:receipt.repositoryRoot,cwd:receipt.cwd,command:receipt.command,targets:receipt.targets,checks,
        state:receipt.state,verification:receipt.verification,currentTaskVerification:false,semanticLessonVerified:false}
    })
}
