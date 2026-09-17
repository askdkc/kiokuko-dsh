import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdtemp, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { nativeMock } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const enabled = Boolean(packages) && process.env.KIOKUKO_TEST_COMPILED_SKILLS === '1'
// The general suite includes a build/pack test that replaces dist. Run compiled
// delivery in its dedicated, serialized job so fallback cannot mask a build race.
const native = { skip: enabled ? false : 'run npm run test:skill-delivery', timeout: 60000 }
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packages) throw new Error('Skill delivery requires the pinned native runtime')
const subject: typeof import('../../../src/dsh/index.js') = await import(packageRoot
  ? pathToFileURL(join(packageRoot,'dist/index.js')).href : '../../../src/dsh/index.js')
const artifact = enabled ? JSON.parse(await readFile(join(packageRoot ?? process.cwd(),'dist/dsh/skill-prompts.json'),'utf8')) : {resources:[]}
const content = (name: string) => artifact.resources.find((r: any) => r.id === `${name}/SKILL.md`).content as string
const names: string[] = artifact.resources.filter((r: any) => r.id.endsWith('/SKILL.md')).map((r: any) => r.id.slice(0,-'/SKILL.md'.length))
const textOf = (request: any): string => [request.system ?? '', ...request.messages.flatMap((m: any) => m.content.flatMap((b: any) =>
  b.type === 'text' ? [b.text] : b.type === 'tool-result' ? b.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text) : []))].join('\n')
function requireBody(request: any, name: string) { assert.ok(textOf(request).includes(content(name)), `${name}: compiled body absent at adapter boundary`) }

async function fixture(explicit: boolean|'prompt-only', mode: 'full'|'compiled' = 'compiled', extra: object = {}) {
  const modules = await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill','tool-skill','commands','subagent','subagent-spawn-in-process']
    .map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name==='cordis'?name:`dsh-${name}`,'lib/index.js')).href)))
  const [cordis,llm,session,projection,prompt,tools,agents,loop,skills,skillTool,commands,subagents,spawn]=modules
  const dir = await realpath(await mkdtemp(join(tmpdir(),'skill-delivery-'))), previousData = process.env.KIOKUKO_DATA_DIR
  process.env.KIOKUKO_DATA_DIR = dir
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  fibers.push(await ctx.plugin({name:'headless-web-connection',apply(c:any){return c.provide('connection',{fetch:{register:()=>()=>{}}})}}))
  if('lisp' in extra)fibers.push(await ctx.plugin({name:'delivery-intent-answer',apply(c:any){return c.provide('userQuestions',{ask:async(r:any)=>({answers:r.questions.map((q:any)=>{assert.equal(q.id,'taskType');return{id:q.id,selected:['chat']}})})})}}))
  const initial=explicit==='prompt-only'?[llm,prompt,skills]:[llm,session,projection,prompt,tools,agents,skills,commands,subagents,skillTool]
  for(const m of initial) fibers.push(await ctx.plugin(m.default??m, m===prompt?{persona:''}:undefined))
  if(explicit!=='prompt-only'){fibers.push(await ctx.plugin(loop.default,{agents:[]}));fibers.push(await ctx.plugin(spawn,{providerName:'spawn'}))}
  const responses: any[] = [], model = new mock.MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'],model)
  let adapter: ReturnType<typeof subject.createDshHostAdapter> | undefined
  if(explicit===true) {
    adapter = subject.createDshHostAdapter(ctx,{databasePath:join(dir,'state.sqlite3'),repositoryRoot:dir,orca:{enabled:false}})
    fibers.push(await ctx.plugin({name:'explicit-skill-host',apply(c:any){return c.provide('kiokukoDsh',adapter!.host)}}))
  }
  let plugin = await ctx.plugin(subject,{enabled:true,skillPrompts:{mode},orca:{enabled:false},...extra})
  if(explicit==='prompt-only'){
    for(const m of [session,projection,tools,agents,commands,skillTool])fibers.push(await ctx.plugin(m.default??m))
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
  }
  const agent = await ctx.agentLoop.create(session.SessionId('skill-main'),{provider:'mock',model:'qwen3-coder'},{cwd:dir})
  const errors: unknown[]=[]
  const off=ctx.on('agent/error',(e:any)=>errors.push(e.error))
  const turn=async(input='この内容を日本語で説明してください。')=>{agent.followup(llm.createUserMessage({content:[{type:'text',text:input}],source:{kind:'user'}}));await agent.whenIdle();assert.deepEqual(errors,[])}
  return {ctx,agent,model,responses,mock,turn,adapter,dir,llm,
    async reload(nextMode: 'full'|'compiled') { await plugin.dispose(); plugin=await ctx.plugin(subject,{enabled:true,skillPrompts:{mode:nextMode},orca:{enabled:false},...extra}) },
    async close(){off();await plugin.dispose();await adapter?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();if(previousData===undefined)delete process.env.KIOKUKO_DATA_DIR;else process.env.KIOKUKO_DATA_DIR=previousData;await rm(dir,{recursive:true,force:true})} }
}

for(const explicit of [false,true]) test(`compiled Skill delivery: production entrypoint (${explicit?'explicit':'native'} host), every native skill lookup`,native,async()=>{
  const f=await fixture(explicit)
  try {
    f.responses.push(f.mock.textResponse('説明します。'));await f.turn()
    requireBody(f.model.requests[0],'kiokuko-soul');requireBody(f.model.requests[0],'natural-japanese-output')
    for(const name of names) {
      f.responses.push(f.mock.toolCallResponse(`load-${name}`,'skill',{name}),f.mock.textResponse('確認しました。'))
      await f.turn(`利用可能な ${name} の内容を説明してください。`)
      requireBody(f.model.requests.at(-1),name)
      assert.ok(f.model.requests.at(-1).messages.some((m:any)=>m.content.some((b:any)=>b.type==='tool-result')), 'must traverse native tool result')
    }
    assert.ok(artifact.resources.some((r:any)=>r.representation==='compiled'))
  } finally { await f.close() }
})

test('compiled Skill delivery: prompt-only entrypoint has reachable native prompt and Skill consumers',native,async()=>{
  const f=await fixture('prompt-only')
  try {
    f.responses.push(f.mock.toolCallResponse('read-lisp','skill',{name:'kiokuko-lisp'}),f.mock.textResponse('確認'))
    await f.turn();requireBody(f.model.requests[0],'kiokuko-soul');requireBody(f.model.requests.at(-1),'kiokuko-lisp')
  } finally {await f.close()}
})

test('compiled Skill delivery: reload, full rollback, model switch and compacted surface',native,async()=>{
  const f=await fixture(false)
  try {
    f.responses.push(f.mock.textResponse('初回'));await f.turn()
    const before=f.agent.session.snapshotEvents().length
    const nodes=[...f.agent.session.surface.nodes]
    for(const seq of nodes){const event=f.agent.session.eventAt(seq);if(event.type!=='user/message')continue
      f.agent.session.append('user/message',f.llm.createUserMessage({content:[{type:'text',text:'Earlier conversation compacted.'}],source:{kind:'plugin',plugin:'test-compaction'}}),
        {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]})}
    f.responses.push(f.mock.textResponse('継続'));await f.turn();requireBody(f.model.requests.at(-1),'kiokuko-soul')
    assert.ok(f.agent.session.snapshotEvents().length>before)
    await f.reload('full');f.responses.push(f.mock.textResponse('全文'));await f.turn()
    const full=await readFile(join(packageRoot??process.cwd(),'skills/kiokuko-soul/SKILL.md'),'utf8')
    assert.ok(textOf(f.model.requests.at(-1)).includes(full))
    await f.reload('compiled');f.agent.options.model='gpt-fixture';f.responses.push(f.mock.textResponse('English'));await f.turn('Explain in English.')
    requireBody(f.model.requests.at(-1),'kiokuko-soul')
    const req=f.model.requests.at(-1)
    const system=req.system??req.messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.content).map((b:any)=>b.text??'').join('\n')
    assert.ok(!system.includes(content('natural-japanese-output')))
  } finally { await f.close() }
})

test('delivery counterexample: artifact present but disconnected system injection fails the same assertion',native,async()=>{
  const f=await fixture(false)
  const disconnect=f.ctx.on('system-prompt/assemble',async(_a:any,_c:any,next:()=>Promise<any>)=>{const a=await next();return{...a,sections:a.sections.filter((s:any)=>s.name!=='kiokuko:soul')}} ,{prepend:true,global:true})
  try {
    f.responses.push(f.mock.textResponse('説明'));await f.turn()
    assert.throws(()=>requireBody(f.model.requests.at(-1),'kiokuko-soul'),/compiled body absent/u)
    requireBody(f.model.requests.at(-1),'natural-japanese-output')
  } finally {disconnect();await f.close()}
})

test('delivery counterexample: disconnected native Skill reader is caught while automatic SOUL still arrives',native,async t=>{
  const f=await fixture(false)
  const original=subject.DshSkillPrompts.prototype.get
  const disconnect=t.mock.method(subject.DshSkillPrompts.prototype,'get',async function(this: InstanceType<typeof subject.DshSkillPrompts>,name:string,path?:string){
    return name==='kiokuko-lisp'?undefined:original.call(this,name,path)
  })
  try {
    f.responses.push(f.mock.toolCallResponse('disconnected-read','skill',{name:'kiokuko-lisp'}),f.mock.textResponse('取得できませんでした。'))
    await f.turn()
    assert.equal(f.model.requests.length,2)
    requireBody(f.model.requests.at(-1),'kiokuko-soul')
    assert.throws(()=>requireBody(f.model.requests.at(-1),'kiokuko-lisp'),/compiled body absent/u)
  } finally {disconnect.mock.restore();await f.close()}
})

test('compiled Skill delivery: protected Lisp enable and lisp_describe reach the native model',{
  ...native,skip:!enabled||process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1',timeout:180000,
},async()=>{
  const f=await fixture(false,'compiled',{lisp:{enabled:true,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}})
  try {
    const enabled=await f.ctx.commands.execute(f.agent,'/kioku-lisp enable',[],new AbortController().signal)
    assert.equal(enabled.result.kind,'success',JSON.stringify(enabled.result))
    f.responses.push(f.mock.toolCallResponse('describe-lisp','lisp_describe',{operationId:'describe-guide'}),f.mock.textResponse('Lisp APIを確認しました。'))
    await f.turn()
    assert.equal(f.model.requests.length,2,'Lisp must reach the model, execute describe, then deliver its result')
    requireBody(f.model.requests[0],'kiokuko-lisp')
    const last=f.model.requests.at(-1)
    const results=last.messages.flatMap((m:any)=>m.content).filter((b:any)=>b.type==='tool-result')
    assert.ok(results.some((b:any)=>b.content.some((c:any)=>c.type==='text'&&JSON.parse(c.text).guide===content('kiokuko-lisp'))), 'lisp_describe guide must survive result rendering')
    assert.deepEqual(last.tools.map((t:any)=>t.name).sort(),['lisp_cancel','lisp_describe','lisp_eval','lisp_inspect','lisp_reset','lisp_status'])
  } finally {await f.close()}
})

test('compiled Skill delivery: real DeepSeek serializer sends the bodies in the HTTP payload',native,async t=>{
  const f=await fixture(false)
  const provider=await import(pathToFileURL(join(packages!,'@deepseek-ai/dsh-llm-deepseek/lib/index.js')).href)
  const wire:any[]=[]
  const http=t.mock.method(globalThis,'fetch',async(url:any,options:any)=>{
    assert.equal(String(url),'https://skill-delivery.invalid/chat/completions')
    wire.push(JSON.parse(options.body))
    return new Response(`data: ${JSON.stringify({id:'test',choices:[{index:0,delta:{content:'確認しました。'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'test',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:10}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
  })
  const adapter=new provider.DeepSeekAdapter({options:()=>provider.resolveAdapterOptions({baseURL:'https://skill-delivery.invalid',thinking:'disabled',reasoningEffort:'off'}),resolveApiKey:async()=> 'fixture-key',resolveUserId:()=> 'fixture-user',prepareExtensions:async()=>({fields:{},accept:async()=>{}})})
  const off=f.ctx.llm.registerAdapter(['deepseek-official'],adapter)
  try {
    f.agent.options.provider='deepseek-official';f.agent.options.model='deepseek-v4-pro'
    await f.turn()
    assert.ok(wire.length>0)
    const sent=wire[0].messages.map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n')
    assert.ok(sent.includes(content('kiokuko-soul')))
    assert.ok(sent.includes(content('natural-japanese-output')))
    assert.equal(sent.split(content('kiokuko-soul')).length-1,1)
    assert.equal(sent.split(content('natural-japanese-output')).length-1,1)
  } finally {off();http.mock.restore();await f.close()}
})
