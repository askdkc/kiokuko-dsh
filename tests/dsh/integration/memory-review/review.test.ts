import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, createRun, NOW } from '../evolution/fixture.js'
import { DshSessionLogMirror } from '../../../../src/dsh/session-log-mirror.js'
import { AutoMemoryReviewCoordinator } from '../../../../src/dsh/auto-memory-review.js'
import { MemoryReviewConfig } from '../../../../src/memory/review/contracts.js'
import { configureReview, reviewSettings } from '../../../../src/memory/review/store.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { DshMemoryFinalizer, type DshLogEvent, type DshLlm } from '../../../../src/dsh/session-memory-finalizer.js'
import { capturePolicy } from '../../../../src/memory/capture-policy.js'

// The former turn-count/finalizer writers are retired. Positive extraction,
// exact preview approval, revision and decline coverage lives in
// ../replay-memory-review.test.ts and ../replay-unowned-native-review.test.ts.
async function setup(options: {mode?:'active'|'observe'|'off'; llm?:DshLlm; timeoutMs?:number;dailyCalls?:number}={}) {
  const f=fixture();createRun(f.db,'review')
  const events:DshLogEvent[]=[{type:'session/start',seq:0,time:0,data:{}}]
  const session={id:'session-review',header:{},get seq(){return events.length},eventAt:(seq:number)=>events[seq]}
  const mirror=new DshSessionLogMirror({runtime:f.runtime,databasePath:':memory:',now:()=>NOW})
  await mirror.start();await mirror.observe(session.id,events[0]!)
  let calls=0
  const llm=options.llm??{async *stream(request){calls++;assert.deepEqual(request.tools,[]);const payload=JSON.parse((request.messages[0] as {content:{text:string}[]}).content[0]!.text)
    yield {type:'text-delta',text:JSON.stringify({schemaVersion:2,proposals:[{action:'add',kind:'preference',title:'Answer language',body:'このプロジェクトの回答は日本語を使う。',evidenceIds:[payload.evidence[0].id],claims:[{id:'language',text:'このプロジェクトの回答は日本語を使う。',evidence:[{evidenceId:payload.evidence[0].id,supportingText:payload.evidence[0].text}]}]}]})}
    yield {type:'finish',reason:{kind:'stop'},usage:{inputTokens:100,outputTokens:50}}
  }}
  const config=MemoryReviewConfig.parse({...(options.mode?{mode:options.mode}:{}),...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{}),...(options.dailyCalls?{dailyCalls:options.dailyCalls}:{})})
  let flushed=-1,flushCount=0
  const coordinator=new AutoMemoryReviewCoordinator({runtime:f.runtime,mirror,llm,config,now:()=>NOW,flush:async s=>{assert.equal(s,session);flushed=events.length-1;flushCount++;return true}})
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
  return {...f,events,session,mirror,coordinator,binding,add,calls:()=>calls,flushed:()=>flushed,flushCount:()=>flushCount,llm,config,async close(){await coordinator.dispose();await mirror.close();f.db.close()}}
}

const counts=(db:ReturnType<typeof fixture>['db'])=>Object.fromEntries(
  ['entries','memory_review_states','memory_review_turns','memory_review_jobs','memory_review_effects','dsh_memory_finalizations','memory_episodes']
    .map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n]))
for(const mode of ['active','observe','off'] as const)test(`legacy ${mode} mode never extracts or saves at periodic, manual or boundary turns`,async()=>{
 const f=await setup({mode})
 try{
  const before=counts(f.db),writes=f.db.prepare('SELECT total_changes() AS n').get()!.n
  await f.coordinator.start('project:test');await f.coordinator.bind(f.binding)
  for(let i=0;i<8;i++)await f.add(false)
  for(let i=0;i<16;i++)await f.add()
  for(const origin of ['periodic','manual','boundary'] as const){
   assert.equal(await f.coordinator.scan(f.binding,f.events.length-1,origin),undefined)
   f.coordinator.notify(f.binding,f.events.length-1,origin==='manual'?'periodic':origin)
  }
  await f.coordinator.whenIdle()
  assert.equal(f.calls(),0);assert.equal(f.flushCount(),0)
  assert.deepEqual(counts(f.db),before)
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n,writes)
  assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get()?.status,'active')
 }finally{await f.close()}
})
test('restart does not turn recorded human history into an automatic admission or pending draft',async()=>{
 const f=await setup();let second:AutoMemoryReviewCoordinator|undefined
 try{
  for(let i=0;i<3;i++)await f.add()
  await f.coordinator.dispose()
  second=new AutoMemoryReviewCoordinator({runtime:f.runtime,mirror:f.mirror,llm:f.llm,config:f.config,now:()=>NOW,flush:async()=>true})
  await second.start('project:test');await second.bind({...f.binding,startSeq:f.events.length})
  for(let i=0;i<5;i++)await f.add()
  second.notify(f.binding,f.events.length-1);await second.whenIdle()
  assert.equal(f.calls(),0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_review_states').get()?.n,0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_review_jobs').get()?.n,0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
 }finally{await second?.dispose();await f.close()}
})
test('manual reserve and retries cannot bypass the post-task native review question',async()=>{
 const f=await setup()
 try{
  const before=counts(f.db)
  const range={workspace:'project:test',runId:'review',sessionId:f.session.id,sourceGeneration:'generation',startSeq:1,endSeq:8}
  await assert.rejects(f.coordinator.reserve(range,'manual'),/post_task_memory_review_required/)
  for(const id of ['old-held-job','unknown-job'])await assert.rejects(f.coordinator.retry('project:test',id),/post_task_memory_review_required/)
  assert.equal(f.calls(),0);assert.deepEqual(counts(f.db),before)
 }finally{await f.close()}
})
test('persisted capture exclusion remains authoritative while retired writers stay inactive',async()=>{
 const f=await setup()
 try{
  await f.coordinator.exclude('project:test',f.session.id)
  for(let i=0;i<8;i++)await f.add()
  assert.equal(capturePolicy(f.db,'project:test',f.session.id).mode,'excluded')
  const finalizer=new DshMemoryFinalizer({runtime:f.runtime,llm:f.llm,sessionQuery:f.mirror,now:()=>NOW})
  try{
   withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='completed'").run();finalizer.scheduleInTransaction(f.db,{runId:'review',workspace:'project:test',dshSessionId:f.session.id,sourceEndSeq:f.events.length-1})})
   await finalizer.start();finalizer.kick();await finalizer.whenIdle()
   assert.equal(f.calls(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get()?.n,0)
   assert.equal(f.db.prepare('SELECT status FROM ledger_runs').get()?.status,'completed')
  }finally{await finalizer.dispose()}
 }finally{await f.close()}
})
test('explicit configuration retains generation fencing but cannot enable automatic writes',async()=>{
 const f=await setup()
 try{
  assert.equal(reviewSettings(f.db,'project:test'),undefined,'startup no longer persists memory configuration')
  await f.coordinator.setMode('project:test','active')
  const initial=reviewSettings(f.db,'project:test')!
  withImmediateTransaction(f.db,()=>configureReview(f.db,'project:test',MemoryReviewConfig.parse({mode:'off'}),NOW,initial.generation))
  await f.coordinator.bind(f.binding);await f.coordinator.start('project:test')
  assert.equal(reviewSettings(f.db,'project:test')!.config.mode,'off')
  await assert.rejects(f.coordinator.configure(MemoryReviewConfig.parse({mode:'active'})),/generation_conflict/)
  for(let i=0;i<8;i++)await f.add()
  assert.equal(f.calls(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
 }finally{await f.close()}
})
for(const extraction of [1,2])for(const adoption of [1,2])test(`historical extraction ${extraction}/adoption ${adoption} jobs remain inert on restart and lease expiry`,async()=>{
 const f=await setup();let finalizer:DshMemoryFinalizer|undefined
 try{
  await f.add()
  f.db.prepare("UPDATE ledger_runs SET status='completed'").run()
  f.db.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,input_mode,scheduled_at,updated_at,extraction_version,memory_adoption_version,claim_nonce,lease_until)
    VALUES('review','project:test',?,1,?,'processing',1,'prefix_reuse',?,?,?,?, 'historical-claim',?)`).run(f.session.id,f.events.length-1,NOW,NOW,extraction,adoption,NOW)
  const before=f.db.prepare('SELECT * FROM dsh_memory_finalizations').get()
  for(const now of [NOW,new Date(Date.parse(NOW)+400000).toISOString()]){
   finalizer=new DshMemoryFinalizer({runtime:f.runtime,sessionQuery:f.mirror,now:()=>now,llm:f.llm})
   await finalizer.start();finalizer.kick();await finalizer.whenIdle();await finalizer.dispose()
   assert.equal(f.calls(),0);assert.deepEqual(f.db.prepare('SELECT * FROM dsh_memory_finalizations').get(),before)
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  }
 }finally{await finalizer?.dispose();await f.close()}
})
test('ordinary task binding remains independent of unavailable optional memory',async()=>{
 let storageCalls=0,modelCalls=0
 const runtime={withDatabase:async()=>{storageCalls++;throw new Error('memory unavailable')}}
 const coordinator=new AutoMemoryReviewCoordinator({runtime:runtime as any,mirror:{} as any,llm:{async *stream(){modelCalls++;yield {type:'finish',reason:{kind:'stop'}}}}})
 try{
  const binding={workspace:'project:test',runId:'task',session:{id:'native-session'},startSeq:0}
  await coordinator.start(binding.workspace);await coordinator.bind(binding);coordinator.notify(binding,40)
  assert.equal(await coordinator.scan(binding,40,'manual'),undefined)
  await coordinator.whenIdle();assert.equal(storageCalls,0);assert.equal(modelCalls,0)
 }finally{await coordinator.dispose()}
})
