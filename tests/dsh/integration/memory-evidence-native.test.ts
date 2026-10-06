import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { mountCore } from '../../../src/dsh/core/host.js'
import { openConnection } from '../../../src/db/connection.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { nativeMock } from '../helpers/native-mock.js'
import { createRun } from './evolution/fixture.js'

const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT
if(process.env.KIOKUKO_REQUIRE_DSH_NATIVE==='1'&&!packages)throw new Error('Memory lifecycle requires native DSH')
test('native modular core: explain before review, explicit forget and next-request retirement', {skip:!packages,timeout:30000},async()=>{
  const [cordis,llm,session,projection,prompt,tools,agents,loop,skills,commands]=await Promise.all(
    ['cordis','dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-skill','dsh-commands']
      .map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name,'lib/index.js')).href)))
  const root=await mkdtemp(join(tmpdir(),'memory-native-core-')),databasePath=join(root,'state.sqlite3'),ctx=new cordis.Context(),fibers:any[]=[]
  let handle:Awaited<ReturnType<typeof mountCore>>|undefined
  const requests:any[]=[];const errors:unknown[]=[]
  try {
    for(const plugin of [llm,session,projection,prompt,tools,agents,skills,commands])fibers.push(await ctx.plugin(plugin.default,plugin===prompt?{persona:''}:undefined))
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
    fibers.push(await ctx.plugin({name:'core-memory-questions',apply(c:any){return c.provide('userQuestions',{async ask(request:any){return {answers:request.questions.map((q:any)=>({id:q.id,selected:['chat']}))}}})}}))
    handle=await mountCore(ctx,{repositoryRoot:root,databasePath,answerReview:{mode:'off'},memoryIndexReasoning:{mode:'off'}})
    const db=openConnection(databasePath),workspace=db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{workspace:string}>()!.workspace
    const memory=recordEntry(db,{workspace,kind:'preference',title:'CYCLEROOT response',body:'CYCLEROOT answer uses exactly three sentences.',scope:{visibility:'project'}})
    createRun(db,'foreign','other-workspace')
    const foreign=recordEntry(db,{workspace:'other-workspace',kind:'fact',title:'foreign',body:'PRIVATE_FOREIGN_MEMORY'})
    db.close()
    const mock=nativeMock(llm);let explain=true
    class Provider extends llm.LlmAdapter {
      async listModels(provider:string){return [{provider,id:'fixed',name:'fixed'}]}
      async resolveModel(provider:string,id:string){return {provider,id,name:id,context:{contextWindow:200000}}}
      async *stream(request:any){
        requests.push(request)
        if(request.purpose==='compaction'){yield*mock.textResponse('{"schemaVersion":4,"memoryOperations":[]}');return}
        if(explain){explain=false;yield*mock.toolCallResponse('core-explain','memory_explain',{entryId:memory.id});return}
        yield*mock.textResponse('Acknowledged.')
      }
    }
    ctx.llm.registerAdapter(['core-memory'],new Provider())
    ctx.on('agent/error',(event:any)=>errors.push({message:event.error?.message,stack:event.error?.stack}))
    const agent=await ctx.agentLoop.create(session.SessionId('memory-core'),{provider:'core-memory',model:'fixed'},{cwd:root})
    const turn=async()=>{agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'CYCLEROOTの回答設定を説明して。'}]}));await agent.whenIdle();assert.deepEqual(errors,[])}
    await turn()
    assert.ok(requests.some(r=>r.tools?.some((tool:any)=>tool.name==='memory_explain')))
    const shown=await ctx.commands.execute(agent,`/kioku-memory explain ${memory.id} --json`,[],new AbortController().signal)
    assert.equal(shown.result.kind,'success',shown.result.text)
    assert.equal(JSON.parse(shown.result.text).evidenceStatus,'details_unavailable')
    const denied=await ctx.commands.execute(agent,`/kioku-memory explain ${foreign.id} --json`,[],new AbortController().signal)
    assert.equal(denied.result.kind,'error')
    const deniedForget=await ctx.commands.execute(agent,`/kioku-memory forget ${foreign.id} --revision 1`,[],new AbortController().signal)
    assert.equal(deniedForget.result.kind,'error')
    const forgotten=await ctx.commands.execute(agent,`/kioku-memory forget ${memory.id} --revision 1 --json`,[],new AbortController().signal)
    assert.equal(forgotten.result.kind,'success',forgotten.result.text)
    await turn()
    assert.doesNotMatch(JSON.stringify(requests.filter(r=>r.purpose!=='compaction').at(-1).messages),/CYCLEROOT answer uses exactly three sentences/)
    const stored=openConnection(databasePath)
    try {assert.equal(stored.prepare('SELECT count(*) AS n FROM memory_explain_receipts WHERE entry_id=?').get(memory.id)?.n,1)
      assert.equal(stored.prepare('SELECT count(*) AS n FROM context_delivery_entries WHERE entry_id=?').get(memory.id)?.n,0)
      assert.equal(stored.prepare('SELECT count(*) AS n FROM memory_forget_tombstones WHERE entry_id=?').get(foreign.id)?.n,0)}finally{stored.close()}
    const raceDb=openConnection(databasePath)
    const late=recordEntry(raceDb,{workspace,kind:'fact',title:'CYCLELATE',body:'CYCLELATE private memory assembled before forgetting.',scope:{visibility:'project'}})
    raceDb.close()
    let raced=false
    const releaseFence=agent.ctx.on('llm/stream',(request:any,next:()=>AsyncIterable<unknown>)=>(async function*(){
      if(!raced&&request.purpose!=='compaction'&&JSON.stringify(request.messages).includes(late.body)){
        raced=true
        const result=await ctx.commands.execute(agent,`/kioku-memory forget ${late.id} --revision 1`,[],new AbortController().signal)
        assert.equal(result.result.kind,'success',result.result.text)
      }
      yield*next()
    })(),{prepend:true})
    try{
      agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'CYCLELATE の内容を確認してください'}]}));await agent.whenIdle()
      assert.equal(raced,true,'forget must occur after native request assembly')
      assert.ok(!requests.some(r=>JSON.stringify(r.messages).includes(late.body)),'the provider must never receive the retired snapshot')
      assert.ok(errors.some(e=>String((e as {message?:string}).message).includes('after request assembly')))
      errors.splice(0)
      await turn()
      assert.ok(!JSON.stringify(requests.at(-1).messages).includes(late.body))
    }finally{releaseFence()}
  }finally{await handle?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
