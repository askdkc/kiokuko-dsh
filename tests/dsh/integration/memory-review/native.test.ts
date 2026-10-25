import { mountNativeExecutor } from '../../helpers/native-tools.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../../src/dsh/composition.js'
import { nativeMock } from '../../helpers/native-mock.js'
import { interpretedPreparation, toolValue } from '../../helpers/coding-script.js'
import { approveFixtureMemory } from '../../helpers/approved-fixture-memory.js'
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT

for(const intakeMode of ['on-demand','eager','legacy-owner'] as const)for(const mode of ['off','observe','active'] as const)test(`${intakeMode==='legacy-owner'?'legacy-owner native T01/T06/T11/T39: open chat stays unsaved until explicit approval, then retrieves and forgets':`${intakeMode} native: ordinary answers do not open a review execution`} with ennoMemory=${mode}`, {skip:!packages,timeout:30000},async()=>{
  const modules=await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill','commands'].map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name==='cordis'?name:`dsh-${name}`,'lib/index.js')).href)))
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,skills,commands]=modules
  const root=await mkdtemp(join(tmpdir(),'native-memory-review-'));await mkdir(join(root,'.git'))
  const ctx=new cordis.Context(),fibers:any[]=[]
  let releaseLegacyOwner:(()=>void)|undefined
  let adapter:ReturnType<typeof createDshHostAdapter>|undefined,composition:Awaited<ReturnType<typeof mountDshComposition>>|undefined
  try{
    for(const plugin of [llm,session,projection,systemPrompt,tools,agents,skills,commands])fibers.push(await ctx.plugin(plugin.default,plugin===systemPrompt?{persona:''}:undefined))
    await mountNativeExecutor(ctx, process.env.KIOKUKO_DSH_PACKAGE_ROOT!, fibers)
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
    fibers.push(await ctx.plugin({name:'review-questions',apply(context:any){return context.provide('userQuestions',{async ask(request:any){return {answers:request.questions.map((q:any)=>({id:q.id,selected:[q.id==='enno-execution-mode'?'通常実行':'chat']}))}}})}}))
    const mock=nativeMock(llm)
    let mainCalls=0,reviewCalls=0,explainNext:string|undefined,prepareExplanation=false
    const requests:any[]=[];const errors:string[]=[];ctx.on('agent/error',(event:any)=>errors.push(String(event.error?.message)))
    class Provider extends llm.LlmAdapter {
      async listModels(provider:string){return [{provider,id:'fixed',name:'fixed'}]}
      async resolveModel(provider:string,id:string){return {provider,id,name:id,context:{contextWindow:200000}}}
      async *stream(request:any){
        requests.push(request)
        if(request.system?.startsWith('Review durable project memories')){
          reviewCalls++;assert.deepEqual(request.tools,[])
          const input=JSON.parse(request.messages[0].content[0].text)
          yield*mock.textResponse(JSON.stringify({schemaVersion:2,proposals:[{action:'add',kind:'preference',title:'EMBERLANG 日本語',body:'EMBERLANGプロジェクトの応答言語設定は日本語。',evidenceIds:[input.evidence[0].id],claims:[{id:'language',text:'EMBERLANGプロジェクトの応答言語設定は日本語。',evidence:[{evidenceId:input.evidence[0].id,supportingText:input.evidence[0].text}]}]}]}))
        }else if(request.purpose==='compaction'&&/^(Extract up to|Return JSON array|Check each supplied)/.test(request.system??'')){
          // Default index reasoning is active; its background calls are separate
          // from ordinary responses and Memory Review's own extraction.
          assert.deepEqual(request.tools,[])
          yield*mock.textResponse('[]')
        }else if(prepareExplanation){prepareExplanation=false;yield*interpretedPreparation(mock,'prepare-explanation','new','research','research')(request)
        }else if(explainNext){assert.equal(toolValue(request,'prepare-explanation').prepared,true);const entryId=explainNext;explainNext=undefined;yield*mock.toolCallResponse('explain-memory','memory_explain',{entryId})
        }else{mainCalls++;yield*mock.textResponse('回答しました。')}
      }
    }
    ctx.llm.registerAdapter(['review-native'],new Provider())
    // A real native durability listener snapshots only the prefix present on entry.
    const persisted:any[]=[]
    ctx.on('session/flush',(s:any)=>{persisted.splice(0,persisted.length,...s.snapshotEvents());return Promise.resolve()})
    // Disabling decisions defers interpretation to the model in eager mode too.
    // A legacy owner is seeded separately to cover historical chat-ledger review.
    adapter=createDshHostAdapter(ctx,{...(intakeMode!=='on-demand'?{intakeMode:'eager',typedDecisions:{mode:'off'}}:{}),repositoryRoot:root,databasePath:join(root,'state.sqlite3'),agenticReplay:{enabled:false},ennoMemory:{mode}})
    composition=await mountDshComposition(ctx,adapter.host)
    if(intakeMode==='legacy-owner'){
      const seeded=new Set<string>()
      releaseLegacyOwner=ctx.on('agent/pre-step',async(payload:any,next:()=>Promise<unknown>)=>{
        if(['native-review','native-held'].includes(payload.agent.session.id)&&!seeded.has(payload.agent.session.id)){
          seeded.add(payload.agent.session.id)
          const {requestIntent:_intent,...event}=await adapter!.host.mapPreStep!(payload)
          // Reconstruct a chat owner accepted by the pre-conversation-first host.
          // Keep the real current ingress for all subsequent native turns.
          const admitted=await adapter!.host.intakeGate!.prepare({...event,profileHints:{taskType:'chat'},
            deferTaskTypeInference:false,memoryOwner:'conversation'})
          assert.equal(admitted.admitted,true,'the legacy owner fixture must be admitted')
          assert.equal(admitted.prepared.intake.profile.taskType,'chat')
        }
        return next()
      },{prepend:true})
    }
    const excluded=await ctx.agentLoop.create(session.SessionId('native-excluded'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    assert.equal((await adapter.host.memoryReview!.command(excluded.session,'exclude session')).state,'excluded')
    assert.equal(((await adapter.host.memoryReview!.command(excluded.session,'status')).capture as {mode:string}).mode,'excluded')
    const agent=await ctx.agentLoop.create(session.SessionId('native-review'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    const wait=async(check:()=>boolean|Promise<boolean>)=>{const until=Date.now()+10000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,10))}assert.fail('native review condition timed out: '+JSON.stringify(errors))}
    for(let turn=1;turn<=8;turn++){
      agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:`EMBERLANGプロジェクトでは回答に日本語を使う。 ${turn}`}]}))
      await wait(()=>agent.status==='idle'&&mainCalls===turn)
    }
    if(intakeMode!=='legacy-owner'){
      assert.equal(reviewCalls,0,'ordinary answers must not dispatch run-bound memory review')
      assert.equal(adapter.host.resolveSessionRunId!(agent.session),undefined)
      const counts=await adapter.host.runtime!.withDatabase(db=>Object.fromEntries(['ledger_runs','task_memory_bindings','memory_review_jobs']
        .map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n])))
      assert.deepEqual(counts,{ledger_runs:0,task_memory_bindings:0,memory_review_jobs:0})
      assert.deepEqual(errors,[])
      return
    }
    assert.equal(reviewCalls,0,'historical chat ownership cannot start an automatic review model call')
    const runId=adapter.host.resolveSessionRunId!(agent.session)!
    assert.equal(await adapter.host.resolveIdleClose!(agent.id,agent.session.id,agent.session,agent),undefined)
    const beforeApproval=await adapter.host.runtime!.withDatabase(db=>({entries:db.prepare('SELECT count(*) AS n FROM entries').get<{n:number}>()!.n,
      jobs:db.prepare('SELECT count(*) AS n FROM memory_review_jobs').get<{n:number}>()!.n}))
    assert.deepEqual(beforeApproval,{entries:0,jobs:0},'eight normal turns and a legacy owner still save nothing without permission')
    const saved=await adapter.host.runtime!.withDatabase(async db=>{
      const workspace=db.prepare('SELECT r.workspace FROM repositories r JOIN repository_locations l USING(repository_id) WHERE l.canonical_root=?').get<{workspace:string}>(realpathSync(root))!.workspace
      return await approveFixtureMemory(db,workspace,'EMBERLANGプロジェクトの応答言語設定は日本語。',['EMBERLANG','日本語'])
    })
    const approvedLookup=await ctx.tools.get('memory_context').execute({cwd:root,query:'EMBERLANG の回答言語は？'})
    assert.ok(JSON.stringify(approvedLookup.replay).includes('EMBERLANGプロジェクトの応答言語設定は日本語'),JSON.stringify({savedWorkspace:saved.workspace,approvedLookup,agentOwned:ctx.agents.get(agent.id)===agent,sessionOwned:ctx.sessions.get(agent.session.id)===agent.session}))
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'EMBERLANG の回答言語は？'}]}))
    await wait(()=>agent.status==='idle'&&mainCalls===9)
    assert.equal(adapter.host.resolveSessionRunId!(agent.session),runId)
    const final=requests.filter(r=>!r.system?.startsWith('Review durable')).at(-1)
    assert.match(JSON.stringify(final.messages),/EMBERLANGプロジェクトの応答言語設定は日本語/)
    const delivered=await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM context_delivery_entries WHERE entry_id=?').get<{n:number}>(saved.id)!.n)
    assert.equal(delivered,0,'conversational retrieval must not create execution delivery receipts')
    const memorySnapshots=final.messages.filter((message:any)=>message.source?.form==='snapshot')
      .flatMap((message:any)=>message.source.sections??[]).filter((section:any)=>section.name==='memory:approved-replay')
    assert.ok(memorySnapshots.length>0,'only the explicitly approved replay may enter a source-bound snapshot')
    assert.match(JSON.stringify(memorySnapshots),/EMBERLANGプロジェクトの応答言語設定は日本語/)
    await ctx.sessions.flush(agent.session)
    assert.ok(persisted.length>0)
    // Explaining stored evidence is independently requested tool-backed work.
    // Exclude further capture before preparing it; the saved memory remains usable.
    assert.equal((await adapter.host.memoryReview!.command(agent.session,'exclude session')).state,'excluded')
    const inspector=await ctx.agentLoop.create(session.SessionId('native-inspector'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    assert.equal((await adapter.host.memoryReview!.command(inspector.session,'exclude session')).state,'excluded')
    explainNext=saved.id;prepareExplanation=true
    inspector.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'保存した根拠を確認して。'}]}))
    await wait(()=>inspector.status==='idle'&&mainCalls===10)
    const explained=await ctx.commands.execute(inspector, `/kioku-memory explain ${saved.id} --json`, [], new AbortController().signal)
    assert.equal(explained.result.kind,'success',explained.result.text);assert.equal(JSON.parse(explained.result.text).evidenceStatus,'details_unavailable',
      'the test-human preference must not claim an execution trace')
    const forgotten=await ctx.commands.execute(inspector, `/kioku-memory forget ${saved.id} --revision 1 --json`, [], new AbortController().signal)
    assert.equal(forgotten.result.kind,'success',forgotten.result.text)
    agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'EMBERLANG の回答言語は？'}]}))
    await wait(()=>agent.status==='idle'&&mainCalls===11)
    const afterForget=requests.filter(r=>r.purpose!=='compaction').at(-1)
    assert.doesNotMatch(JSON.stringify(afterForget.messages),/EMBERLANGプロジェクトの応答言語設定は日本語/)
    assert.equal(await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM context_delivery_entries WHERE entry_id=?').get<{n:number}>(saved.id)!.n),0)
    assert.equal(await adapter.host.runtime!.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM memory_explain_receipts WHERE entry_id=?').get<{n:number}>(saved.id)!.n),1)
    const command=await adapter.host.memoryReview!.command(agent.session,'exclude session')
    assert.equal(command.state,'excluded')
    assert.equal(reviewCalls,0)
    const held=await ctx.agentLoop.create(session.SessionId('native-held'),{provider:'review-native',model:'fixed'},{cwd:root,delegationDepth:0})
    held.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Please do not remember this example.'}]}))
    await wait(()=>held.status==='idle'&&mainCalls===12)
    const notice=await adapter.host.runtime!.withDatabase(db=>db.prepare("SELECT text FROM dsh_session_notices WHERE dsh_session_id=? AND kind='status'").get<{text:string}>(held.session.id))
    assert.match(notice?.text??'',/kioku-memory-review exclude session/)
    assert.equal(((await adapter.host.memoryReview!.command(held.session,'status')).capture as {mode:string}).mode,'held')
  }finally{releaseLegacyOwner?.();await composition?.dispose();await adapter?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
