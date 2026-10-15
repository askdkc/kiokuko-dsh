import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {realpathSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {observeMemory,improveMemory,memoryContext,MemoryObservation,type MemoryObservationInput,type MemorySource,type RoutineCandidate} from '../../../src/memory/lifecycle.js'
import {excludeCapture} from '../../../src/memory/capture-policy.js'
import {DshLifecycleMemory} from '../../../src/dsh/lifecycle-memory.js'
import {DshCoreRuntime} from '../../../src/dsh/core-runtime.js'
import {recordEntry} from '../../../src/memory/entries.js'
import {ensureGlobalWorkspace} from '../../../src/memory/workspaces.js'
import type {SqliteDatabase} from '../../../src/db/adapter.js'
import {canonicalContentHash} from '../../../src/serialization/validate.js'

const input=(id:string,kind:MemoryObservationInput['kind']='completion'):MemoryObservationInput=>({cwd:process.cwd(),eventId:id,sessionId:'session-a',kind,
  summary:'Recorded parser checks',tags:['parser','test'],outcome:'passed',verification:'passed',actions:[{kind:'test',outcome:'passed',summary:'parser assertions'}],
  source:{producer:'kiokuko-dsh',runId:id,eventIds:[`native:${id}`]}})
async function database(fn:(db:ReturnType<typeof openConnection>)=>void){const dir=await mkdtemp(join(tmpdir(),'lifecycle-store-'));const db=openConnection(join(dir,'state.db'))
  try{migrateDatabase(db,join(process.cwd(),'migrations'));fn(db)}finally{db.close();await rm(dir,{recursive:true,force:true})}}
const count=(db:SqliteDatabase,table:string)=>db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n
// These are explicit historical fixture rows, not calls through a retired writer.
// Retrieval of old data stays covered while all new writes require the native
// organization/preview/approval path in replay-memory-review.test.ts.
function historicalObservation(db:SqliteDatabase,workspace:string,raw:MemoryObservationInput,options:{sourceKey?:string;revision?:number;tombstone?:boolean;hostVerified?:boolean;createdAt?:string}={}){
  const parsed=MemoryObservation.parse(raw),value={...parsed,summary:parsed.summary??'Observation withdrawn.'}
  const sourceKey=options.sourceKey??value.eventId,revision=options.revision??value.source.revision,tombstone=options.tombstone??value.source.tombstone,hostVerified=options.hostVerified??false
  if(!hostVerified)value.verification='unknown'
  const digest=canonicalContentHash({value,sourceKey,revision,tombstone,hostVerified}),createdAt=options.createdAt??new Date().toISOString()
  db.prepare('INSERT INTO dsh_memory_observations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(workspace,value.source.producer,value.eventId,value.sessionId,sourceKey,revision,Number(tombstone),Number(hostVerified),JSON.stringify(value),digest,createdAt)
  const source:MemorySource={producer:value.source.producer,eventId:value.eventId,runId:value.source.runId,eventIds:value.source.eventIds,sourceKey,revision,digest,verification:value.verification,verificationSource:hostVerified?'host_receipt':'producer_assertion'}
  return {value,source,hostVerified,createdAt}
}
function historicalFeedback(db:SqliteDatabase,workspace:string,row:ReturnType<typeof historicalObservation>,revision=1){
  const caution=row.value.kind==='complaint'
  const candidate:RoutineCandidate={id:`feedback:${canonicalContentHash([row.source.producer,row.source.sourceKey])}`,kind:caution?'caution':'procedure',
    summary:[row.value.issue??row.value.summary,row.value.prevention??(caution?'A source-backed correction and verification are still required before reusing this result.':'Human praise is a candidate signal; it does not establish verification.')].join('\n'),
    tags:row.value.tags,verification:row.hostVerified?'passed':'unknown',confidence:row.hostVerified?0.7:0.3,candidate:true,active:true,sources:[row.source]}
  db.prepare('INSERT INTO dsh_memory_routine_revisions VALUES(?,?,?,?,?,?)').run(workspace,candidate.id,revision,JSON.stringify(candidate),canonicalContentHash(candidate),row.createdAt)
  return candidate
}
function countedDatabase(db:SqliteDatabase){let reads=0
  const counted:SqliteDatabase={filePath:db.filePath,exec:sql=>db.exec(sql),close:()=>db.close(),prepare:sql=>{
    if(sql.includes('SELECT o.* FROM dsh_memory_observations'))reads++
    return db.prepare(sql)}}
  return {db:counted,reads:()=>reads}
}

for(const kind of ['completion','compaction','model_switch','complaint','praise'] as const)test(`${kind} suggestions cannot write observations or derive routines before review`,()=>database(db=>{
  const before=db.prepare('SELECT total_changes() AS n').get()!.n
  for(const version of [{},{hostVerified:true},{revision:2},{revision:3,tombstone:true}]){
    const result=observeMemory(db,'repo-a',input('one',kind),version)
    assert.equal(result.accepted,false);assert.equal(result.recorded,false);assert.equal(result.workMayContinue,true)
    assert.deepEqual(result.diagnostics,['post_task_memory_review_required'])
  }
  const result=improveMemory(db,'repo-a');assert.equal(result.recorded,false);assert.equal(result.changed,0);assert.equal(result.skipped,true)
  assert.equal(count(db,'dsh_memory_observations'),0);assert.equal(count(db,'dsh_memory_routine_revisions'),0);assert.equal(count(db,'entries'),0)
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before)
}))
test('historical context is repo-bound and source-integrity checked; public assertions remain unverified',()=>database(db=>{
  const praise=historicalObservation(db,'repo-a',input('praise','praise'));historicalFeedback(db,'repo-a',praise)
  historicalObservation(db,'repo-a',input('completion'))
  const context=memoryContext(db,'repo-a',{query:'parser',tags:['test'],sessionId:'session-a'})
  assert.equal(context.successfulProcedures.length,1);assert.equal(context.successfulProcedures[0]?.verification,'unknown')
  assert.equal(context.successfulProcedures[0]?.confidence,0.3);assert.equal(context.entries[0]?.untrusted,true)
  assert.equal(context.entries[0]?.scope,'project');assert.equal(context.continuation.length,1)
  assert.equal(memoryContext(db,'repo-b',{sessionId:'session-a'}).sourceRefs.length,0)
  assert.equal(memoryContext(db,'repo-a',{tags:['missing']}).sourceRefs.length,0)
  assert.equal(memoryContext(db,'repo-a',{sessionId:'new-task'}).continuation.length,0)
  db.prepare("UPDATE dsh_memory_observations SET observation_json=json_set(observation_json,'$.summary','unattributed replacement') WHERE event_id='praise'").run()
  assert.deepEqual(memoryContext(db,'repo-a').diagnostics,['memory_unavailable'])
}))
test('historical feedback revisions and tombstones immediately withdraw old references without automatic improvement',()=>database(db=>{
  const first=historicalObservation(db,'repo-a',input('praise','praise'),{sourceKey:'message-1',revision:1});historicalFeedback(db,'repo-a',first)
  assert.equal(memoryContext(db,'repo-a').successfulProcedures.length,1)
  const second=historicalObservation(db,'repo-a',{...input('complaint','complaint'),summary:'Parser output was wrong'},{sourceKey:'message-1',revision:2})
  assert.equal(memoryContext(db,'repo-a').successfulProcedures.length,0)
  assert.equal(improveMemory(db,'repo-a').recorded,false);assert.equal(memoryContext(db,'repo-a').cautions.length,0)
  historicalFeedback(db,'repo-a',second,2);assert.equal(memoryContext(db,'repo-a').cautions.length,1)
  historicalObservation(db,'repo-a',{...input('withdrawn','praise'),summary:undefined},{sourceKey:'message-1',revision:3,tombstone:true})
  assert.equal(memoryContext(db,'repo-a').sourceRefs.length,0)
  assert.equal(observeMemory(db,'repo-a',input('praise','praise'),{sourceKey:'message-1',revision:1}).recorded,false)
  assert.equal(count(db,'dsh_memory_observations'),3);assert.equal(count(db,'dsh_memory_routine_revisions'),2)
}))
test('historical host provenance stays explicit and capture refusal withdraws cached context',()=>database(db=>{
  historicalFeedback(db,'repo-a',historicalObservation(db,'repo-a',input('checked','praise'),{hostVerified:true}))
  assert.equal(memoryContext(db,'repo-a').successfulProcedures[0]?.verification,'passed')
  excludeCapture(db,'repo-a','session-a','excluded','test',new Date().toISOString())
  assert.equal(memoryContext(db,'repo-a').sourceRefs.length,0)
  assert.equal(observeMemory(db,'repo-a',input('refused')).recorded,false)
  assert.equal(observeMemory(db,'repo-a',{...input('secret'),sessionId:'other',summary:'Authorization: Bearer sk-secret-token-012345678901234567890123456789'}).recorded,false)
  assert.equal(count(db,'dsh_memory_observations'),1)
}))
test('historical continuation expires and cache keys isolate query, tags, workspace and session',async(t)=>{
 await database(db=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now})
  historicalObservation(db,'repo-a',input('ttl','model_switch'))
  historicalFeedback(db,'repo-a',historicalObservation(db,'repo-a',input('feedback','complaint')))
  const probe=countedDatabase(db),first=memoryContext(probe.db,'repo-a',{sessionId:'session-a'})
  assert.equal(first.continuation.length,1);first.cautions[0]!.summary='Caller mutation'
  for(let i=0;i<10;i++)assert.ok(!JSON.stringify(memoryContext(probe.db,'repo-a',{sessionId:'session-a'})).includes('Caller mutation'))
  assert.equal(probe.reads(),1)
  for(const options of [{query:'parser'},{tags:['test']},{sessionId:'other-session'}])memoryContext(probe.db,'repo-a',options)
  memoryContext(probe.db,'repo-b');assert.equal(probe.reads(),5)
  t.mock.timers.setTime(now+86400001)
  assert.equal(memoryContext(probe.db,'repo-a',{sessionId:'session-a'}).handoff,null);assert.equal(probe.reads(),6)
  historicalObservation(db,'repo-a',{...input('feedback','complaint'),source:{...input('feedback').source,revision:1,tombstone:true}})
  assert.equal(memoryContext(probe.db,'repo-a').cautions.length,0)
 })
})
test('old same-repo historical complaints survive the recent event window without new automatic global entries',()=>database(db=>{
 historicalFeedback(db,'repo-a',historicalObservation(db,'repo-a',{...input('durable','complaint'),summary:'PRIVATE_PROJECT_TITLE parser regression',prevention:'Check parser fixtures first'}))
 for(let i=0;i<520;i++)historicalObservation(db,'repo-a',{...input(`switch-${i}`,'model_switch'),actions:[]},{createdAt:new Date(Date.now()+i+1).toISOString()})
 assert.match(memoryContext(db,'repo-a',{sessionId:'new-task'}).cautions[0]!.summary,/Check parser fixtures first/)
 assert.equal(improveMemory(db,'repo-a').recorded,false)
 assert.equal(memoryContext(db,'repo-b').globalPrinciples.length,0);assert.equal(count(db,'entries'),0)
}))
test('optional writes remain inert through SQLite writer contention and after the lock is released',()=>database(db=>{
 const other=openConnection(db.filePath)
 try{
  other.exec('BEGIN IMMEDIATE');const start=performance.now()
  assert.equal(observeMemory(db,'repo-a',input('locked')).recorded,false);assert.equal(improveMemory(db,'repo-a').recorded,false)
  assert.ok(performance.now()-start<100);assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,5000)
 }finally{other.exec('ROLLBACK');other.close()}
 assert.equal(observeMemory(db,'repo-a',input('after-lock')).recorded,false);assert.equal(count(db,'dsh_memory_observations'),0)
}))
test('restart reads historical context but does not resume pending automatic extraction',async()=>{
 const base=await mkdtemp(join(tmpdir(),'lifecycle-restart-')),file=join(base,'state.db'),db=openConnection(file)
 try{
  migrateDatabase(db,join(process.cwd(),'migrations'));historicalObservation(db,'repo-a',input('restart','model_switch'))
  const pending=db.prepare("SELECT source_revision,processed_revision FROM dsh_memory_processing_state WHERE workspace='repo-a'").get()
  const script=`import {openConnection} from './src/db/connection.ts';import {improveMemory,memoryContext} from './src/memory/lifecycle.ts';
   const db=openConnection(process.env.MEMORY_TEST_DB);console.log(JSON.stringify({result:improveMemory(db,'repo-a'),context:memoryContext(db,'repo-a',{sessionId:'session-a'})}));db.close();`
  for(let i=0;i<2;i++){
   const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,MEMORY_TEST_DB:file},encoding:'utf8'})
   assert.equal(child.status,0,child.stderr);const output=JSON.parse(child.stdout)
   assert.equal(output.result.recorded,false);assert.equal(output.context.continuation.length,1)
  }
  assert.deepEqual(db.prepare("SELECT source_revision,processed_revision FROM dsh_memory_processing_state WHERE workspace='repo-a'").get(),pending)
  assert.equal(count(db,'dsh_memory_routine_revisions'),0)
 }finally{db.close();await rm(base,{recursive:true,force:true})}
})
test('keyword/tag search reads eligible existing Global references and excludes private profiles',()=>database(db=>{
  ensureGlobalWorkspace(db)
  recordEntry(db,{workspace:'global',kind:'reference',title:'Parser technique',body:'Use parser fixtures to compare behavior.',tags:['parser','test'],trustLevel:'untrusted'})
  recordEntry(db,{workspace:'global',kind:'preference',title:'Private preference',body:'PRIVATE_PROFILE',tags:['parser'],trustLevel:'untrusted'})
  recordEntry(db,{workspace:'global',kind:'reference',title:'Project detail',body:'Read /Users/private/project/parser.ts',tags:['parser'],trustLevel:'untrusted'})
  for(let i=0;i<70;i++)recordEntry(db,{workspace:'global',kind:'reference',title:`Recent filler ${i}`,body:`General algebra method ${i}`,tags:['algebra'],trustLevel:'untrusted'})
  const context=memoryContext(db,'repo-a',{query:'parser',tags:['test']})
  assert.equal(context.globalPrinciples.length,1);assert.match(context.entries[0]!.summary,/parser fixtures/)
  assert.ok(!JSON.stringify(memoryContext(db,'repo-a')).includes('PRIVATE_PROFILE'))
  assert.ok(!JSON.stringify(memoryContext(db,'repo-a')).includes('/Users/private'))
}))

class Host {
  handlers=new Map<string,Function[]>();definitions=new Map<string,any>();agents=new Map<string,any>();sessions=new Map<string,any>()
  get(name:string){return name==='agents'?{list:()=>[...this.agents.values()],get:(id:string)=>this.agents.get(id)}:name==='sessions'?{get:(id:string)=>this.sessions.get(id)}:
    name==='tools'?{get:(name:string)=>this.definitions.get(name),register:(d:any)=>{this.definitions.set(d.name,d);return ()=>this.definitions.delete(d.name)}}:undefined}
  on(name:string,fn:Function){const list=this.handlers.get(name)??[];list.push(fn);this.handlers.set(name,list);return ()=>{this.handlers.set(name,(this.handlers.get(name)??[]).filter(x=>x!==fn))}}
  emit(name:string,...args:any[]){for(const fn of this.handlers.get(name)??[])fn(...args)}
}
/** Mirrors native acceptance: pre-step returns messages, then the loop commits its system head first. */
const humanMessage=()=>({id:'human-input',role:'user',content:[{type:'text',text:'Explain parser'}],source:{kind:'user'}})
function nativeSurface(host:Host,id:string,root:string){
  const events:any[]=[],session:any={id,header:{cwd:root,version:4},seq:0,surface:{nodes:[]},eventAt:(seq:number)=>events[seq]}
  session.append=(type:string,data:any,options:any={})=>{
    const nodes:number[]=session.surface.nodes,operation=options.surfaceOp
    if(operation){
      assert.ok(nodes.length?events[nodes[0]!]!.type==='system/message':type==='system/message','native system message must own the first surface head')
      if(operation.op==='replace')assert.notEqual(operation.startSeq,nodes[0],'the first surface head is protected')
    }
    const event={type,seq:session.seq++,data};events[event.seq]=event
    if(operation?.op==='replace')nodes.splice(nodes.indexOf(operation.startSeq),1,event.seq)
    else if(operation)nodes.push(event.seq)
    host.emit('session/event',session,event);return event
  }
  const agent={id:`agent-${id}`,session,ctx:host}
  host.agents.set(agent.id,agent);host.sessions.set(session.id,session)
  const step=async(turn=1)=>{
    const decision=await host.handlers.get('agent/pre-step')![0]!({agent,turn,messages:[humanMessage()]},async()=>({kind:'enter',messages:session.surface.nodes.length?[]:[humanMessage()]}))
    assert.equal(decision.kind,'enter')
    if(!session.surface.nodes.length)session.append('system/message',{message:{role:'system',content:[{type:'text',text:'Native system prompt'}]}},{surfaceOp:'append'})
    for(const message of decision.messages)session.append('user/message',message,{surfaceOp:'append'})
    return decision
  }
  return {events,session,agent,step}
}

async function nativeFixture(){
 const base=await mkdtemp(join(tmpdir(),'lifecycle-native-')),root=join(base,'repo');await mkdir(root)
 const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
 await runtime.start();const host=new Host(),native=nativeSurface(host,'native-session',root),memory=new DshLifecycleMemory(host as any,runtime,realpathSync(root))
 return {base,root,runtime,host,...native,memory,async close(){memory.stop();await memory.whenIdle();await runtime.close();await rm(base,{recursive:true,force:true})}}
}
const projectedContext=()=>({workMayContinue:true as const,diagnostics:[],replay:[{request:{text:'Check parser'},tags:['parser'],findings:[],attempts:[]}]} as any)
test('core and optional modules share one observer and retain all read-only tools until the last owner releases them',()=>{
 const host=new Host(),root=realpathSync(process.cwd()),runtime:any={withDatabase:async()=>undefined}
 const core=new DshLifecycleMemory(host as any,runtime,root),addon=new DshLifecycleMemory(host as any,runtime,root)
 assert.equal(core,addon);assert.deepEqual([...host.definitions.keys()].sort(),['memory_context','memory_improve','memory_observe','memory_review_status'])
 core.stop();assert.equal(host.definitions.size,4);addon.stop();assert.equal(host.definitions.size,0)
})
for(const [kind,header] of [['main branch',{parentSession:'previous-main-session'}],['native child origin',{parentSession:'parent',origin:'subagent'}],['native child depth',{parentSession:'parent',delegationDepth:1}]] as const)test(`${kind} model and feedback events do not create memory`,async()=>{
 const f=await nativeFixture()
 try{
  Object.assign(f.session.header,header)
  for(const [type,data] of [
   ['request/header',{header:{config:{provider:'mock',model:'first'}}}],['model/selection',{provider:'mock',model:'second'}],
   ['compaction/summary',{summary:[{type:'text',text:'Keep parser constraints'},{type:'reasoning',text:'PRIVATE_REASONING_SENTINEL'}]}],['compaction/end',{}],
   ['assistant/message',{message:{content:[{type:'text',text:'Public parser result'},{type:'reasoning',text:'PRIVATE_REASONING_SENTINEL'}]}}],
   ['feedback/message-put',{sessionId:f.session.id,item:{messageId:'answer',rating:'negative',note:'Parser wrong'}}],['feedback/message-delete',{sessionId:f.session.id,messageId:'answer'}],
  ] as const)f.session.append(type,data)
  await f.memory.periodic();await f.memory.whenIdle()
  const context:any=await f.memory.context({cwd:f.root,sessionId:f.session.id})
  assert.deepEqual(context.replay,[]);assert.equal(context.cautions.length,0);assert.equal(context.continuation.length,0)
  assert.equal(await f.runtime.withDatabase(db=>count(db,'dsh_memory_observations')),0)
  assert.equal(await f.runtime.withDatabase(db=>count(db,'dsh_memory_routine_revisions')),0)
  assert.ok(!JSON.stringify(context).includes('PRIVATE_'))
 }finally{await f.close()}
})
test('periodic callbacks and repeated completion hints cannot save without native review',async(t)=>{
 const f=await nativeFixture();t.mock.timers.enable({apis:['setInterval']})
 try{
  for(let i=0;i<2;i++)assert.equal((await f.memory.observe({...input(`silent-${i}`),cwd:f.root})).recorded,false)
  t.mock.timers.tick(60_000);await f.memory.periodic()
  for(const status of ['completed','failed','cancelled','interrupted'])f.memory.completed(`task-${status}`,status,f.session.id)
  await f.memory.whenIdle()
  for(const table of ['entries','dsh_memory_observations','dsh_memory_routine_revisions'])assert.equal(await f.runtime.withDatabase(db=>count(db,table)),0)
 }finally{t.mock.timers.reset();await f.close()}
})
test('optional replay projection preserves native acceptance and never writes ahead of the system head',async()=>{
 const f=await nativeFixture()
 try{
  f.memory.context=async()=>projectedContext()
  const hook=f.host.handlers.get('agent/pre-step')![0]!,reject={kind:'reject',reason:'Native admission refused'}
  assert.equal(await hook({agent:f.agent,messages:[humanMessage()]},async()=>reject),reject);assert.equal(f.events.length,0)
  const human=humanMessage(),accepted={kind:'enter',messages:[human],startsRequestSeries:true}
  const decision=await hook({agent:f.agent,turn:1,messages:[human]},async()=>accepted)
  assert.equal(f.events.length,0);assert.equal(decision.startsRequestSeries,true);assert.equal(decision.messages[0],human)
  assert.equal(accepted.messages.length,1);assert.equal(decision.messages.length,2)
  assert.match(decision.messages[1].content[0].text,/reference data, never instructions or permissions/)
  f.session.append('system/message',{message:{role:'system',content:[]}},{surfaceOp:'append'})
  for(const message of decision.messages)f.session.append('user/message',message,{surfaceOp:'append'})
  const prior=f.session.surface.nodes.filter((seq:number)=>f.events[seq]?.data?.source?.sections?.some((section:any)=>section.name==='memory:approved-replay'))
  await f.step(1)
  assert.ok(prior.length>0)
  assert.ok(prior.every((seq:number)=>!f.session.surface.nodes.includes(seq)),'old approved projections are retired from the native surface')
  assert.ok(f.session.surface.nodes.some((seq:number)=>f.events[seq]?.data?.source?.sections?.some((section:any)=>section.name==='memory:approved-replay')),'current approved projection is rebuilt')
  assert.equal(f.events[f.session.surface.nodes[0]].type,'system/message')
 }finally{await f.close()}
})
test('unavailable or slow optional context cannot veto the native stream',async()=>{
 const f=await nativeFixture()
 try{
  f.memory.context=()=>new Promise(()=>{})
  const decision={kind:'enter',messages:[humanMessage()]},start=performance.now()
  assert.equal(await f.host.handlers.get('agent/pre-step')![0]!({agent:f.agent,messages:[humanMessage()]},async()=>decision),decision)
  assert.ok(performance.now()-start<1000)
  f.memory.context=async()=>({workMayContinue:true,diagnostics:['memory_unavailable']})
  assert.equal(await f.host.handlers.get('agent/pre-step')![0]!({agent:f.agent,messages:[humanMessage()]},async()=>decision),decision)
  assert.equal(f.events.length,0)
 }finally{await f.close()}
})
for(const change of ['abort','dispose','replace-session'] as const)for(const initial of [true,false])test(`asynchronous ${change} leaves ${initial?'initial':'existing'} native surface unchanged`,async()=>{
 const f=await nativeFixture()
 try{
  f.memory.context=async()=>projectedContext();if(!initial)await f.step()
  const controller=new AbortController();let entered!:()=>void,release!:()=>void
  const retrieving=new Promise<void>(resolve=>{entered=resolve})
  f.memory.context=()=>new Promise(resolve=>{release=()=>resolve(projectedContext());entered()})
  const decision={kind:'enter',messages:[humanMessage()]},count=f.events.length,surface=[...f.session.surface.nodes]
  const pending=f.host.handlers.get('agent/pre-step')![0]!({agent:f.agent,turn:2,messages:[humanMessage()],signal:controller.signal},async()=>decision)
  await retrieving
  if(change==='abort')controller.abort();else if(change==='dispose')f.memory.stop();else f.host.sessions.set(f.session.id,{...f.session})
  release();assert.equal(await pending,decision);assert.equal(f.events.length,count);assert.deepEqual(f.session.surface.nodes,surface)
 }finally{await f.close()}
})
