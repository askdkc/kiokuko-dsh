import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture,createRun,NOW } from '../../integration/evolution/fixture.js'
import { adoptMemories,memorySnapshots,REVIEW_ACTOR } from '../../../../src/memory/review/adoption.js'
import { readEntry,recordEntry,updateCandidateEntryInTransaction } from '../../../../src/memory/entries.js'
import { canonicalContentHash } from '../../../../src/serialization/validate.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { capturePolicy,excludeCapture } from '../../../../src/memory/capture-policy.js'
const range={workspace:'project:test',sessionId:'session-adopt',runId:'adopt',sourceGeneration:'generation',startSeq:1,endSeq:4}
const evidence=[{id:'e:1',role:'user_assertion' as const,sourceSeqs:[2],normalizedSourceHash:canonicalContentHash('user'),text:'Project version 2',eligibleForNewMemory:true}]
// Positive save/revision coverage: integration/replay-memory-review.test.ts,
// "actual lifecycle questions save exact approved revision once" and "comments require a fresh preview".
test('legacy adoption cannot add, deduplicate, update or save an effect without exact native approval',()=>{
 const f=fixture();createRun(f.db,'adopt')
 const apply=(id:string,operations:any[],existing=memorySnapshots(f.db,range,'Project version').existing)=>withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id,range,evidence,existing,operations,observe:false,now:NOW}))
 try{
  const add={action:'add',kind:'fact',title:'Version',body:'Project version 1',evidenceIds:['e:1']}
  assert.deepEqual(apply('one',[add]),{added:0,updated:0,unchanged:0,held:1,entries:[]})
  assert.equal(apply('duplicate',[add]).held,1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  const entry=recordEntry(f.db,{workspace:range.workspace,kind:'fact',title:'Version',body:'Project version 1',createdBy:REVIEW_ACTOR})
  const snapshot=memorySnapshots(f.db,range,'Project version').existing
  assert.equal(snapshot[0]?.editable,true,'historical snapshots remain readable')
  const update={action:'update',kind:'fact',targetEntryId:entry.id,expectedRevision:1,expectedContentHash:entry.contentHash,title:'Version',body:'Project version 2',evidenceIds:['e:1']}
  assert.equal(apply('two',[update],snapshot).held,1)
  assert.equal(readEntry(f.db,{workspace:range.workspace,entryId:entry.id}).revision,1)
  withImmediateTransaction(f.db,()=>updateCandidateEntryInTransaction(f.db,{workspace:range.workspace,entryId:entry.id,expectedRevision:1,kind:'fact',title:'Version',body:'Human reviewed version 2',scope:entry.scope,createdBy:'kiokuko-web'}))
  assert.equal(memorySnapshots(f.db,range,'Project version').existing[0]?.editable,false)
  assert.equal(apply('stale',[update],snapshot).held,1)
  assert.equal(readEntry(f.db,{workspace:range.workspace,entryId:entry.id}).body,'Human reviewed version 2')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_review_effects').get()?.n,0)
 }finally{f.db.close()}
})
test('unknown evidence and a non-offered target cannot write memory or a durable proposal',()=>{
 const f=fixture();createRun(f.db,'adopt')
 try{
  const add={action:'add' as const,kind:'fact' as const,title:'Unproven',body:'Done',evidenceIds:['assistant-only']}
  const before=f.db.prepare('SELECT total_changes() AS n').get()?.n
  const result=withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id:'invalid',range,evidence,existing:[],operations:[add,{...add,action:'update',targetEntryId:'foreign',expectedRevision:1,expectedContentHash:'a'.repeat(64),evidenceIds:['e:1']}],observe:false,now:NOW}))
  assert.equal(result.held,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.n,before)
 }finally{f.db.close()}
})
test('T37: exclusions persist and cannot be undone by status or repeated held detection',()=>{
 const f=fixture();createRun(f.db,'adopt')
 try{
  withImmediateTransaction(f.db,()=>excludeCapture(f.db,range.workspace,range.sessionId,'excluded','capture_excluded',NOW))
  withImmediateTransaction(f.db,()=>excludeCapture(f.db,range.workspace,range.sessionId,'held','capture_refusal_detected',NOW))
  assert.equal(capturePolicy(f.db,range.workspace,range.sessionId).mode,'excluded')
  assert.equal(capturePolicy(f.db,range.workspace,range.sessionId).revision,2)
 }finally{f.db.close()}
})
test('historical retired candidates cannot be recreated from old legacy evidence',()=>{
 const f=fixture();createRun(f.db,'adopt')
 const operation={action:'add' as const,kind:'fact' as const,title:'Version',body:'Project version 2',evidenceIds:['e:1']}
 try{
  const first=recordEntry(f.db,{workspace:range.workspace,kind:'fact',title:operation.title,body:operation.body,createdBy:REVIEW_ACTOR})
  f.db.prepare("UPDATE entries SET status='superseded',superseded_by=id WHERE id=?").run(first.id)
  const before=f.db.prepare('SELECT total_changes() AS n').get()?.n
  const late=withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id:'late',range,evidence,existing:[],operations:[operation],observe:false,now:NOW}))
  assert.equal(late.held,1);assert.equal(late.added,0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.n,before)
 }finally{f.db.close()}
})
