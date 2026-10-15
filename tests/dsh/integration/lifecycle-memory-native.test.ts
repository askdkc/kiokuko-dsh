import {approveFixtureMemory} from '../helpers/approved-fixture-memory.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {openConnection} from '../../../src/db/connection.js'
import {nativeSkillFixture} from '../helpers/skill-native.js'
import {nativeToolResults} from '../helpers/native-mock.js'
import {interpretedPreparation} from '../helpers/coding-script.js'
import {isolateSkillHome} from '../helpers/skill-home.js'
import {DshSkillPrompts} from '../../../src/dsh/skill-prompts.js'

isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const extra={lisp:{enabled:false},typedDecisions:{mode:'off'},modelHandoff:{mode:'off'},answerReview:{mode:'off'},memoryReview:{mode:'off'},
  memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}}

for(const mode of ['full','compiled'] as const)test(`native ${mode}: feedback and compaction retain raw history without unapproved memory, and explicit search stays optional`,async()=>{
 const f=await nativeSkillFixture({packages,explicit:true,mode,extra,prompts:new DshSkillPrompts({mode})})
 try{
  f.responses.push(f.mock.textResponse('Public parser explanation.'));await f.turn('parser の仕組みを説明してください。')
  const session=f.agent.session,start=session.seq
  session.append('model/selection',{provider:'mock',model:'another-model'})
  session.append('compaction/start',{compactionId:'native-compact',turn:null})
  session.append('compaction/summary',{compactionId:'native-compact',summary:[{type:'text',text:'Preserve parser error boundaries.'}],shadowedRange:{start,end:start},shadowedSeqs:[start],shadowedTokenCount:1,provider:'mock',model:'another-model'})
  session.append('compaction/end',{compactionId:'native-compact',turn:null})
  session.append('feedback/message-put',{sessionId:session.id,item:{messageId:'public-answer',rating:'negative',note:'Parser regression needs explicit assertions',version:'feedback-v1',createdAt:1,updatedAt:1}})
  f.responses.push(f.mock.toolCallResponse('local-context','memory_context',{cwd:f.dir,query:'Parser'}),(request:any)=>{
   const result=nativeToolResults(request.messages).find(value=>value.toolCallId==='local-context');assert.ok(result&&!result.isError,JSON.stringify(result))
   const context=JSON.parse(result.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join(''));assert.equal(context.workMayContinue,true);assert.deepEqual(context.replay,[])
   return f.mock.textResponse('No approved memory; ordinary work continues.')
  })
  await f.turn('parser の保存した記憶を検索してください。')
  const observed=await f.ctx.tools.get('memory_observe').execute({cwd:f.dir,eventId:'unapproved-model-suggestion',summary:'Do not auto-save this suggestion'})
  assert.equal(observed.recorded,false)
  session.append('feedback/message-delete',{sessionId:session.id,messageId:'public-answer'})
  const db=openConnection(join(dirname(f.dir),'state.sqlite3'))
  try{for(const table of ['entries','dsh_memory_observations','ledger_runs'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<any>()!.n,0,table)}finally{db.close()}
  assert.ok(session.snapshotEvents().some((event:any)=>event.type==='compaction/summary'));assert.ok(session.snapshotEvents().some((event:any)=>event.type==='feedback/message-delete'));assert.equal(f.responses.length,0)
 }finally{await f.close()}
})

test('approved first memory survives JSONL/reopened native agent; rejected steps store no model-visible snapshot',async()=>{
 const f=await nativeSkillFixture({packages,explicit:true,extra,prompts:new DshSkillPrompts({mode:'compiled'})})
 let handle:any,readHandle:any,writer:any,reader:any,off:()=>void=()=>{}
 const errors:unknown[]=[],offError=f.ctx.on('agent/error',({error}:any)=>errors.push(error))
 try{
  const [cordis,jsonlModule,nativeSession]=await Promise.all(['cordis','dsh-session-persistence-jsonl','dsh-session'].map(name=>import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href)))
  const jsonl=jsonlModule.default??jsonlModule,root=join(dirname(f.dir),'history');writer=await f.ctx.plugin(jsonl,{root,compression:'none'})
  const readerContext=new cordis.Context();reader=await readerContext.plugin(jsonl,{root,compression:'none'})
  const id=nativeSession.SessionId('lifecycle-persisted'),body='Initial parser caution comes only from exact human approval'
  const db=openConnection(join(dirname(f.dir),'state.sqlite3'));try{const workspace=db.prepare('SELECT workspace FROM repositories LIMIT 1').get<any>()!.workspace;await approveFixtureMemory(db,workspace,body,['parser'])}finally{db.close()}
  handle=await f.ctx.agentLoop.createAgent(f.ctx,{sessionId:id,meta:{cwd:f.dir},agentOptions:{provider:'mock',model:'qwen3-coder'}})
  const turn=async()=>{handle.agent.followup(f.llm.createUserMessage({content:[{type:'text',text:'parser の仕組みを説明してください。'}],source:{kind:'user'}}));await handle.agent.whenIdle();assert.deepEqual(errors,[])}
  off=handle.agent.ctx.on('agent/pre-step',async()=>({kind:'reject'}));await turn();assert.equal(handle.agent.session.surface.nodes.length,0);assert.equal(handle.agent.session.snapshotEvents().filter((event:any)=>event.type==='user/message').length,0)
  off();off=()=>{}
  const inspect=(request:any)=>{const memory=request.messages.filter((message:any)=>message.source?.sections?.some((section:any)=>section.name==='memory:approved-replay'));assert.equal(memory.length,1);assert.match(JSON.stringify(memory),/Initial parser caution/);return f.mock.textResponse('Approved source read.')}
  f.responses.push(inspect);await turn();const session=handle.agent.session;await f.ctx.sessions.flush(session)
  readHandle=await readerContext.sessionPersistence.open(id,'read');assert.deepEqual((await readHandle.read()).events,session.snapshotEvents());await readHandle.close();readHandle=undefined
  await handle.dispose();handle=undefined
  handle=await f.ctx.agentLoop.resume(f.ctx,{resumeSessionId:id,agentOptions:{provider:'mock',model:'qwen3-coder'}})
  f.responses.push(inspect);await turn();assert.equal(f.responses.length,0)
  const resumed=handle.agent.session;await f.ctx.sessions.flush(resumed);readHandle=await readerContext.sessionPersistence.open(id,'read');assert.deepEqual((await readHandle.read()).events,resumed.snapshotEvents())
 }finally{off();offError();try{await readHandle?.close()}finally{try{await handle?.dispose()}finally{try{await reader?.dispose()}finally{try{await writer?.dispose()}finally{await f.close()}}}}}
})
