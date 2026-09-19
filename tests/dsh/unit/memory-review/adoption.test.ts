import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture,createRun,NOW } from '../../integration/evolution/fixture.js'
import { adoptMemories,memorySnapshots } from '../../../../src/memory/review/adoption.js'
import { readEntry,updateCandidateEntryInTransaction } from '../../../../src/memory/entries.js'
import { canonicalContentHash } from '../../../../src/serialization/validate.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { capturePolicy,excludeCapture } from '../../../../src/memory/capture-policy.js'
const range={workspace:'project:test',sessionId:'session-adopt',runId:'adopt',sourceGeneration:'generation',startSeq:1,endSeq:4}
const evidence=[{id:'e:1',role:'user_assertion' as const,sourceSeqs:[2],normalizedSourceHash:canonicalContentHash('user'),text:'Project version 2',eligibleForNewMemory:true}]
test('T04/T05/T14/T24: deduplicate content, update the same owned candidate, then protect human revisions',()=>{
 const f=fixture();createRun(f.db,'adopt')
 const apply=(id:string,operations:any[],existing=memorySnapshots(f.db,range,'Project version').existing)=>withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id,range,evidence,existing,operations,observe:false,now:NOW}))
 try{
  const add={action:'add',kind:'fact',title:'Version',body:'Project version 1',evidenceIds:['e:1']}
  const first=apply('one',[add]);assert.equal(first.added,1)
  assert.equal(apply('duplicate',[{...add,title:'Same fact'}]).unchanged,1)
  const entry=first.entries[0]!
  const update={action:'update',kind:'fact',targetEntryId:entry.id,expectedRevision:1,expectedContentHash:entry.contentHash,title:'Version',body:'Project version 2',evidenceIds:['e:1']}
  assert.equal(apply('two',[update]).updated,1)
  const current=readEntry(f.db,{workspace:range.workspace,entryId:entry.id});assert.equal(current.revision,2)
  const snapshot=memorySnapshots(f.db,range,'Project version').existing
  withImmediateTransaction(f.db,()=>updateCandidateEntryInTransaction(f.db,{workspace:range.workspace,entryId:entry.id,expectedRevision:2,kind:'fact',title:'Version',body:'Human reviewed version 3',scope:current.scope,createdBy:'kiokuko-web'}))
  assert.equal(apply('stale',[{...update,expectedRevision:2,expectedContentHash:current.contentHash}],snapshot).held,1)
  assert.equal(apply('human',[{...update,expectedRevision:3,expectedContentHash:readEntry(f.db,{workspace:range.workspace,entryId:entry.id}).contentHash}]).held,1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
 }finally{f.db.close()}
})
test('unknown evidence and a non-offered target cannot write memory',()=>{
 const f=fixture();createRun(f.db,'adopt')
 try{
  const add={action:'add' as const,kind:'fact' as const,title:'Unproven',body:'Done',evidenceIds:['assistant-only']}
  const result=withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id:'invalid',range,evidence,existing:[],operations:[add,{...add,action:'update',targetEntryId:'foreign',expectedRevision:1,expectedContentHash:'a'.repeat(64),evidenceIds:['e:1']}],observe:false,now:NOW}))
  assert.equal(result.held,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
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

test('retired candidates cannot be recreated from their old evidence',()=>{
 const f=fixture();createRun(f.db,'adopt')
 const operation={action:'add' as const,kind:'fact' as const,title:'Version',body:'Project version 2',evidenceIds:['e:1']}
 const apply=(id:string)=>withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id,range,evidence,existing:[],operations:[operation],observe:false,now:NOW}))
 try{
  const first=apply('first');f.db.prepare("UPDATE entries SET status='superseded',superseded_by=id WHERE id=?").run(first.entries[0]!.id)
  const late=apply('late');assert.equal(late.held,1);assert.equal(late.added,0)
  assert.equal(f.db.prepare("SELECT reason FROM memory_review_effects WHERE job_id='late'").get()?.reason,'source_retired')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
 }finally{f.db.close()}
})
