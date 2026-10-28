import { mountNativeExecutor } from '../helpers/native-tools.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {DshLifecycleMemory} from '../../../src/dsh/lifecycle-memory.js'
import {DshCoreRuntime} from '../../../src/dsh/core-runtime.js'
import {agenticReplayFixture} from '../helpers/agenticreplay-fixture.js'
import {nativeMock} from '../helpers/native-mock.js'
const packages=join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const pause=(ms=5)=>new Promise(r=>setTimeout(r,ms))
const wait=async(fn:()=>boolean)=>{const end=Date.now()+10000;while(!fn()&&Date.now()<end)await pause();assert.ok(fn(),'condition not reached')}
const count=(db:any,table:string)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n:0
async function setup(){
  const f=await agenticReplayFixture({shutdownDrainTimeoutMs:3000});execFileSync('git',['init','-q',f.root])
  const mods=await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','user-questions'].map(n=>import(pathToFileURL(join(packages,'@deepseek-ai',n==='cordis'?n:`dsh-${n}`,'lib/index.js')).href)))
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,questions]=mods
  const ctx=new cordis.Context(),fibers:any[]=[],asked:any[]=[],errors:any[]=[]
  for(const plugin of [llm,session,projection,systemPrompt,tools,agents,questions])fibers.push(await ctx.plugin(plugin.default,plugin===systemPrompt?{persona:''}:undefined))
  await mountNativeExecutor(ctx, process.env.KIOKUKO_DSH_PACKAGE_ROOT!, fibers)
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
  const mock=nativeMock(llm);let hold:any,mainCalls=0,answer:(q:any)=>any=()=>{throw Error('no answer configured')}
  class Provider extends llm.LlmAdapter{async listModels(provider:string){return[{provider,id:'mock',name:'mock'}]}async resolveModel(provider:string,id:string){return{provider,id,name:id}}async *stream(q:any){if(q.purpose==='compaction'&&String(q.system).startsWith('Extract compact repository-scoped learning')){assert.deepEqual(q.tools,[]);yield*mock.textResponse(JSON.stringify({lessons:[]}));return}mainCalls++;if(hold)await Promise.race([hold,new Promise((_,reject)=>q.signal.addEventListener('abort',()=>reject(q.signal.reason),{once:true}))]);yield*mock.textResponse('ordinary request completed')}}
  ctx.llm.registerAdapter(['mock'],new Provider());ctx.on('agent/error',(e:any)=>errors.push(e.error),{global:true})
  ctx.on('user-questions/request',(q:any)=>{asked.push(q);return answer(q)},{global:true})
  const agent=await ctx.agentLoop.create(session.SessionId(f.binding.sessionId),{provider:'mock',model:'mock'},{cwd:f.root})
  const runtime=new DshCoreRuntime({repositoryRoot:f.root,databasePath:join(f.root,'index.sqlite3'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')});await runtime.start()
  const workspace=f.database.prepare('SELECT workspace FROM repository_locations JOIN repositories USING(repository_id) WHERE canonical_root=?').get<any>(f.root).workspace
  const now=new Date().toISOString();f.database.prepare(`INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,metadata_json,title,started_at,created_at,updated_at,task_state,task_repository_root) VALUES('native-task',?,?,'1','test','{}','completed','{}','parser inspection',?,?,?,'Done',?)`).run(workspace,agent.session.id,now,now,now,f.root)
  const memory=new DshLifecycleMemory(ctx,runtime,f.root);memory.connectAgenticReplay({config:f.config,withIndex:f.withIndex} as any)
  const binding={...f.binding,kiokukoRunId:'native-task'};const e={token:Symbol(),callId:'native-call',rootCallId:'native-call',name:'bash',arguments:{command:'node parser.mjs'},agent};f.recorder.preTool(binding,e);f.recorder.toolResult(binding,e,{isError:false,value:{exitCode:0,processStarted:true,processStopped:true},content:[{type:'text',text:'result'}]});await f.recorder.closeSessionRecording(agent.session.id,'manual')
  return{...f,ctx,llm,agent,runtime,memory,asked,errors,workspace,setAnswer(fn:typeof answer){answer=fn},hold(){hold=new Promise(()=>{})},get calls(){return mainCalls},async close(){memory.stop();await memory.whenIdle();await runtime.close();for(const fiber of fibers.reverse())await fiber.dispose();await f.dispose()}}
}
const reply=(q:any,label:string)=>({answers:[{id:q.questions[0].id,selected:[label]}]})
test('actual native UserQuestionService receives exact live agent and saves exact approved preview',async()=>{const f=await setup();try{f.setAnswer(q=>reply(q,f.asked.length===1?'整理して確認する':'この内容を保存する'));f.memory.completed('native-task','completed',f.agent.session.id);await f.memory.whenIdle();assert.equal(f.asked.length,2);assert.ok(f.asked.every(q=>q.agent===f.agent));assert.equal(count(f.database,'replay_memories'),1);const p=JSON.parse(f.database.prepare('SELECT proposal_json FROM replay_memories').get<any>().proposal_json);assert.ok(f.asked[1].questions[0].detail.includes(JSON.stringify(p,null,2)));assert.equal(p.attempts[0].outcome,'succeeded');assert.deepEqual(f.errors,[])}finally{await f.close()}})
test('unanswered native review does not block a new ordinary native turn; actual native cancel must cancel review',async()=>{const f=await setup();let release:any;try{f.setAnswer(q=>f.asked.length===1?reply(q,'整理して確認する'):new Promise(r=>{release=()=>r(reply(q,'この内容を保存する'))}));f.memory.completed('native-task','completed',f.agent.session.id);await wait(()=>!!release);assert.equal(count(f.database,'replay_memories'),0);f.agent.followup(f.llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Hello, do ordinary work now.'}]}));await wait(()=>f.calls===1&&f.agent.status==='idle');assert.equal(count(f.database,'replay_memories'),0);f.hold();f.agent.followup(f.llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Start another ordinary turn.'}]}));await wait(()=>f.calls===2&&f.agent.status==='running');f.agent.cancel({kind:'user'},{keepInbox:true});await f.agent.whenIdle();assert.ok(f.agent.session.snapshotEvents().some((e:any)=>e.type==='turn/end'&&e.data.reason?.kind==='aborted'));release();await f.memory.whenIdle();assert.equal(count(f.database,'replay_memories'),0,'explicit native user Stop must not allow late review approval to save')}finally{release?.();await f.close()}})
test('changed terminal generation must invalidate pending native review scope',async()=>{const f=await setup();let release:any;try{f.setAnswer(q=>f.asked.length===1?reply(q,'整理して確認する'):new Promise(r=>{release=()=>r(reply(q,'この内容を保存する'))}));f.memory.completed('native-task','completed',f.agent.session.id,{revision:1,generation:1,repositoryRoot:f.root});await wait(()=>!!release);f.database.prepare("UPDATE ledger_runs SET task_revision=task_revision+1,task_generation=task_generation+1,task_state='Working',status='active' WHERE run_id='native-task'").run();release();await f.memory.whenIdle();assert.equal(count(f.database,'replay_memories'),0,'changed task generation must invalidate reviewed source scope')}finally{release?.();await f.close()}})

test('explicit managed completion remains reviewable after native turn learning is active',async()=>{
  const f=await setup()
  try{
    f.setAnswer(q=>reply(q,f.asked.length===1?'整理して確認する':'この内容を保存する'))
    f.agent.followup(f.llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Complete ordinary native conversation.'}]}))
    await f.agent.whenIdle();await f.memory.whenIdle()
    assert.equal(f.asked.length,0,'ordinary turn learning must not require approval')
    f.memory.completed('native-task','completed',f.agent.session.id)
    await f.memory.whenIdle()
    assert.equal(f.asked.length,2,'explicit managed completion retains organization and exact-preview approval')
    assert.equal(count(f.database,'replay_memories'),1)
    assert.deepEqual(f.errors,[])
  }finally{await f.close()}
})
