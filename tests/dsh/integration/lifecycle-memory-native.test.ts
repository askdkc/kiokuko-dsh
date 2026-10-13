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

for(const mode of ['full','compiled'] as const)test(`native ${mode}: feedback and compaction persist locally, then reach the next model request and public tag search`,async()=>{
  const f=await nativeSkillFixture({packages,explicit:true,mode,extra,prompts:new DshSkillPrompts({mode})})
  try{
    f.responses.push(f.mock.textResponse('Public parser explanation.'))
    await f.turn('parser の仕組みを説明してください。')
    const session=f.agent.session,start=session.seq
    session.append('model/selection',{provider:'mock',model:'another-model'})
    session.append('compaction/start',{compactionId:'memory-native-compact',turn:null})
    session.append('compaction/summary',{compactionId:'memory-native-compact',summary:[{type:'text',text:'Preserve parser error boundaries.'}],
      shadowedRange:{start:start,end:start},shadowedSeqs:[start],shadowedTokenCount:1,provider:'mock',model:'another-model'})
    session.append('compaction/end',{compactionId:'memory-native-compact',turn:null})
    session.append('feedback/message-put',{sessionId:session.id,item:{messageId:'public-answer',rating:'negative',note:'Parser regression needs explicit assertions',version:'feedback-v1',createdAt:1,updatedAt:1}})
    f.responses.push(...f.mock.prepareWork([(request:any)=>{
      const text=JSON.stringify(request.messages.filter((message:any)=>message.source?.sections?.some((section:any)=>section.name==='memory:lifecycle')))
      assert.match(text,/Parser regression needs explicit assertions/)
      assert.match(text,/Preserve parser error boundaries/)
      assert.match(text,/Untrusted project memory/)
      assert.match(text,/When a procedure or method is unclear, search memory_context/)
      assert.match(request.messages.flatMap((message:any)=>message.content??[]).map((block:any)=>block.text??'').join('\n'),/"scope":"global"/)
      return f.mock.toolCallResponse('local-context','memory_context',{cwd:f.dir,tags:['complaint'],query:'Parser'})
    },(request:any)=>{
      const result=nativeToolResults(request.messages).find(value=>value.toolCallId==='local-context')
      assert.ok(result&&!result.isError,JSON.stringify(result))
      const context=JSON.parse(result.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join(''))
      assert.equal(context.workMayContinue,true);assert.equal(context.cautions.length,1)
      assert.equal(context.cautions[0].verification,'unknown')
      return f.mock.textResponse('Recorded source-backed caution was read.')
    }],'research','memory-prepare',interpretedPreparation(f.mock,'memory-prepare','new','research','research')))
    await f.turn('parser のやり方が分からないので、保存した注意事項と手順を検索してください。')
    const terminal= session.snapshotEvents().filter((event:any)=>event.type==='turn/end').at(-1)
    const beforeClose=openConnection(join(dirname(f.dir),'state.sqlite3'))
    let runId:string
    try {
      const run=beforeClose.prepare("SELECT run_id FROM ledger_runs WHERE dsh_session_id=? AND status='active' ORDER BY started_at DESC LIMIT 1").get<{run_id:string}>(session.id)
      assert.ok(run,'the public preparation must have admitted a real run');runId=run.run_id
    }finally{beforeClose.close()}
    await f.adapter!.host.lifecycle!.closeTurn({runId,status:'completed',sourceEndSeq:terminal.seq,terminalTurn:terminal.data.turn})
    session.append('feedback/message-delete',{sessionId:session.id,messageId:'public-answer'})
    f.responses.push((request:any)=>{
      const text=JSON.stringify(request.messages.filter((message:any)=>message.source?.sections?.some((section:any)=>section.name==='memory:lifecycle')))
      assert.ok(!text.includes('Parser regression needs explicit assertions'),'withdrawn feedback must not be projected on the next request')
      assert.ok(!JSON.stringify(request.messages).includes('Parser regression needs explicit assertions'),'old memory_context tool results must also be retired')
      return f.mock.textResponse('Withdrawal respected.')
    })
    await f.turn('次の説明をお願いします。')
    const db=openConnection(join(dirname(f.dir),'state.sqlite3'))
    try{
      const observations=db.prepare('SELECT observation_json,tombstone FROM dsh_memory_observations').all<{observation_json:string;tombstone:number}>()
      assert.ok(observations.some(row=>JSON.parse(row.observation_json).kind==='model_switch'))
      assert.ok(observations.some(row=>JSON.parse(row.observation_json).kind==='compaction'))
      assert.ok(observations.some(row=>row.tombstone===1))
      const completion=observations.map(row=>JSON.parse(row.observation_json)).find(row=>row.kind==='completion'&&row.source.runId===runId)
      assert.ok(completion,'the committed host close must be saved by the local observer')
      assert.equal(completion.verification,'unknown','a read-only task ending is not a verified implementation result')
    }finally{db.close()}
  }finally{await f.close()}
})

test('native accepted first memory remains readable through JSONL and a resumed agent; rejected steps store no memory',async()=>{
  const f=await nativeSkillFixture({packages,explicit:true,extra,prompts:new DshSkillPrompts({mode:'compiled'})})
  let handle:any,readHandle:any,writer:any,reader:any,off:()=>void=()=>{}
  const errors:unknown[]=[],offError=f.ctx.on('agent/error',({error}:any)=>errors.push(error))
  try{
    const [cordis,{default:jsonl},nativeSession]=await Promise.all(['cordis','dsh-session-persistence-jsonl','dsh-session']
      .map(name=>import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href)))
    const root=join(dirname(f.dir),'history')
    writer=await f.ctx.plugin(jsonl,{root,compression:'none'})
    const readerContext=new cordis.Context()
    reader=await readerContext.plugin(jsonl,{root,compression:'none'})
    const id=nativeSession.SessionId('lifecycle-persisted')
    handle=await f.ctx.agentLoop.createAgent(f.ctx,{sessionId:id,meta:{cwd:f.dir},agentOptions:{provider:'mock',model:'qwen3-coder'}})
    const observed=await f.ctx.tools.get('memory_observe').execute({cwd:f.dir,eventId:'first-native-caution',sessionId:id,kind:'complaint',
      summary:'Initial parser caution must reach the first accepted request',tags:['parser'],outcome:'unknown',verification:'unknown',actions:[],
      source:{producer:'kiokuko-dsh',runId:'first-native-caution',eventIds:['public:first-native-caution']}})
    assert.equal(observed.recorded,true)
    const turn=async(text:string)=>{handle.agent.followup(f.llm.createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));await handle.agent.whenIdle();assert.deepEqual(errors,[])}
    off=handle.agent.ctx.on('agent/pre-step',async()=>({kind:'reject'}))
    await turn('parser の仕組みを説明してください。')
    assert.equal(handle.agent.session.surface.nodes.length,0,'native rejection must preserve the empty surface')
    assert.equal(handle.agent.session.snapshotEvents().filter((event:any)=>event.type==='user/message').length,0)
    off();off=()=>{}
    f.responses.push((request:any)=>{
      const memory=request.messages.filter((message:any)=>message.source?.sections?.some((section:any)=>section.name==='memory:lifecycle'))
      assert.equal(memory.length,1);assert.match(JSON.stringify(memory),/Initial parser caution must reach the first accepted request/)
      return f.mock.textResponse('Initial memory delivered.')
    })
    await turn('parser の仕組みを説明してください。')
    assert.equal(f.responses.length,0,'the accepted native request must reach the mock model')
    const session=handle.agent.session
    assert.equal(session.eventAt(session.surface.nodes[0]).type,'system/message')
    await f.ctx.sessions.flush(session)
    readHandle=await readerContext.sessionPersistence.open(id,'read')
    assert.deepEqual((await readHandle.read()).events,session.snapshotEvents(),'a separate JSONL reader validates the real persisted log')
    await readHandle.close();readHandle=undefined
    const previousCount=session.snapshotEvents().filter((event:any)=>event.type==='user/message'&&event.data.source?.sections?.some((section:any)=>section.name==='memory:lifecycle')).length
    await handle.dispose();handle=undefined
    handle=await f.ctx.agentLoop.resume(f.ctx,{resumeSessionId:id,agentOptions:{provider:'mock',model:'qwen3-coder'}})
    f.responses.push((request:any)=>{
      assert.match(JSON.stringify(request.messages),/Initial parser caution must reach the first accepted request/)
      return f.mock.textResponse('Persisted memory restored.')
    })
    await turn('次の説明をお願いします。')
    assert.equal(f.responses.length,0,'the resumed native model request must run')
    const resumed=handle.agent.session
    assert.equal(resumed.eventAt(resumed.surface.nodes[0]).type,'system/message')
    assert.equal(resumed.snapshotEvents().filter((event:any)=>event.type==='user/message'&&event.data.source?.sections?.some((section:any)=>section.name==='memory:lifecycle')).length,previousCount,'reattachment reuses the stored snapshot')
    await f.ctx.sessions.flush(resumed)
    readHandle=await readerContext.sessionPersistence.open(id,'read')
    assert.deepEqual((await readHandle.read()).events,resumed.snapshotEvents())
  }finally{
    off();offError()
    try{await readHandle?.close()}finally{try{await handle?.dispose()}finally{try{await reader?.dispose()}finally{try{await writer?.dispose()}finally{await f.close()}}}}
  }
})
