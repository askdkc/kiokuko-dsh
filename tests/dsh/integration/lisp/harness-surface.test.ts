import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {NodeSqliteAdapter} from '../../../../src/db/adapter.js'
import {migrateDatabase} from '../../../../src/db/migrate.js'
import {mountLispSurface} from '../../../../src/dsh/lisp/surface.js'
import {LispConfig} from '../../../../src/dsh/lisp/contracts.js'
import {LISP_ASSEMBLY_SERVICE,type LispAssemblyService} from '../../../../src/dsh/lisp/request-surface.js'
import * as harness from '../../../../src/dsh/harness/index.js'
import {mountNativeTools,executeNativeTool} from '../../helpers/native-tools.js'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import { CompiledLispCache } from '../../../../src/dsh/lisp/compiled-cache.js'
import { rootLispAdmission } from '../../../../src/dsh/lisp-tool-identity.js'

test('replacement child owns a persistent runtime, never parent authority or denied native tools (no SBCL)',async t=>{
 const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
 const modules=await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','commands','agent'].map(n=>import(pathToFileURL(join(packages,'@deepseek-ai',n==='cordis'?n:`dsh-${n}`,'lib/index.js')).href)))
 const [cordis,llm,sessions,projections,prompt,tools,commands,agents]=modules,ctx=new cordis.Context(),fibers:any[]=[]
 const base=await realpath(await mkdtemp(join(tmpdir(),'harness-lisp-scope-'))),root=join(base,'workspace')
 await mkdir(root);await mkdir(join(root,'.git'));await writeFile(join(root,'input.json'),'[20,22]')
 const db=new NodeSqliteAdapter(join(base,'state.sqlite3'),new DatabaseSync(join(base,'state.sqlite3')));migrateDatabase(db)
 let surface:Awaited<ReturnType<typeof mountLispSurface>>|undefined,writes=0
 const workers:LispWorker[]=[],stopped=new WeakSet<LispWorker>()
 t.mock.method(CompiledLispCache.prototype,'ensure',async()=>({key:'transport-fixture',path:base,reused:true,prepareMs:0}))
 t.mock.method(LispWorker.prototype,'start',async function(this:LispWorker){workers.push(this)})
 t.mock.getter(LispWorker.prototype,'healthy',function(this:LispWorker){return !stopped.has(this)})
 t.mock.getter(LispWorker.prototype,'stopped',function(this:LispWorker){return stopped.has(this)})
 t.mock.method(LispWorker.prototype,'stop',async function(this:LispWorker){stopped.add(this)})
 t.mock.method(LispWorker.prototype,'request',async()=>({version:1,type:'result',id:'fixture',ok:true,value:{printed:'(:PROTECTED)',json:null},proposals:[]}))
 try{
  for(const m of [llm,sessions,projections,prompt,tools,commands,agents]){if(m===tools)await mountNativeTools(ctx,tools,packages,fibers);else fibers.push(await ctx.plugin(m.default,m===prompt?{persona:''}:undefined))}
  fibers.push(await ctx.plugin(harness))
  ctx.tools.register(tools.defineTool({name:'write',description:'Fixture effect',parameters:{content:{type:'string',required:true}},output:{schema:{type:'object',properties:{},additionalProperties:false},render:()=>[]},execute:async()=>{writes++;return{}}}))
  surface=await mountLispSurface(ctx,{withDatabase:async(fn:any)=>fn(db)} as any,LispConfig.parse({enabled:true,executionMode:'development'}))
  const parent=await ctx.agents.create({sessionId:sessions.SessionId('lisp-parent'),meta:{cwd:root}})
  const service=ctx.get(LISP_ASSEMBLY_SERVICE) as LispAssemblyService,assembly={sections:[],variables:{},tools:[]} as any
  const disabled=await service.project(parent.agent,{...assembly,tools:ctx.tools.schemas(parent.agent)}) as any
  assert.equal(disabled.tools.some((tool:any)=>tool.name==='lisp_eval'),false,'Unbound descriptors stay out of disabled model requests')
  const unavailable=await executeNativeTool(ctx,packages,{callId:'disabled-eval',name:'lisp_eval',arguments:{operationId:'disabled',code:'(+ 1 1)'},agent:parent.agent,signal:new AbortController().signal})
  assert.equal(unavailable.isError,true);assert.equal(workers.length,0)
  const parentOwner={sessionId:parent.agent.id,agentId:parent.agent.id,root};await surface.manager.enableTask(parentOwner)
  await service.project(parent.agent,assembly)
  const child=await parent.agent.ctx.agents.create({sessionId:sessions.SessionId('lisp-child'),parentAgent:parent.agent,meta:{cwd:root,origin:'subagent',parentSession:parent.agent.id,delegationDepth:1},setup:async(c:any)=>{c.tools.restrict({allow:['lisp_observe','lisp_status','lisp_inspect','lisp_hot_call','lisp_hot_status']})}})
  const childAssembly=await ctx.systemPrompt.assemble({agent:child.agent,scope:child.agent})
  const projected=await service.project(child.agent,childAssembly) as any,childOwner={sessionId:child.agent.id,agentId:child.agent.id,root}
  assert.equal(await surface.manager.isTaskMode(childOwner),false,'Each routed child owns a persistent Lisp worker instead of disposable task mode')
  assert.equal(workers.length,1)
  assert.equal(workers[0]!.layout.workspace,undefined,'Siblings must not compete for the standalone repository lease')
  assert.equal((await surface.manager.status(childOwner) as any).generation,workers[0]!.generation)
  await service.project(child.agent,childAssembly)
  assert.equal(workers.length,1,'Repeated assembly retains the same worker')
  const visible=ctx.tools.schemas(child.agent).map((s:any)=>s.name)
  assert.ok(visible.includes('lisp_observe'));assert.ok(!visible.includes('lisp_eval'));assert.ok(!visible.includes('lisp_apply'));assert.ok(!visible.includes('write'))
  assert.ok(projected.tools.some((tool:any)=>tool.name==='lisp_observe'))
  const read=await executeNativeTool(ctx,packages,{callId:'child-observation',name:'lisp_observe',arguments:{operationId:'observe',paths:['input.json'],format:'json'},agent:child.agent,signal:new AbortController().signal})
  assert.equal(read.isError,false,JSON.stringify(read));assert.match(JSON.stringify(read),/resultRef/)
  const admissions=new Map<string,boolean>()
  const removeWitness=ctx.on('tools/execute',async(execution:any,next:()=>Promise<unknown>)=>{
    admissions.set(execution.callId,!!rootLispAdmission(execution));return next()
  },{global:true})
  try{
    const statusCall={name:'lisp_status',arguments:{},agent:child.agent,signal:new AbortController().signal}
    await executeNativeTool(ctx,packages,{...statusCall,callId:'child-root-status'})
    await executeNativeTool(ctx,packages,{...statusCall,callId:'child-nested-status',parent:Symbol('nested')})
    assert.equal(admissions.get('child-root-status'),true,'Only the exact admitted native root receives a worker command capability')
    assert.equal(admissions.get('child-nested-status'),false,'Nested calls cannot borrow the worker capability')
  }finally{removeWitness()}
  const denied=await executeNativeTool(ctx,packages,{callId:'child-write',name:'write',arguments:{content:'bad'},agent:child.agent,signal:new AbortController().signal})
  assert.equal(denied.isError,true);assert.equal(writes,0)
  await surface.manager.taskAuthority.run(childOwner,async()=>{await assert.rejects(surface!.manager.taskAuthority.authorizeEffect(childOwner),{code:'TASK_REQUIRED'})})
  const impostor=await ctx.agents.create({sessionId:sessions.SessionId('forged-child'),meta:{cwd:root,origin:'subagent',parentSession:parent.agent.id,delegationDepth:1}})
  await service.project(impostor.agent,assembly)
  assert.equal(surface.manager.enabled.has(impostor.agent.id),false,'Durable lineage alone is not live runtime ownership')
  await child.dispose();assert.equal(surface.manager.enabled.has(parent.agent.id),true)
  assert.equal(stopped.has(workers[0]!),true,'Session disposal stops its own runtime')
 }finally{surface?.stop();await surface?.dispose();for(const f of fibers.reverse())await f.dispose();await ctx.fiber.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
