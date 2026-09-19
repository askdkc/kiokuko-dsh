import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../../src/dsh/composition.js'
import { nativeMock } from '../../helpers/native-mock.js'
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT

for(const mode of ['off','observe','active'] as const)test(`native T01/T06/T11/T39: open chat saves and retrieves on the next request with ennoMemory=${mode}`, {skip:!packages,timeout:30000},async()=>{
  const modules=await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill'].map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name==='cordis'?name:`dsh-${name}`,'lib/index.js')).href)))
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,skills]=modules
  const root=await mkdtemp(join(tmpdir(),'native-memory-review-'));await mkdir(join(root,'.git'))
  const ctx=new cordis.Context(),fibers:any[]=[]
  let adapter:ReturnType<typeof createDshHostAdapter>|undefined,composition:Awaited<ReturnType<typeof mountDshComposition>>|undefined
  try{
    for(const plugin of [llm,session,projection,systemPrompt,tools,agents,skills])fibers.push(await ctx.plugin(plugin.default,plugin===systemPrompt?{persona:''}:undefined))
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
    fibers.push(await ctx.plugin({name:'review-questions',apply(context:any){return context.provide('userQuestions',{async ask(request:any){return {answers:request.questions.map((q:any)=>({id:q.id,selected:['chat']}))}}})}}))
    const mock=nativeMock(llm)
    let mainCalls=0,reviewCalls=0
    const requests:any[]=[]
    class Provider extends llm.LlmAdapter {
      async listModels(provider:string){return [{provider,id:'fixed',name:'fixed'}]}
      async resolveModel(provider:string,id:string){return {provider,id,name:id,context:{contextWindow:200000}}}
      async *stream(request:any){
        requests.push(request)
        if(request.system?.startsWith('Review durable project memories')){
          reviewCalls++;assert.deepEqual(request.tools,[])
          const input=JSON.parse(request.messages[0].content[0].text)
          yield*mock.textResponse(JSON.stringify({schemaVersion:1,proposals:[{action:'add',kind:'preference',title:'EMBERLANG 日本語',body:'EMBERLANGプロジェクトの応答言語設定は日本語。',evidenceIds:[input.evidence[0].id]}]}))
        }else{mainCalls++;yield*mock.textResponse('回答しました。')}
      }
    }
    ctx.llm.registerAdapter(['review-native'],new Provider())
    // A real native durability listener snapshots only the prefix present on entry.
    const persisted:any[]=[]
    ctx.on('session/flush',(s:any)=>{persisted.splice(0,persisted.length,...s.snapshotEvents());return Promise.resolve()})
    adapter=createDshHostAdapter(ctx,{repositoryRoot:root,databasePath:join(root,'state.sqlite3'),orca:{enabled:false},ennoMemory:{mode}})
    composition=await mountDshComposition(ctx,adapter.host)
    const excluded=await ctx.agentLoop.create(session.SessionId('native-excluded'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    assert.equal((await adapter.host.memoryReview!.command(excluded.session,'exclude session')).state,'excluded')
    assert.equal(((await adapter.host.memoryReview!.command(excluded.session,'status')).capture as {mode:string}).mode,'excluded')
    const agent=await ctx.agentLoop.create(session.SessionId('native-review'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    const wait=async(check:()=>boolean|Promise<boolean>)=>{const until=Date.now()+10000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,10))}assert.fail('native review condition timed out')}
    for(let turn=1;turn<=8;turn++){
      agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:`EMBERLANGプロジェクトでは回答に日本語を使う。 ${turn}`}]}))
      await wait(()=>agent.status==='idle'&&mainCalls===turn)
    }
    await wait(async()=>await adapter!.host.runtime!.withDatabase(db=>db.prepare("SELECT count(*) AS n FROM memory_review_jobs WHERE state='completed'").get()?.n===1))
    assert.equal(reviewCalls,1)
    const runId=adapter.host.resolveSessionRunId!(agent.session)!
    assert.equal(await adapter.host.resolveIdleClose!(agent.id,agent.session.id,agent.session,agent),undefined)
    const saved=await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT id FROM entries').get<{id:string}>())
    assert.ok(saved)
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'EMBERLANG の回答言語は？'}]}))
    await wait(()=>agent.status==='idle'&&mainCalls===9)
    assert.equal(adapter.host.resolveSessionRunId!(agent.session),runId)
    const final=requests.filter(r=>!r.system?.startsWith('Review durable')).at(-1)
    assert.match(JSON.stringify(final.messages),/EMBERLANGプロジェクトの応答言語設定は日本語/)
    const delivered=await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM context_delivery_entries WHERE entry_id=?').get<{n:number}>(saved.id)!.n)
    assert.ok(delivered>0,'new memory must be selected, not merely echoed from native chat history')
    assert.ok(persisted.length>0)
    const command=await adapter.host.memoryReview!.command(agent.session,'exclude session')
    assert.equal(command.state,'excluded')
    assert.equal(reviewCalls,1)
    const held=await ctx.agentLoop.create(session.SessionId('native-held'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    held.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Please do not remember this example.'}]}))
    await wait(()=>held.status==='idle'&&mainCalls===10)
    const notice=await adapter.host.runtime!.withDatabase(db=>db.prepare("SELECT text FROM dsh_session_notices WHERE dsh_session_id=? AND kind='status'").get<{text:string}>(held.session.id))
    assert.match(notice?.text??'',/kioku-memory-review exclude session/)
    assert.equal(((await adapter.host.memoryReview!.command(held.session,'status')).capture as {mode:string}).mode,'held')
  }finally{await composition?.dispose();await adapter?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
