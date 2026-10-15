/** Real owned-process receipts -> actual replay payload -> exact human review -> atomic memory index. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { AgenticReplayConfig } from '../../../src/dsh/config.js'
import { DshAgenticReplayStore } from '../../../src/dsh/agenticreplay-store.js'
import { DshAgenticReplayRecorder } from '../../../src/dsh/agenticreplay-recorder.js'
import { DshAgenticReplayReadService } from '../../../src/dsh/agenticreplay-read-service.js'
import { reviewCompletedReplay, type ReplayMemoryProposal } from '../../../src/memory/replay-review.js'
import { createApprovedReplayMemoryStore } from '../../../src/memory/replay-store.js'
import { recordEntryInTransaction, readEntry } from '../../../src/memory/entries.js'
import { ownedRunEvidence, linkOwnedMemoryEvidence } from '../../../src/dsh/owned-evidence.js'

export async function approvedOwnedMemory(f:{root:string;readonly db:SqliteDatabase;identity:{runId:string;sessionId:string;workspace:string};restart?():Promise<void>}, result:any, failStorage=false) {
 const config=AgenticReplayConfig.parse({enabled:true,askOnStart:false,shutdownDrainTimeoutMs:3000})
 const withIndex=async<T>(operation:(store:DshAgenticReplayStore)=>T|PromiseLike<T>)=>operation(new DshAgenticReplayStore(f.db))
 const binding={sessionId:f.identity.sessionId,workspaceRoot:f.root,sessionCwd:f.root,storeRoot:join(f.root,'.agenticreplay'),kiokukoRunId:f.identity.runId}
 const recorder=new DshAgenticReplayRecorder(config,withIndex),reader=new DshAgenticReplayReadService(config,withIndex)
 let entryId='',extractions=0,questions=0
 try {
  const call={token:Symbol(),callId:result.receipt.operationId,rootCallId:result.receipt.operationId,name:'kioku_exec',arguments:{command:result.receipt.command}}
  recorder.preTool(binding,call)
  recorder.toolResult(binding,call,{isError:false,value:{...result,processStarted:result.receipt.processStarted,processStopped:result.receipt.processStopped},content:[{type:'text',text:JSON.stringify(result)}]})
  await recorder.closeSessionRecording(binding.sessionId,'manual')
  const traces=await reader.list(binding);assert.equal(traces.length,1)
  const originalCount=f.db.prepare('SELECT count(*) n FROM dsh_owned_operations').get<any>()!.n
  const request=f.db.prepare('SELECT title FROM ledger_runs WHERE run_id=?').get<any>(f.identity.runId)!.title
  const proposal=await reader.memoryEvidence(binding,traces[0]!.agenticreplay_run_id,{workspace:f.identity.workspace,taskId:f.identity.runId,request:{text:request,evidenceRefs:[`ledger:${f.identity.runId}:title`]}})
  assert.ok(proposal.attempts.some(a=>a.command===result.receipt.command&&a.outcome==='succeeded'))
  f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.identity.runId)
  if(failStorage)f.db.exec("CREATE TRIGGER owned_save_failure BEFORE INSERT ON memory_execution_links BEGIN SELECT RAISE(ABORT,'injected memory persistence failure'); END")
  const attempt=async()=>{
   let shown:ReplayMemoryProposal|undefined
   const store=createApprovedReplayMemoryStore(f.db,f.identity.workspace,p=>{
    assert.deepEqual(p,shown,'only the exact displayed human-approved revision can be indexed')
    const entry=recordEntryInTransaction(f.db,{workspace:f.identity.workspace,kind:'lesson',title:'Parser verification condition',body:JSON.stringify(p),summary:'Observed parser checks; current sources require fresh verification.',createdBy:'human-reviewed-test',trustLevel:'untrusted',provenance:{type:'user_approved_replay',reference:p.proposalId,runId:f.identity.runId}})
    linkOwnedMemoryEvidence(f.db,entry,ownedRunEvidence(f.db,f.identity.runId,f.identity.sessionId),[result.receipt.evidenceRef],f.identity)
    entryId=entry.id;return entry
   })
   const receipt=await reviewCompletedReplay({completed:true,taskId:f.identity.runId,sessionId:f.identity.sessionId,workspace:f.identity.workspace,extract:async()=>{extractions++;return structuredClone(proposal)},ask:async q=>{
    questions++
    if(q.phase==='organize')return {questionId:q.id,choice:'organize'}
    const begin=q.text.indexOf('\n{')+1,end=q.text.lastIndexOf('\nApprove,')
    shown=JSON.parse(q.text.slice(begin,end));assert.ok(shown!.attempts.length)
    return {questionId:q.id,choice:'approve'}
   },save:async(p,key)=>store.save(p,key)})
   if(receipt.status==='saved'){store.save(shown!,receipt.approvalKey!);assert.equal(store.query('Parser').length,1)}
   return receipt
  }
  let receipt=await attempt()
  if(failStorage){
   assert.equal(receipt.status,'unavailable');assert.equal(f.db.prepare('SELECT count(*) n FROM entries').get<any>()!.n,0,'failed atomic save leaves no partial memory')
   assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get()?f.db.prepare('SELECT count(*) n FROM replay_memories').get<any>()!.n:0,0)
   f.db.exec('DROP TRIGGER owned_save_failure');await f.restart?.();receipt=await attempt()
  }
  assert.equal(receipt.status,'saved');assert.equal(questions,failStorage?4:2);assert.equal(extractions,failStorage?2:1)
  assert.equal(f.db.prepare('SELECT count(*) n FROM dsh_owned_operations').get<any>()!.n,originalCount,'save retry never replays process effects')
  assert.equal(f.db.prepare('SELECT count(*) n FROM entries').get<any>()!.n,1)
  return readEntry(f.db,{workspace:f.identity.workspace,entryId})
 }finally{await recorder.shutdown()}
}
