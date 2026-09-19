import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, createRun, NOW } from '../evolution/fixture.js'
import { DshSessionLogMirror } from '../../../../src/dsh/session-log-mirror.js'
import { AutoMemoryReviewCoordinator } from '../../../../src/dsh/auto-memory-review.js'
import { MemoryReviewConfig } from '../../../../src/memory/review/contracts.js'
import { configureReview, reviewSettings, handoffReview } from '../../../../src/memory/review/store.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { DshMemoryFinalizer, type DshLogEvent, type DshLlm } from '../../../../src/dsh/session-memory-finalizer.js'
import { readEntry, updateCandidateEntryInTransaction } from '../../../../src/memory/entries.js'
import { excludeCapture } from '../../../../src/memory/capture-policy.js'

async function setup(options: {mode?:'active'|'observe'|'off'; llm?:DshLlm; timeoutMs?:number;dailyCalls?:number}={}) {
  const f=fixture();createRun(f.db,'review')
  const events:DshLogEvent[]=[{type:'session/start',seq:0,time:0,data:{}}]
  const session={id:'session-review',header:{},get seq(){return events.length},eventAt:(seq:number)=>events[seq]}
  const mirror=new DshSessionLogMirror({runtime:f.runtime,databasePath:':memory:',now:()=>NOW})
  await mirror.start();await mirror.observe(session.id,events[0]!)
  let calls=0
  const llm=options.llm??{async *stream(request){calls++;assert.deepEqual(request.tools,[]);const payload=JSON.parse((request.messages[0] as {content:{text:string}[]}).content[0]!.text)
    yield {type:'text-delta',text:JSON.stringify({schemaVersion:1,proposals:[{action:'add',kind:'preference',title:'Answer language',body:'このプロジェクトの回答は日本語を使う。',evidenceIds:[payload.evidence[0].id]}]})}
    yield {type:'finish',reason:{kind:'stop'},usage:{inputTokens:100,outputTokens:50}}
  }}
  const config=MemoryReviewConfig.parse({...(options.mode?{mode:options.mode}:{}),...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{}),...(options.dailyCalls?{dailyCalls:options.dailyCalls}:{})})
  let flushed=-1
  const coordinator=new AutoMemoryReviewCoordinator({runtime:f.runtime,mirror,llm,config,now:()=>NOW,flush:async s=>{assert.equal(s,session);flushed=events.length-1;return true}})
  await coordinator.bind({workspace:'project:test',runId:'review',session,startSeq:1})
  const binding={workspace:'project:test',runId:'review',session,startSeq:1}
  let turn=0
  async function add(human=true,text='このプロジェクトの回答は日本語を使う。'){
    turn++
    const append=(type:string,data:unknown)=>events.push({type,data,seq:events.length,time:events.length})
    append('turn/start',{turn});append('user/message',{id:`input-${turn}`,role:'user',source:{kind:human?'user':'plugin'},content:[{type:'text',text}]})
    append('request/header',{header:{config:{provider:'fixture',model:'fixed'}}});append('request/context',{contextWindow:100000});append('turn/end',{turn,reason:{kind:'completed'}})
    const end=events.length-1
    coordinator.notify(binding,end);await coordinator.whenIdle();return end
  }
  return {...f,events,session,mirror,coordinator,binding,add,calls:()=>calls,flushed:()=>flushed,llm,config,async close(){await coordinator.dispose();await mirror.close();f.db.close()}}
}
test('T01/T02/T03: eight human turns save without closing the run; internal turns do not count; duplicate hints do not resend',async()=>{
  const f=await setup()
  try{
    for(let i=0;i<8;i++)await f.add(false)
    for(let i=0;i<7;i++)await f.add()
    assert.equal(f.calls(),0)
    const end=await f.add();assert.equal(f.calls(),1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
    assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get()?.status,'active')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get()?.n,0)
    f.coordinator.notify(f.binding,end);await f.coordinator.whenIdle();assert.equal(f.calls(),1)
    assert.equal(f.db.prepare('SELECT reviewed_through_seq FROM memory_review_states').get()?.reviewed_through_seq,end)
    const entry=f.db.prepare('SELECT id FROM entries').get<{id:string}>()!
    assert.equal(readEntry(f.db,{workspace:'project:test',entryId:entry.id}).trustLevel,'user_asserted')
  }finally{await f.close()}
})
test('T09: restart after three turns retains the admission and turn count',async()=>{
  const f=await setup();let second:AutoMemoryReviewCoordinator|undefined
  try{
    for(let i=0;i<3;i++)await f.add()
    await f.coordinator.dispose()
    second=new AutoMemoryReviewCoordinator({runtime:f.runtime,mirror:f.mirror,llm:f.llm,config:f.config,now:()=>NOW,flush:async()=>true})
    await second.bind({...f.binding,startSeq:f.events.length})
    // Append with the stopped coordinator, then recover from one native end hint.
    for(let i=0;i<5;i++)await f.add()
    second.notify(f.binding,f.events.length-1);await second.whenIdle()
    assert.equal(f.calls(),1)
  }finally{await second?.dispose();await f.close()}
})
test('T30/T36: persisted capture exclusion blocks review and legacy finalizer dispatch',async()=>{
  const f=await setup()
  try{
    await f.coordinator.exclude('project:test',f.session.id)
    for(let i=0;i<8;i++)await f.add()
    assert.equal(f.calls(),0)
    const finalizer=new DshMemoryFinalizer({runtime:f.runtime,llm:f.llm,sessionQuery:f.mirror,now:()=>NOW})
    withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed'").run();finalizer.scheduleInTransaction(f.db,{runId:'review',workspace:'project:test',dshSessionId:f.session.id,sourceEndSeq:f.events.length-1})})
    await finalizer.start();await finalizer.whenIdle();await finalizer.dispose()
    assert.equal(f.calls(),0)
    assert.equal(f.db.prepare('SELECT capture_admission FROM dsh_memory_finalizations').get()?.capture_admission,'excluded')
  }finally{await f.close()}
})
test('T16: a stale host cannot overwrite a newer persisted configuration on startup',async()=>{
  const f=await setup()
  try{
    const initial=reviewSettings(f.db,'project:test')!
    withImmediateTransaction(f.db,()=>configureReview(f.db,'project:test',MemoryReviewConfig.parse({mode:'off'}),NOW,initial.generation))
    await f.coordinator.bind(f.binding)
    assert.equal(reviewSettings(f.db,'project:test')!.config.mode,'off')
    await assert.rejects(f.coordinator.configure(MemoryReviewConfig.parse({mode:'active'})),/generation_conflict/)
  }finally{await f.close()}
})
test('T18/T33: timeout ignores an uncooperative stream; explicit retry has one child identity',async()=>{
  let calls=0
  const f=await setup({timeoutMs:10,llm:{async *stream(){calls++;await new Promise(()=>{});yield {}}}})
  try{
    for(let i=0;i<8;i++)await f.add()
    const job=f.db.prepare('SELECT id,state,reason FROM memory_review_jobs').get<{id:string;state:string;reason:string}>()!
    assert.equal(job.state,'held');assert.equal(job.reason,'timeout');assert.equal(calls,1)
    const first=await f.coordinator.retry('project:test',job.id)
    const second=await f.coordinator.retry('project:test',job.id)
    assert.equal(first.id,second.id)
    await f.coordinator.whenIdle();assert.equal(calls,2)
  }finally{await f.close()}
})
test('T03: empty review completes its range without creating an entry',async()=>{
  const f=await setup({llm:{async *stream(){yield {type:'text-delta',text:'{"schemaVersion":1,"proposals":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
  try{for(let i=0;i<8;i++)await f.add();assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0);assert.equal(f.db.prepare('SELECT state FROM memory_review_jobs').get()?.state,'completed')}finally{await f.close()}
})
test('observe pays for a review but changes no entries; off makes no calls',async()=>{
  for(const mode of ['observe','off'] as const){const f=await setup({mode});try{for(let i=0;i<8;i++)await f.add();assert.equal(f.calls(),mode==='observe'?1:0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)}finally{await f.close()}}
})
test('T15/T38: v3 Finalizer reconciles review entries and accepts lesson/reference with Evolution off',async()=>{
  const f=await setup();let finalizer:DshMemoryFinalizer|undefined
  try{
    for(let i=0;i<8;i++)await f.add()
    finalizer=new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:f.mirror,now:()=>NOW,memoryEvolution:{mode:'off',dailyCalls:12,maxInputBytes:32768,maxOutputTokens:2048,timeoutMs:30000},llm:{async *stream(request){
      const r=JSON.parse((request.messages.at(-1) as {content:{text:string}[]}).content[0]!.text).reconciliation
      yield {type:'text-delta',text:JSON.stringify({schemaVersion:3,memoryOperations:[{action:'unchanged',targetEntryId:r.existing[0].entryId,evidenceIds:[r.evidence[0].id]},...(['lesson','reference'] as const).map(kind=>({action:'add',kind,title:kind,body:`Project ${kind} based on direct evidence`,evidenceIds:[r.evidence[0].id]}))]})}
      yield {type:'finish',reason:{kind:'stop'}}
    }}})
    withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed'").run();finalizer!.scheduleInTransaction(f.db,{runId:'review',workspace:'project:test',dshSessionId:f.session.id,sourceEndSeq:f.events.length-1});handoffReview(f.db,'review','completed')})
    await finalizer.start();await finalizer.whenIdle()
    const state=f.db.prepare('SELECT status,last_error_code FROM dsh_memory_finalizations').get()
    assert.equal(state?.status,'completed',JSON.stringify(state))
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,3)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_episodes').get()?.n,0)
  }finally{await finalizer?.dispose();await f.close()}
})

test('boundary flush waits for four complete turns and never closes the run',async()=>{
 const f=await setup()
 try{
  for(let i=0;i<3;i++)await f.add()
  await f.coordinator.scan(f.binding,f.events.length-1,'boundary');await f.coordinator.whenIdle();assert.equal(f.calls(),0)
  await f.add();await f.coordinator.scan(f.binding,f.events.length-1,'boundary');await f.coordinator.whenIdle()
  assert.equal(f.calls(),1);assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get()?.status,'active')
 }finally{await f.close()}
})
test('an uncooperative in-flight review is aborted after exclusion and cannot save a late result',async()=>{
 let sent!:()=>void;const dispatched=new Promise<void>(r=>{sent=r});let signal:AbortSignal|undefined
 const f=await setup({llm:{async *stream(request){signal=request.signal;sent();await new Promise(()=>{});yield {}}}})
 try{
  for(let i=0;i<7;i++)await f.add()
  const pending=f.add();await dispatched
  await f.coordinator.exclude('project:test',f.session.id);await pending
  assert.equal(signal?.aborted,true);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  assert.equal(f.db.prepare('SELECT reason FROM memory_review_jobs').get()?.reason,'capture_excluded')
  const id=f.db.prepare('SELECT id FROM memory_review_jobs').get<{id:string}>()!.id
  await assert.rejects(f.coordinator.retry('project:test',id),/capture_excluded/)
 }finally{await f.close()}
})
test('terminal handoff fences an in-flight review even when the provider ignores abort',async()=>{
 let sent!:()=>void,finish!:()=>void;const dispatched=new Promise<void>(r=>{sent=r}),response=new Promise<void>(r=>{finish=r})
 const f=await setup({llm:{async *stream(request){const p=JSON.parse((request.messages[0] as {content:{text:string}[]}).content[0]!.text);sent();await response
  yield {type:'text-delta',text:JSON.stringify({schemaVersion:1,proposals:[{action:'add',kind:'fact',title:'Late',body:'Late result',evidenceIds:[p.evidence[0].id]}]})};yield {type:'finish',reason:{kind:'stop'}}
 }}})
 try{
  for(let i=0;i<7;i++)await f.add()
  const pending=f.add();await dispatched
  withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='cancelled'").run();handoffReview(f.db,'review','cancelled')})
  finish();await pending
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  assert.equal(f.db.prepare('SELECT handoff_status FROM memory_review_states').get()?.handoff_status,'no_consumer')
  assert.equal(f.db.prepare('SELECT reason FROM memory_review_jobs').get()?.reason,'run_cancelled')
 }finally{finish();await f.close()}
})
test('cold off configuration disables saved active settings; explicit mode change can re-enable',async()=>{
 const f=await setup();const second=new AutoMemoryReviewCoordinator({runtime:f.runtime,mirror:f.mirror,llm:f.llm,config:MemoryReviewConfig.parse({mode:'off'}),now:()=>NOW,flush:async()=>true})
 try{
  await second.start('project:test');assert.equal(reviewSettings(f.db,'project:test')!.config.mode,'off')
  await f.coordinator.bind(f.binding);assert.equal(reviewSettings(f.db,'project:test')!.config.mode,'off')
  await second.setMode('project:test','active');assert.equal(reviewSettings(f.db,'project:test')!.config.mode,'active')
 }finally{await second.dispose();await f.close()}
})
test('v3 Finalizer rejects evidence that changes after dispatch',async()=>{
 const f=await setup();let finalizer:DshMemoryFinalizer|undefined
 try{
  for(let i=0;i<2;i++)await f.add()
  finalizer=new DshMemoryFinalizer({runtime:f.runtime,now:()=>NOW,sessionQuery:{async readSession(){return {session:{id:f.session.id},inheritedEventCount:0,events:structuredClone(f.events)}}},llm:{async *stream(){
   const index=f.events.findIndex(e=>e.type==='user/message');f.events[index]={...f.events[index]!,data:{id:'changed',source:{kind:'user'},content:'Changed evidence'}}
   yield {type:'text-delta',text:'{"schemaVersion":3,"memoryOperations":[]}'};yield {type:'finish',reason:{kind:'stop'}}
  }}})
  withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed'").run();finalizer!.scheduleInTransaction(f.db,{runId:'review',workspace:'project:test',dshSessionId:f.session.id,sourceEndSeq:f.events.length-1});handoffReview(f.db,'review','completed')})
  await finalizer.start();await finalizer.whenIdle()
  assert.equal(f.db.prepare('SELECT status FROM dsh_memory_finalizations').get()?.status,'failed')
  assert.equal(f.db.prepare('SELECT reviewed_through_seq FROM memory_review_states').get()?.reviewed_through_seq,0)
 }finally{await finalizer?.dispose();await f.close()}
})

test('legacy v1/v2 Finalizers honor exclusion before dispatch and abort already dispatched extraction',async()=>{
 for(const evolution of ['off','active'] as const)for(const phase of ['before','after'] as const){
  const f=await setup();let finalizer:DshMemoryFinalizer|undefined,calls=0,sent!:()=>void,signal:AbortSignal|undefined
  const dispatched=new Promise<void>(r=>{sent=r})
  try{
   await f.add();await f.coordinator.dispose()
   f.db.prepare('DELETE FROM memory_review_turns').run();f.db.prepare('DELETE FROM memory_review_states').run()
   finalizer=new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:f.mirror,now:()=>NOW,memoryEvolution:{mode:evolution,dailyCalls:12,maxInputBytes:32768,maxOutputTokens:2048,timeoutMs:30000},llm:{async *stream(request){calls++;signal=request.signal;sent();await new Promise(()=>{});yield {}}}})
   withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed'").run();finalizer!.scheduleInTransaction(f.db,{runId:'review',workspace:'project:test',dshSessionId:f.session.id,sourceEndSeq:f.events.length-1})})
   assert.equal(f.db.prepare('SELECT memory_adoption_version FROM dsh_memory_finalizations').get()?.memory_adoption_version,1)
   if(phase==='before')await f.coordinator.exclude('project:test',f.session.id)
   await finalizer.start();if(phase==='after'){await dispatched;await f.coordinator.exclude('project:test',f.session.id)}
   await finalizer.whenIdle();assert.equal(calls,phase==='after'?1:0)
   if(phase==='after')assert.equal(signal?.aborted,true)
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  }finally{await finalizer?.dispose();await f.close()}
 }
})

test('a second Finalizer preserves a live lease, recovers expiry, and rejects the first late commit',async()=>{
 const f=await setup();let a:DshMemoryFinalizer|undefined,b:DshMemoryFinalizer|undefined,finish!:()=>void,sent!:()=>void,calls=0,now=NOW
 const dispatched=new Promise<void>(r=>{sent=r}),response=new Promise<void>(r=>{finish=r})
 try{
  await f.add()
  a=new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:f.mirror,now:()=>now,llm:{async *stream(){calls++;sent();await response;yield {type:'text-delta',text:'{"schemaVersion":3,"memoryOperations":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
  withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed'").run();a!.scheduleInTransaction(f.db,{runId:'review',workspace:'project:test',dshSessionId:f.session.id,sourceEndSeq:f.events.length-1});handoffReview(f.db,'review','completed')})
  await a.start();await dispatched
  b=new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:f.mirror,now:()=>now,llm:{async *stream(){calls++;yield {type:'text-delta',text:'{"schemaVersion":3,"memoryOperations":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
  await b.start();await b.whenIdle();assert.equal(calls,1)
  now=new Date(Date.parse(NOW)+400000).toISOString()
  await b.dispose()
  b=new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:f.mirror,now:()=>now,llm:{async *stream(){calls++;yield {type:'text-delta',text:'{"schemaVersion":3,"memoryOperations":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
  await b.start();await b.whenIdle();assert.equal(calls,2)
  finish();await a.whenIdle()
  const job=f.db.prepare('SELECT status,attempt_count FROM dsh_memory_finalizations').get()!
  assert.equal(job.status,'completed');assert.equal(job.attempt_count,2)
  assert.equal(f.db.prepare('SELECT handoff_status FROM memory_review_states').get()?.handoff_status,'finalizer_completed')
 }finally{finish();await a?.dispose();await b?.dispose();await f.close()}
})
