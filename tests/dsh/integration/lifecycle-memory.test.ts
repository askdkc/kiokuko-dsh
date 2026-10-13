import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {realpathSync} from 'node:fs'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {observeMemory,improveMemory,memoryContext,type MemoryObservationInput} from '../../../src/memory/lifecycle.js'
import {excludeCapture} from '../../../src/memory/capture-policy.js'
import {DshLifecycleMemory} from '../../../src/dsh/lifecycle-memory.js'
import {DshCoreRuntime} from '../../../src/dsh/core-runtime.js'
import {recordEntry} from '../../../src/memory/entries.js'
import {ensureGlobalWorkspace} from '../../../src/memory/workspaces.js'
import {isRetrievableEntry} from '../../../src/memory/hybrid-retrieval.js'
import {readEntry} from '../../../src/memory/entries.js'
import {agenticReplayFixture} from '../helpers/agenticreplay-fixture.js'
import {spawnSync} from 'node:child_process'
import type {SqliteDatabase} from '../../../src/db/adapter.js'
import {canonicalContentHash} from '../../../src/serialization/validate.js'

const input=(id:string,kind:MemoryObservationInput['kind']='completion'):MemoryObservationInput=>({cwd:'/tmp/project',eventId:id,sessionId:'session-a',kind,
  summary:'Recorded parser checks',tags:['parser','test'],outcome:'passed',verification:'passed',actions:[{kind:'test',outcome:'passed',summary:'parser assertions'}],
  source:{producer:'kiokuko-dsh',runId:id,eventIds:[`native:${id}`]}})
async function database(fn:(db:ReturnType<typeof openConnection>)=>void){const dir=await mkdtemp(join(tmpdir(),'lifecycle-store-'));const db=openConnection(join(dir,'state.db'))
  try{migrateDatabase(db,join(process.cwd(),'migrations'));fn(db)}finally{db.close();await rm(dir,{recursive:true,force:true})}}

test('observations are repo-bound, idempotent, immutable and public assertions never establish verification',()=>database(db=>{
  assert.equal(observeMemory(db,'repo-a',input('one')).recorded,true)
  assert.equal(observeMemory(db,'repo-a',input('one')).duplicate,true)
  assert.equal(observeMemory(db,'repo-a',{...input('one'),summary:'Different result'}).accepted,false)
  observeMemory(db,'repo-a',input('two'));improveMemory(db,'repo-a')
  const context=memoryContext(db,'repo-a',{query:'parser',tags:['test']})
  assert.equal(context.successfulProcedures.length,1)
  assert.equal(context.successfulProcedures[0]?.verification,'unknown')
  assert.equal(context.successfulProcedures[0]?.confidence,0.3)
  assert.equal(context.entries[0]?.untrusted,true)
  assert.equal(context.entries[0]?.scope,'project')
  assert.equal(memoryContext(db,'repo-b',{sessionId:'session-a'}).sourceRefs.length,0)
  assert.equal(memoryContext(db,'repo-a',{tags:['missing']}).sourceRefs.length,0)
  assert.equal(memoryContext(db,'repo-a',{sessionId:'new-task'}).continuation.length,0)
  assert.equal(memoryContext(db,'repo-a',{sessionId:'session-a'}).continuation.length,2)
  assert.equal(memoryContext(db,'repo-a',{sessionId:'session-a'}).handoff?.sessionId,'session-a')
  db.prepare("UPDATE dsh_memory_observations SET observation_json=json_set(observation_json,'$.summary','unattributed replacement') WHERE event_id='one'").run()
  assert.deepEqual(memoryContext(db,'repo-a').diagnostics,['memory_unavailable'])
}))
test('feedback revision and tombstone immediately withdraw old references, including before improvement and stale replay',()=>database(db=>{
  const praise={...input('praise','praise'),verification:'unknown' as const}
  assert.equal(observeMemory(db,'repo-a',praise,{sourceKey:'message-1',revision:1}).accepted,true);improveMemory(db,'repo-a')
  assert.equal(memoryContext(db,'repo-a').successfulProcedures.length,1)
  const complaint={...input('complaint','complaint'),summary:'Parser output was wrong',issue:'Incorrect output',prevention:'Check parser output against the fixture'}
  observeMemory(db,'repo-a',complaint,{sourceKey:'message-1',revision:2})
  assert.equal(memoryContext(db,'repo-a').successfulProcedures.length,0)
  improveMemory(db,'repo-a');assert.equal(memoryContext(db,'repo-a').cautions.length,1)
  observeMemory(db,'repo-a',{...input('deleted','praise'),summary:'Withdrawn'},{sourceKey:'message-1',revision:3,tombstone:true})
  assert.equal(memoryContext(db,'repo-a').cautions.length,0)
  assert.equal(observeMemory(db,'repo-a',praise,{sourceKey:'message-1',revision:1}).accepted,false);improveMemory(db,'repo-a')
  assert.equal(memoryContext(db,'repo-a').sourceRefs.length,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_observations').get()?.n,3)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_routine_revisions').get()?.n,3)
}))
test('host verification, independent repeats and counterexamples govern confidence; capture refusal and secrets are excluded',()=>database(db=>{
  observeMemory(db,'repo-a',input('checked-one'),{hostVerified:true});observeMemory(db,'repo-a',input('checked-two'),{hostVerified:true});improveMemory(db,'repo-a')
  assert.equal(memoryContext(db,'repo-a').successfulProcedures[0]?.verification,'passed')
  observeMemory(db,'repo-a',{...input('failed-run'),outcome:'failed',verification:'failed'})
  improveMemory(db,'repo-a');assert.equal(memoryContext(db,'repo-a').successfulProcedures[0]?.confidence,0.2,'failed executions must reduce a routine candidate too')
  observeMemory(db,'repo-a',{...input('counter','complaint'),summary:'The parser case still fails'})
  assert.equal(memoryContext(db,'repo-a').successfulProcedures.length,0,'outdated confidence is withheld before improvement')
  improveMemory(db,'repo-a');assert.equal(memoryContext(db,'repo-a').successfulProcedures[0]?.confidence,0.2)
  excludeCapture(db,'repo-a','session-a','excluded','test',new Date().toISOString())
  assert.equal(memoryContext(db,'repo-a').sourceRefs.length,0)
  assert.equal(observeMemory(db,'repo-a',input('refused')).recorded,false)
  assert.equal(observeMemory(db,'repo-a',{...input('secret'),sessionId:'other',summary:'Authorization: Bearer sk-secret-token-012345678901234567890123456789'}).recorded,false)
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
    const decision=await host.handlers.get('agent/pre-step')![0]!({agent,turn},async()=>({kind:'enter',messages:session.surface.nodes.length?[]:[humanMessage()]}))
    assert.equal(decision.kind,'enter')
    if(!session.surface.nodes.length)session.append('system/message',{message:{role:'system',content:[{type:'text',text:'Native system prompt'}]}},{surfaceOp:'append'})
    for(const message of decision.messages)session.append('user/message',message,{surfaceOp:'append'})
    return decision
  }
  return {events,session,agent,step}
}
test('public revisions correct one event, tombstones may omit summary and session handoff expires after 24 hours',()=>database(db=>{
  const first={...input('event','praise'),source:{...input('event').source,revision:1}}
  assert.equal(observeMemory(db,'repo-a',first).recorded,true)
  assert.equal(observeMemory(db,'repo-a',{...first,summary:'Corrected public feedback',source:{...first.source,revision:2}}).recorded,true)
  assert.equal(observeMemory(db,'repo-a',first).recorded,false)
  assert.equal(observeMemory(db,'repo-a',{...first,summary:undefined,source:{...first.source,revision:3,tombstone:true}}).recorded,true)
  improveMemory(db,'repo-a');assert.equal(memoryContext(db,'repo-a').entries.length,0)
  observeMemory(db,'repo-a',input('old-handoff','model_switch'))
  db.prepare("UPDATE dsh_memory_observations SET created_at='2000-01-01T00:00:00.000Z' WHERE event_id='old-handoff'").run()
  assert.equal(memoryContext(db,'repo-a',{sessionId:'session-a'}).handoff,null)
}))
test('core and optional modules share one observer and retain tools until the last owner releases them',()=>{
  const host=new Host(),root=realpathSync(process.cwd()),runtime:any={withDatabase:async()=>undefined}
  const core=new DshLifecycleMemory(host as any,runtime,root),addon=new DshLifecycleMemory(host as any,runtime,root)
  assert.equal(core,addon);assert.equal(host.definitions.size,3)
  core.stop();assert.equal(host.definitions.size,3)
  addon.stop();assert.equal(host.definitions.size,0)
})
test('local event adapter carries model/compaction context, native feedback withdrawal and bounded nonblocking reads without private reasoning',async()=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-events-')),root=join(base,'repo');await mkdir(root)
  const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  const host=new Host(),{events,session,step}=nativeSurface(host,'native-a',root)
  await runtime.start();const memory=new DshLifecycleMemory(host as any,runtime,realpathSync(root))
  const emit=(type:string,data:any)=>session.append(type,data)
  try{
    emit('request/header',{header:{config:{provider:'mock',model:'first'}}})
    emit('assistant/message',{message:{content:[{type:'text',text:'Public parser result'},{type:'reasoning',text:'PRIVATE_REASONING_SENTINEL'}]}})
    emit('model/selection',{provider:'mock',model:'second'})
    emit('compaction/summary',{compactionId:'compact-1',summary:[{type:'text',text:'Keep parser constraints'},{type:'reasoning',text:'PRIVATE_REASONING_SENTINEL'}],rawOutput:[{type:'text',text:'PRIVATE_RAW_OUTPUT'}]})
    emit('compaction/end',{compactionId:'compact-1'})
    emit('feedback/message-put',{sessionId:session.id,item:{messageId:'answer-1',rating:'negative',note:'Parser output is wrong'}})
    await memory.whenIdle()
    const context:any=await memory.context({cwd:root,sessionId:session.id})
    assert.equal(context.cautions.length,1);assert.equal(context.continuation.length,2)
    assert.ok(!JSON.stringify(context).includes('PRIVATE_'))
    await step()
    assert.match(events.at(-1).data.content[0].text,/Untrusted project memory/)
    emit('feedback/message-delete',{sessionId:session.id,messageId:'answer-1'});await memory.whenIdle()
    assert.equal((await memory.context({cwd:root}) as any).cautions.length,0)
    const query=await host.definitions.get('memory_context').execute({cwd:root,tags:['model_switch']})
    assert.equal(query.workMayContinue,true)
    assert.equal((await memory.context({cwd:base}) as any).diagnostics[0],'memory_unavailable')
    assert.equal(await runtime.withDatabase(db=>JSON.stringify(db.prepare('SELECT observation_json FROM dsh_memory_observations').all()).includes('PRIVATE_')),false)
  }finally{memory.stop();await memory.whenIdle();await runtime.close();await rm(base,{recursive:true,force:true})}
})
test('unavailable storage and slow context never veto a native stream',async()=>{
  const root=realpathSync(process.cwd()),host=new Host(),session={id:'slow-session',header:{cwd:root,version:4},surface:{nodes:[]},append:()=>undefined,eventAt:()=>undefined},agent={id:'slow-agent',session,ctx:host}
  host.agents.set(agent.id,agent);host.sessions.set(session.id,session)
  const runtime:any={withDatabase:()=>new Promise(()=>{})},memory=new DshLifecycleMemory(host as any,runtime,root)
  const hook=host.handlers.get('agent/pre-step')![0]!,start=performance.now()
  const decision={kind:'enter',messages:[humanMessage()]}
  assert.equal(await hook({agent},async()=>decision),decision);assert.ok(performance.now()-start<1000)
  memory.stop()
  const failed=new DshLifecycleMemory(new Host() as any,{withDatabase:async()=>{throw new Error('DB unavailable')}} as any,root)
  assert.equal((await failed.observe({...input('failure'),cwd:root})).workMayContinue,true);failed.stop()
})

test('old same-repo complaints survive the recent event window and new task lookup',()=>database(db=>{
  observeMemory(db,'repo-a',{...input('durable','complaint'),summary:'PRIVATE_PROJECT_TITLE parser regression',prevention:'Check parser fixtures first'})
  improveMemory(db,'repo-a')
  for(let i=0;i<520;i++)observeMemory(db,'repo-a',{...input(`switch-${i}`,'model_switch'),actions:[]})
  improveMemory(db,'repo-a')
  assert.match(memoryContext(db,'repo-a',{sessionId:'new-task'}).cautions[0]!.summary,/Check parser fixtures first/)
  const global=memoryContext(db,'repo-b',{query:'preventive',tags:['prevention']})
  assert.equal(global.globalPrinciples.length,1)
  assert.equal(global.entries[0]?.scope,'global');assert.equal(global.entries[0]?.verification,'unknown')
  const entry=readEntry(db,{workspace:'global',entryId:global.entries[0]!.entryId})
  assert.ok(!JSON.stringify(entry).includes('PRIVATE_PROJECT_TITLE'));assert.ok(!JSON.stringify(entry).includes('repo-a'))
  observeMemory(db,'repo-a',{...input('durable','complaint'),summary:'Withdrawn',source:{...input('durable').source,revision:1,tombstone:true}})
  assert.equal(isRetrievableEntry(db,entry),false,'ordinary Global retrieval must also reject withdrawn sources before improvement')
  assert.equal(memoryContext(db,'repo-b').globalPrinciples.length,0)
}))

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

test('the actual host timer extracts complaint-free repeated completions and stops with its last owner',async(t)=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-timer-')),root=join(base,'repo');await mkdir(root)
  const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  await runtime.start();t.mock.timers.enable({apis:['setInterval']})
  const memory=new DshLifecycleMemory(new Host() as any,runtime,realpathSync(root))
  try{
    await runtime.withDatabase(db=>{const workspace=db.prepare('SELECT workspace FROM repository_locations JOIN repositories USING(repository_id) WHERE canonical_root=?').get<{workspace:string}>(realpathSync(root))!.workspace
      observeMemory(db,workspace,{...input('silent-one'),cwd:root});observeMemory(db,workspace,{...input('silent-two'),cwd:root})
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_routine_revisions').get()!.n,0)})
    t.mock.timers.tick(60_000);await memory.whenIdle()
    const context:any=await memory.context({cwd:root,query:'procedure'})
    assert.equal(context.successfulProcedures.length,1);assert.equal(context.successfulProcedures[0].verification,'unknown','absence of complaints is not verification')
    assert.ok(context.globalPrinciples.some((entry:any)=>entry.tags.includes('routine')))
    memory.stop()
    const count=await runtime.withDatabase(db=>db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_routine_revisions').get()!.n)
    t.mock.timers.tick(60_000);await memory.whenIdle()
    assert.equal(await runtime.withDatabase(db=>db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_routine_revisions').get()!.n),count)
  }finally{memory.stop();t.mock.timers.reset();await runtime.close();await rm(base,{recursive:true,force:true})}
})

test('praise consults a completed AgenticReplay trace through exact host binding and stores only public result metadata',async()=>{
  const f=await agenticReplayFixture({capture:{reasoning:true},shutdownDrainTimeoutMs:1000})
  const runtime=new DshCoreRuntime({repositoryRoot:f.root,databasePath:join(f.root,'index.sqlite3'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  const host=new Host(),session={id:f.binding.sessionId,header:{cwd:f.root,version:4}},agent={id:'replay-agent',session,ctx:host}
  host.agents.set(agent.id,agent);host.sessions.set(session.id,session)
  await runtime.start();const memory=new DshLifecycleMemory(host as any,runtime,f.root)
  memory.connectAgenticReplay({config:f.config,withIndex:f.withIndex,resolveSessionBinding:(a:object,s:object)=>a===agent&&s===session?f.binding:undefined} as any)
  try{
    const workspace=f.database.prepare('SELECT workspace FROM repository_locations JOIN repositories USING(repository_id) WHERE canonical_root=?').get<{workspace:string}>(f.root)!.workspace
    f.database.prepare(`INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at) VALUES('replay-task',?,?,'1','test','{}','completed','{}',?,?,?)`)
      .run(workspace,session.id,new Date().toISOString(),new Date().toISOString(),new Date().toISOString())
    const exec={token:Symbol('public-check'),callId:'public-check',rootCallId:'public-check',name:'parser_assertions',arguments:{privateBody:'PRIVATE_REPLAY_ARGUMENT'},agent}
    f.recorder.preTool({...f.binding,kiokukoRunId:'replay-task'},exec)
    f.recorder.toolResult({...f.binding,kiokukoRunId:'replay-task'},exec,{isError:false,content:[{type:'reasoning',text:'PRIVATE_REPLAY_REASONING'},{type:'text',text:'PRIVATE_REPLAY_BODY'}]})
    await f.recorder.closeSessionRecording(session.id,'manual')
    const trace=(await f.reader.list(f.binding))[0]!
    host.emit('session/event',session,{seq:1,type:'assistant/message',data:{message:{id:'praise-answer',content:[{type:'text',text:'Public result'}]}}})
    memory.completed('replay-task','completed',session.id);await memory.whenIdle()
    host.emit('session/event',session,{seq:2,type:'feedback/message-put',data:{sessionId:session.id,item:{messageId:'praise-answer',rating:'positive',note:'Good result'}}})
    await memory.whenIdle()
    const praise=await runtime.withDatabase(db=>JSON.parse(db.prepare("SELECT observation_json FROM dsh_memory_observations WHERE event_id=?").get<{observation_json:string}>(`feedback:${session.id}:praise-answer`)!.observation_json))
    assert.ok(praise.actions.some((action:any)=>action.summary==='AgenticReplay public result: parser_assertions'))
    assert.ok(praise.source.eventIds.some((id:string)=>id.startsWith(`agenticreplay:${trace.agenticreplay_run_id}:`)))
    assert.equal(praise.verification,'unknown');assert.ok(!JSON.stringify(praise).includes('PRIVATE_REPLAY_'))
    await assert.rejects(f.reader.publicActions({...f.binding,sessionId:'other'},trace.agenticreplay_run_id),/trace_not_found/)
    host.emit('session/event',session,{seq:3,type:'feedback/message-put',data:{sessionId:session.id,item:{messageId:'unbound-answer',rating:'positive'}}});await memory.whenIdle()
    const unbound=await runtime.withDatabase(db=>JSON.parse(db.prepare("SELECT observation_json FROM dsh_memory_observations WHERE event_id=?").get<{observation_json:string}>(`feedback:${session.id}:unbound-answer`)!.observation_json))
    assert.ok(!unbound.source.eventIds.some((id:string)=>id.startsWith('agenticreplay:')))
  }finally{memory.stop();await memory.whenIdle();await runtime.close();await f.dispose()}
})

test('a real SQLite writer lock fails optional observation/extraction promptly and restores the host lock budget',()=>database(db=>{
  const other=openConnection(db.filePath)
  try{
    other.exec('BEGIN IMMEDIATE')
    const start=performance.now()
    assert.equal(observeMemory(db,'repo-a',input('locked')).recorded,false)
    assert.equal(improveMemory(db,'repo-a').recorded,false)
    assert.ok(performance.now()-start<100,'optional memory must not wait for the host busy timeout or retry sleeps')
    assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,5000)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_observations').get()!.n,0)
  }finally{other.exec('ROLLBACK');other.close()}
  assert.equal(observeMemory(db,'repo-a',input('after-lock')).recorded,true)
}))

test('interrupted or cancelled native boundaries cannot seed a repeated-completion routine',()=>database(db=>{
  for(const status of ['cancelled','interrupted'])for(let i=0;i<2;i++)observeMemory(db,'repo-a',{...input(`${status}-${i}`),outcome:'unknown',verification:'unknown',tags:[`status:${status}`]})
  improveMemory(db,'repo-a');assert.equal(memoryContext(db,'repo-a').successfulProcedures.length,0)
}))

function countedDatabase(db:SqliteDatabase){let reads=0
  const counted:SqliteDatabase={filePath:db.filePath,exec:sql=>db.exec(sql),close:()=>db.close(),prepare:sql=>{
    if(sql.includes('SELECT o.* FROM dsh_memory_observations'))reads++
    return db.prepare(sql)}}
  return {db:counted,reads:()=>reads}
}
test('unchanged context/extraction reuse revisions; query/tags/repo/session/evaluation changes invalidate independently',()=>database(db=>{
  observeMemory(db,'repo-a',input('cache-one'));observeMemory(db,'repo-a',input('cache-two'))
  const probe=countedDatabase(db);improveMemory(probe.db,'repo-a');assert.equal(probe.reads(),1)
  for(let i=0;i<10;i++)assert.equal(improveMemory(probe.db,'repo-a').skipped,true)
  assert.equal(probe.reads(),1,'unchanged extraction must not re-read/re-derive observations')
  const first=memoryContext(probe.db,'repo-a',{sessionId:'session-a'});assert.equal(probe.reads(),2)
  first.successfulProcedures[0]!.summary='Caller mutation'
  for(let i=0;i<10;i++){db.prepare('UPDATE repositories SET last_used_at=?').run(`ordinary-host-traffic-${i}`)
    assert.ok(!JSON.stringify(memoryContext(probe.db,'repo-a',{sessionId:'session-a'})).includes('Caller mutation'))}
  assert.equal(probe.reads(),2,'unrelated host writes must not bust the memory cache')
  for(const options of [{query:'parser'},{tags:['test']},{sessionId:'other-session'}])memoryContext(probe.db,'repo-a',options)
  memoryContext(probe.db,'repo-b');assert.equal(probe.reads(),6)
  const revision=db.prepare("SELECT candidate_id,revision,candidate_json FROM dsh_memory_routine_revisions WHERE workspace='repo-a' ORDER BY revision DESC LIMIT 1").get<{candidate_id:string;revision:number;candidate_json:string}>()!
  const evaluation={...JSON.parse(revision.candidate_json),summary:'Unsupported evaluation override'}
  db.prepare('INSERT INTO dsh_memory_routine_revisions VALUES(?,?,?,?,?,?)').run('repo-a',revision.candidate_id,revision.revision+1,JSON.stringify(evaluation),canonicalContentHash(evaluation),new Date().toISOString())
  assert.equal(memoryContext(probe.db,'repo-a',{sessionId:'session-a'}).successfulProcedures.length,0,'a changed/unsupported evaluation must not reuse an old successful cache')
  assert.equal(probe.reads(),7)
}))

test('cached continuation expires without writes and source corrections, tombstones and capture refusal invalidate it',async(t)=>{
  await database(db=>{
    const now=Date.now();t.mock.timers.enable({apis:['Date'],now})
    observeMemory(db,'repo-a',input('ttl','model_switch'))
    observeMemory(db,'repo-a',{...input('feedback','complaint'),summary:'Old caution'})
    improveMemory(db,'repo-a');const probe=countedDatabase(db)
    assert.equal(memoryContext(probe.db,'repo-a',{sessionId:'session-a'}).continuation.length,1)
    memoryContext(probe.db,'repo-a',{sessionId:'session-a'});assert.equal(probe.reads(),1)
    t.mock.timers.setTime(now+86400001)
    assert.equal(memoryContext(probe.db,'repo-a',{sessionId:'session-a'}).handoff,null);assert.equal(probe.reads(),2)
    observeMemory(db,'repo-a',{...input('feedback','complaint'),summary:'Corrected caution',source:{...input('feedback').source,revision:1}})
    assert.equal(memoryContext(probe.db,'repo-a').cautions.length,0,'uncalculated corrected source cannot expose old cached caution')
    improveMemory(db,'repo-a');assert.match(memoryContext(probe.db,'repo-a').cautions[0]!.summary,/Corrected caution/)
    observeMemory(db,'repo-a',{...input('feedback','complaint'),source:{...input('feedback').source,revision:2,tombstone:true}})
    assert.equal(memoryContext(probe.db,'repo-a').cautions.length,0)
    excludeCapture(db,'repo-a','session-a','excluded','test',new Date().toISOString())
    assert.equal(memoryContext(probe.db,'repo-a',{sessionId:'session-a'}).diagnostics[0],'capture_excluded')
  })
})

test('failed extraction keeps durable pending revisions; a new process resumes then skips a clean watermark',async()=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-restart-')),file=join(base,'state.db'),db=openConnection(file)
  try{
    migrateDatabase(db,join(process.cwd(),'migrations'));observeMemory(db,'repo-a',input('restart','complaint'))
    const writer=openConnection(file)
    try{writer.exec('BEGIN IMMEDIATE');assert.equal(improveMemory(db,'repo-a').recorded,false)}finally{writer.exec('ROLLBACK');writer.close()}
    const pending=db.prepare("SELECT source_revision,processed_revision FROM dsh_memory_processing_state WHERE workspace='repo-a'").get<{source_revision:number;processed_revision:number}>()!
    assert.ok(pending.processed_revision<pending.source_revision)
    const script=`import {openConnection} from './src/db/connection.ts';import {improveMemory} from './src/memory/lifecycle.ts';
      const db=openConnection(process.env.MEMORY_TEST_DB);let reads=0;const prepare=db.prepare.bind(db);db.prepare=sql=>{if(sql.includes('SELECT o.* FROM dsh_memory_observations'))reads++;return prepare(sql)};
      const result=improveMemory(db,'repo-a');console.log(JSON.stringify({result,reads}));db.close();`
    const run=()=>{const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,MEMORY_TEST_DB:file},encoding:'utf8'})
      assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout)}
    const resumed=run();assert.equal(resumed.result.recorded,true);assert.equal(resumed.result.skipped,false);assert.equal(resumed.reads,1)
    const restarted=run();assert.equal(restarted.result.skipped,true);assert.equal(restarted.reads,0)
  }finally{db.close();await rm(base,{recursive:true,force:true})}
})

test('unchanged native steps retain one snapshot without history reads/audit appends; model switch and a lost surface refresh it',async()=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-projection-cache-')),root=join(base,'repo');await mkdir(root)
  const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  await runtime.start();let probe:ReturnType<typeof countedDatabase>|undefined,unavailable=false
  const instrumented:any={withDatabase:(fn:any)=>{if(unavailable)return Promise.reject(new Error('storage unavailable'))
    return runtime.withDatabase(db=>{probe??=countedDatabase(db);return fn(probe.db)})}}
  const host=new Host(),{events,session,step}=nativeSurface(host,'cached-native',root)
  let memory=new DshLifecycleMemory(host as any,instrumented,realpathSync(root))
  const snapshots=()=>events.filter(event=>event.type==='user/message'&&event.data.source.sections?.some((section:any)=>section.name==='memory:lifecycle'))
  try{
    await memory.observe({...input('stable','complaint'),cwd:root,sessionId:session.id})
    await step(1);const count=events.length,reads=probe!.reads(),first=snapshots()[0]!.seq
    for(let i=0;i<20;i++){await runtime.withDatabase(db=>db.prepare('UPDATE repositories SET last_used_at=?').run(`ordinary-step-${i}`));await step(1)}
    assert.equal(events.length,count);assert.equal(probe!.reads(),reads);assert.ok(session.surface.nodes.includes(first))
    memory.stop();await memory.whenIdle();memory=new DshLifecycleMemory(host as any,instrumented,realpathSync(root))
    await step(2);assert.equal(events.length,count,'reattachment must reuse the existing equal snapshot')
    session.append('model/selection',{provider:'mock',model:'another'});await memory.whenIdle();await step(2)
    assert.equal(snapshots().length,2);assert.match(snapshots().at(-1)!.data.content[0].text,/model_switch/)
    session.surface.nodes=[session.surface.nodes[0]];await step(3)
    assert.equal(snapshots().length,3);assert.ok(session.surface.nodes.includes(snapshots().at(-1)!.seq),'fresh context must receive the retained memory')
    unavailable=true;assert.equal((await step(4)).kind,'enter')
    const failedEvents=events.length
    for(let i=0;i<10;i++)assert.equal((await step(4)).kind,'enter')
    assert.equal(events.length,failedEvents,'unchanged failure must not append repeated retirement records')
    unavailable=false;await step(4);assert.equal(snapshots().length,4)
  }finally{memory.stop();await memory.whenIdle();await runtime.close();await rm(base,{recursive:true,force:true})}
})


test('first memory follows native acceptance, preserves rejection, and never writes ahead of the system head',async()=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-first-')),root=join(base,'repo');await mkdir(root)
  const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  await runtime.start()
  const host=new Host(),{events,session,agent,step}=nativeSurface(host,'first-native',root)
  const memory=new DshLifecycleMemory(host as any,runtime,realpathSync(root))
  try{
    await memory.observe({...input('first-caution','complaint'),cwd:root,sessionId:session.id,summary:'Initial parser caution'})
    const hook=host.handlers.get('agent/pre-step')![0]!,reject={kind:'reject',reason:'Native admission refused'},empty={kind:'enter',messages:[]}
    assert.equal(await hook({agent,turn:1},async()=>empty),empty,'optional memory must not wake an empty native step')
    assert.equal(events.length,0)
    assert.equal(await hook({agent,turn:1},async()=>reject),reject)
    assert.equal(events.length,0,'a rejected step must not persist optional memory')
    const human={id:'human',role:'user',content:[{type:'text',text:'Explain parser'}],source:{kind:'user'}}
    const accepted={kind:'enter',messages:[human],startsRequestSeries:true}
    const decision=await hook({agent,turn:2},async()=>accepted)
    assert.equal(events.length,0,'only native acceptance may persist first-step messages')
    assert.equal(decision.startsRequestSeries,true);assert.equal(decision.messages[0],human)
    assert.equal(accepted.messages.length,1,'the downstream decision stays caller-owned')
    assert.equal(decision.messages.length,2,'the accepted batch must deliver initial memory')
    assert.match(decision.messages[1].content[0].text,/Initial parser caution/)
    session.append('system/message',{message:{role:'system',content:[{type:'text',text:'Native system prompt'}]}},{surfaceOp:'append'})
    for(const message of decision.messages)session.append('user/message',message,{surfaceOp:'append'})
    const count=events.length
    await step(3);assert.equal(events.length,count,'the committed initial snapshot must be reused')
    await memory.observe({...input('rejected-update','complaint'),cwd:root,sessionId:session.id,summary:'Changed parser caution'})
    assert.equal(await hook({agent,turn:4},async()=>reject),reject)
    assert.equal(events.length,count,'a rejected step must not replace an existing snapshot either')
  }finally{memory.stop();await memory.whenIdle();await runtime.close();await rm(base,{recursive:true,force:true})}
})

test('snapshot replacement and retirement recheck the protected head after asynchronous retrieval',async()=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-head-')),root=join(base,'repo');await mkdir(root)
  const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  await runtime.start()
  const host=new Host(),{events,session,agent,step}=nativeSurface(host,'head-native',root)
  const memory=new DshLifecycleMemory(host as any,runtime,realpathSync(root))
  try{
    await memory.observe({...input('head-caution','complaint'),cwd:root,sessionId:session.id})
    await step()
    const head=session.surface.nodes[0],projection=session.surface.nodes.at(-1),original=memory.context.bind(memory)
    for(const unavailable of [false,true]){
      session.surface.nodes=[head,projection]
      await memory.observe({...input(`head-change-${unavailable}`,'complaint'),cwd:root,sessionId:session.id})
      memory.context=async value=>{const context=await original(value);session.surface.nodes=[projection];return unavailable?{workMayContinue:true,diagnostics:['memory_unavailable']}:context}
      const count=events.length
      const decision=await host.handlers.get('agent/pre-step')![0]!({agent,turn:2},async()=>({kind:'enter',messages:[]}))
      assert.equal(decision.kind,'enter');assert.deepEqual(decision.messages,[])
      assert.equal(events.length,count,'a snapshot promoted to the protected head must not be replaced or retired')
      assert.deepEqual(session.surface.nodes,[projection])
    }
    session.surface.nodes=[head,projection]
    memory.context=async()=>({workMayContinue:true,diagnostics:['memory_unavailable']})
    const count=events.length
    await step(3)
    assert.equal(events.length,count+1,'retirement must retry once the protected system head is restored')
    assert.match(events.at(-1).data.content[0].text,/Local memory reference was retired/)
  }finally{memory.stop();await memory.whenIdle();await runtime.close();await rm(base,{recursive:true,force:true})}
})


for(const change of ['abort','dispose','replace-session'] as const)for(const initial of [true,false])test(`asynchronous ${change} leaves ${initial?'initial':'existing'} memory unchanged`,async()=>{
  const base=await mkdtemp(join(tmpdir(),'lifecycle-ownership-')),root=join(base,'repo');await mkdir(root)
  const runtime=new DshCoreRuntime({repositoryRoot:root,databasePath:join(base,'state.db'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')})
  await runtime.start()
  const host=new Host(),{events,session,agent,step}=nativeSurface(host,'ownership-native',root)
  const memory=new DshLifecycleMemory(host as any,runtime,realpathSync(root))
  try{
    await memory.observe({...input('ownership-caution','complaint'),cwd:root,sessionId:session.id})
    if(!initial)await step()
    await memory.observe({...input('ownership-update','complaint'),cwd:root,sessionId:session.id,summary:'Updated parser caution'})
    const context=await memory.context({cwd:root,sessionId:session.id}),controller=new AbortController()
    let entered!:()=>void,release!:()=>void
    const retrieving=new Promise<void>(resolve=>{entered=resolve})
    memory.context=()=>new Promise(resolve=>{release=()=>resolve(context);entered()})
    const decision={kind:'enter',messages:[humanMessage()]},count=events.length,surface=[...session.surface.nodes]
    const pending=host.handlers.get('agent/pre-step')![0]!({agent,turn:2,signal:controller.signal},async()=>decision)
    await retrieving
    if(change==='abort')controller.abort()
    else if(change==='dispose')memory.stop()
    else host.sessions.set(session.id,{...session})
    release()
    assert.equal(await pending,decision,'stale optional memory must not change the native decision')
    assert.equal(events.length,count);assert.deepEqual(session.surface.nodes,surface)
  }finally{memory.stop();await memory.whenIdle();await runtime.close();await rm(base,{recursive:true,force:true})}
})
