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

test('replacement child inherits a calculation surface, never parent authority or denied native tools (no SBCL)',async()=>{
 const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
 const modules=await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','commands','agent'].map(n=>import(pathToFileURL(join(packages,'@deepseek-ai',n==='cordis'?n:`dsh-${n}`,'lib/index.js')).href)))
 const [cordis,llm,sessions,projections,prompt,tools,commands,agents]=modules,ctx=new cordis.Context(),fibers:any[]=[]
 const base=await realpath(await mkdtemp(join(tmpdir(),'harness-lisp-scope-'))),root=join(base,'workspace')
 await mkdir(root);await mkdir(join(root,'.git'));await writeFile(join(root,'input.json'),'[20,22]')
 const db=new NodeSqliteAdapter(join(base,'state.sqlite3'),new DatabaseSync(join(base,'state.sqlite3')));migrateDatabase(db)
 let surface:Awaited<ReturnType<typeof mountLispSurface>>|undefined,writes=0
 try{
  for(const m of [llm,sessions,projections,prompt,tools,commands,agents]){if(m===tools)await mountNativeTools(ctx,tools,packages,fibers);else fibers.push(await ctx.plugin(m.default,m===prompt?{persona:''}:undefined))}
  fibers.push(await ctx.plugin(harness))
  ctx.tools.register(tools.defineTool({name:'write',description:'Fixture effect',parameters:{content:{type:'string',required:true}},output:{schema:{type:'object',properties:{},additionalProperties:false},render:()=>[]},execute:async()=>{writes++;return{}}}))
  surface=await mountLispSurface(ctx,{withDatabase:async(fn:any)=>fn(db)} as any,LispConfig.parse({enabled:true,executionMode:'development'}))
  const parent=await ctx.agents.create({sessionId:sessions.SessionId('lisp-parent'),meta:{cwd:root}})
  const parentOwner={sessionId:parent.agent.id,agentId:parent.agent.id,root};await surface.manager.enableTask(parentOwner)
  const service=ctx.get(LISP_ASSEMBLY_SERVICE) as LispAssemblyService,assembly={sections:[],variables:{},tools:[]} as any
  await service.project(parent.agent,assembly)
  const child=await parent.agent.ctx.agents.create({sessionId:sessions.SessionId('lisp-child'),parentAgent:parent.agent,meta:{cwd:root,origin:'subagent',parentSession:parent.agent.id,delegationDepth:1},setup:async(c:any)=>{c.tools.restrict({allow:['lisp_observe','lisp_status','lisp_inspect','lisp_hot_call','lisp_hot_status']})}})
  const childAssembly=await ctx.systemPrompt.assemble({agent:child.agent,scope:child.agent})
  const projected=await service.project(child.agent,childAssembly) as any,childOwner={sessionId:child.agent.id,agentId:child.agent.id,root}
  assert.equal(await surface.manager.isTaskMode(childOwner),true,'Child gets its own scratch/function mode without starting a repository worker')
  const visible=ctx.tools.schemas(child.agent).map((s:any)=>s.name)
  assert.ok(visible.includes('lisp_observe'));assert.ok(!visible.includes('lisp_eval'));assert.ok(!visible.includes('lisp_apply'));assert.ok(!visible.includes('write'))
  assert.ok(projected.tools.some((tool:any)=>tool.name==='lisp_observe'))
  const read=await executeNativeTool(ctx,packages,{callId:'child-observation',name:'lisp_observe',arguments:{operationId:'observe',paths:['input.json'],format:'json'},agent:child.agent,signal:new AbortController().signal})
  assert.equal(read.isError,false,JSON.stringify(read));assert.match(JSON.stringify(read),/resultRef/)
  const denied=await executeNativeTool(ctx,packages,{callId:'child-write',name:'write',arguments:{content:'bad'},agent:child.agent,signal:new AbortController().signal})
  assert.equal(denied.isError,true);assert.equal(writes,0)
  await surface.manager.taskAuthority.run(childOwner,async()=>{await assert.rejects(surface!.manager.taskAuthority.authorizeEffect(childOwner),{code:'TASK_REQUIRED'})})
  const impostor=await ctx.agents.create({sessionId:sessions.SessionId('forged-child'),meta:{cwd:root,origin:'subagent',parentSession:parent.agent.id,delegationDepth:1}})
  await service.project(impostor.agent,assembly)
  assert.equal(surface.manager.enabled.has(impostor.agent.id),false,'Durable lineage alone is not live runtime ownership')
  await child.dispose();assert.equal(surface.manager.enabled.has(parent.agent.id),true)
 }finally{surface?.stop();await surface?.dispose();for(const f of fibers.reverse())await f.dispose();await ctx.fiber.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
