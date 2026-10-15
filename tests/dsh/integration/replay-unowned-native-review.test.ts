import assert from 'node:assert/strict'
import test,{mock} from 'node:test'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {DshLifecycleMemory} from '../../../src/dsh/lifecycle-memory.js'
import {DshCoreRuntime} from '../../../src/dsh/core-runtime.js'
import {createDshAgenticReplayHost} from '../../../src/dsh/agenticreplay-host.js'
import {DshAgenticReplayReadService} from '../../../src/dsh/agenticreplay-read-service.js'
import {AgenticReplayConfig} from '../../../src/dsh/config.js'
import {agenticReplayFixture} from '../helpers/agenticreplay-fixture.js'
import {nativeMock,nativeToolResults} from '../helpers/native-mock.js'
const packages=join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const load=(n:string)=>import(pathToFileURL(join(packages,'@deepseek-ai',n==='cordis'?n:`dsh-${n}`,'lib/index.js')).href)
const pause=(ms=5)=>new Promise(r=>setTimeout(r,ms));const wait=async(fn:()=>boolean)=>{const end=Date.now()+10000;while(!fn()&&Date.now()<end)await pause();assert.ok(fn(),'condition not reached')}
const count=(db:any,table:string)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n:0
for(const decision of ['approve','decline','new-request','stop'] as const)test(`actual unowned native Bash -> final answer -> optional review: ${decision}`,async()=>{
 const f=await agenticReplayFixture({shutdownDrainTimeoutMs:3000});execFileSync('git',['init','-q',f.root]);const [cordis,llm,session]=await Promise.all(['cordis','llm','session'].map(load));const ctx=new cordis.Context(),fibers:any[]=[],asked:any[]=[],errors:any[]=[];let runtime:any,memory:any,replay:any,release:any,mainCalls=0,toolObserved=false,extractions=0
 const original=DshAgenticReplayReadService.prototype.memoryEvidence;assert.equal(typeof original,'function','Native replay memory evidence reader is installed');const extraction=mock.method(DshAgenticReplayReadService.prototype,'memoryEvidence',function(this:any,...args:any[]){extractions++;return original.apply(this,args as any)})
 try{
 for(const name of ['llm','session','session-projection','system-prompt','tools','agent','user-questions','working-directory','fs-local','subprocess-local','bash-local','shell-env','tool-bash']){const plugin=await load(name);fibers.push(await ctx.plugin(plugin.default??plugin,name==='system-prompt'?{persona:''}:name==='working-directory'?{defaultDirectory:f.root}:name==='fs-local'||name==='bash-local'?{cwd:f.root}:name==='shell-env'?{dshHome:f.root}:undefined))}
 const loop=await load('agent-loop');fibers.push(await ctx.plugin(loop.default,{agents:[]}));const native=nativeMock(llm)
 class Provider extends llm.LlmAdapter{async listModels(provider:string){return[{provider,id:'mock',name:'mock'}]}async resolveModel(provider:string,id:string){return{provider,id,name:id}}async *stream(q:any){mainCalls++;if(mainCalls===1){yield*native.toolCallResponse('unowned-command','bash',{command:'printf UNOWNED_NATIVE_RESULT',description:'Read a harmless fixed result'});return}if(mainCalls===2){const r=nativeToolResults(q.messages).find((v:any)=>v.toolCallId==='unowned-command');assert.ok(r&&!r.isError,JSON.stringify(r));assert.match(JSON.stringify(r.content),/UNOWNED_NATIVE_RESULT/);toolObserved=true;assert.equal(count(f.database,'ledger_runs'),0);assert.equal(count(f.database,'entries'),0);assert.equal(extractions,0);assert.equal(asked.length,0)}yield*native.textResponse('The requested command finished and printed UNOWNED_NATIVE_RESULT.')}}
 ctx.llm.registerAdapter(['mock'],new Provider());ctx.on('agent/error',(e:any)=>errors.push(e.error),{global:true});ctx.on('user-questions/request',(q:any)=>{asked.push(q);const id=q.questions[0].id;if(asked.length===1){assert.equal(extractions,0);assert.equal(count(f.database,'replay_memories'),0);if(decision==='decline')return{answers:[{id,selected:['今回は保存しない']}]};if(decision==='new-request'||decision==='stop')return new Promise(r=>{release=()=>r({answers:[{id,selected:['整理して確認する']}]})});return{answers:[{id,selected:['整理して確認する']}]}}return{answers:[{id,selected:['この内容を保存する']}] }},{global:true})
 runtime=new DshCoreRuntime({repositoryRoot:f.root,databasePath:join(f.root,'index.sqlite3'),autoRegisterRepository:true,migrationsDirectory:join(process.cwd(),'migrations')});await runtime.start()
 replay=createDshAgenticReplayHost(ctx,AgenticReplayConfig.parse({enabled:true,askOnStart:false,shutdownDrainTimeoutMs:3000}),runtime,{session:id=>ctx.sessions.get(id),agent:id=>ctx.agents.get(id),logicalRun:()=>undefined,questions:ctx.userQuestions})
 memory=new DshLifecycleMemory(ctx,runtime,f.root);memory.connectAgenticReplay(replay)
 const agent=await ctx.agentLoop.create(session.SessionId(f.binding.sessionId),{provider:'mock',model:'mock'},{cwd:f.root});agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Run printf UNOWNED_NATIVE_RESULT and tell me what it printed.'}]}));await wait(()=>toolObserved&&agent.status==='idle');await wait(()=>asked.length>0)
 if(decision==='new-request'){agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'New request: just say hello.'}]}));await wait(()=>mainCalls===3&&agent.status==='idle');release();}
 if(decision==='stop'){agent.cancel({kind:'user'},{keepInbox:true});release();}
 await memory.whenIdle();assert.equal(count(f.database,'ledger_runs'),0);assert.equal(count(f.database,'replay_memories'),decision==='approve'?1:0);assert.equal(count(f.database,'entries'),decision==='approve'?1:0);assert.equal(extractions,decision==='approve'?1:0);assert.deepEqual(errors,[])
 if(decision==='approve'){const p=JSON.parse(f.database.prepare('SELECT proposal_json FROM replay_memories').get<any>().proposal_json);assert.ok(p.attempts.some((a:any)=>a.command==='printf UNOWNED_NATIVE_RESULT'));assert.ok(asked[1].questions[0].detail.includes(JSON.stringify(p,null,2)))}
 }finally{release?.();memory?.stop();await memory?.whenIdle();await replay?.shutdown();await runtime?.close();for(const fiber of fibers.reverse())await fiber.dispose();extraction.mock.restore();await f.dispose()}
})
