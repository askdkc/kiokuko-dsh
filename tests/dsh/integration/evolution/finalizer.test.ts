import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, createRun, draft, NOW } from './fixture.js'
import { DshMemoryFinalizer, reduceDshFinalizationLog, type DshLogEvent } from '../../../../src/dsh/session-memory-finalizer.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { MemoryEvolutionConfig } from '../../../../src/memory/evolution/contracts.js'

// Exact reviewed saves (including failed attempts) are covered by
// ../replay-memory-review.test.ts; legacy finalization never writes new memory.
function log(passed: boolean): DshLogEvent[] {
  const result=(seq:number,callId:string,exitCode:number):DshLogEvent=>({seq,time:seq,type:'tool/result',data:{exitCode,message:{role:'user',source:{kind:'tool',callId},content:[{type:'text',text:exitCode===0?'Migration test completed':'SQLITE_BUSY'}]}}})
  return [
    {seq:1,time:1,type:'turn/start',data:{turn:1}},
    {seq:2,time:2,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'SQLITE_BUSY sqlite migration 3.46'}]}},
    {seq:3,time:3,type:'request/header',data:{header:{config:{provider:'p',model:'m'}}}},
    {seq:4,time:4,type:'request/context',data:{contextWindow:100000}},
    {seq:5,time:5,type:'tool/call',data:{callId:'bad',name:'Shell',arguments:'migration'}},result(6,'bad',1),
    {seq:7,time:7,type:'tool/call',data:{callId:'retry',name:'Shell',arguments:draft().procedure}},result(8,'retry',passed?0:1),
    {seq:9,time:9,type:'turn/end',data:{turn:1,reason:{kind:passed?'completed':'failed'}}},
  ]
}

for(const outcome of ['completed','failed'] as const)test(`${outcome} native outcome is preserved without automatic finalization or evolution`,async()=>{
 const f=fixture();createRun(f.db,'native');let calls=0,reads=0,finalized=0
 const finalizer=new DshMemoryFinalizer({runtime:f.runtime,now:()=>NOW,onFinalized(){finalized++},
  sessionQuery:{async readSession(){reads++;return {session:{id:'session-native'},inheritedEventCount:0,events:log(outcome==='completed')}}},
  llm:{async *stream(){calls++;yield {type:'finish',reason:{kind:'stop'}}}}})
 try{
  await finalizer.start()
  withImmediateTransaction(f.db,()=>{f.db.prepare('UPDATE ledger_runs SET status=?').run(outcome);finalizer.scheduleInTransaction(f.db,{runId:'native',workspace:'project:test',dshSessionId:'session-native',sourceEndSeq:9})})
  finalizer.kick();await finalizer.whenIdle()
  assert.equal(calls,0);assert.equal(reads,0);assert.equal(finalized,0)
  for(const table of ['entries','memory_episodes','dsh_memory_finalization_entries','dsh_memory_finalizations'])assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,0)
  assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get()?.status,outcome)
 }finally{await finalizer.dispose();f.db.close()}
})
for(const mode of ['active','observe','off'] as const)test(`${mode} startup leaves historical v2 jobs unchanged and makes no extraction request`,async()=>{
 const f=fixture();createRun(f.db,'historical');let calls=0
 f.db.prepare("UPDATE ledger_runs SET status='completed'").run()
 f.db.prepare("INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,extraction_version) VALUES('historical','project:test','session-historical',1,9,'pending',0,?,?,2)").run(NOW,NOW)
 const before=f.db.prepare('SELECT * FROM dsh_memory_finalizations').get()
 const finalizer=new DshMemoryFinalizer({runtime:f.runtime,memoryEvolution:MemoryEvolutionConfig.parse({mode}),llm:{async *stream(){calls++;throw new Error('unapproved extraction')}}})
 try{
  await finalizer.start();finalizer.kick();await finalizer.whenIdle()
  assert.equal(calls,0);assert.deepEqual(f.db.prepare('SELECT * FROM dsh_memory_finalizations').get(),before)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()?.n,0)
 }finally{await finalizer.dispose();f.db.close()}
})
test('native evidence excludes recalled tool output and unbound tool results', async () => {
  const events=log(true)
  events[4]={...events[4]!,data:{callId:'bad',name:'memory_search',arguments:'old experience'}}
  events[6]={...events[6]!,data:{callId:'different',name:'Shell',arguments:'read'}}
  async function* stream(){yield*events}
  const reduced=await reduceDshFinalizationLog(stream(),1,9)
  assert.ok(!reduced.episodeEvidence!.some(e=>[5,6,8].includes(e.seq)))
  await assert.rejects(reduceDshFinalizationLog(stream(),1,10),/end|boundary|range/)
})
