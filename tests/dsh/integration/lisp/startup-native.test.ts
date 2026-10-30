import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { openConnection } from '../../../../src/db/connection.js'
import { createDecisionService } from '../../../../src/dsh/decisions/host.js'
import { TaskStartup, TASK_STARTUP_OPTIONS } from '../../../../src/dsh/task-startup.js'
import { dshTurnRequestId } from '../../../../src/dsh/intake-profile-resolver.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { LispConfig, LISP_TOOLS } from '../../../../src/dsh/lisp/contracts.js'
import { LISP_CODING_SERVICE } from '../../../../src/dsh/lisp/coding-choice.js'
import type { LispCodingService } from '../../../../src/dsh/lisp/coding-choice.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'

const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('combined both-ON choice publishes actual Lisp before tool capture; missing Jev auth does not stop Lisp work', {
  skip:!packages||process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires explicit native DSH and SBCL':false,timeout:90000,
},async()=>{
  const [cordis,prompt,tools,scope]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-scope'].map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name,'lib/index.js')).href)))
  const base=await realpath(await mkdtemp(join(tmpdir(),'startup-real-lisp-'))),db=openConnection(join(base,'state.sqlite3'))
  execFileSync('git',['init','-q',base])
  const ctx=new cordis.Context(),fibers:any[]=[]
  const agent:any={id:'startup-agent',session:{id:'startup-session',header:{cwd:base}},status:'idle'}
  workingLispTask(db,{sessionId:agent.session.id,agentId:agent.id,root:base})
  const runtime:any={databasePath:join(base,'state.sqlite3'),withDatabase:async(fn:any)=>fn(db)}
  let surface:Awaited<ReturnType<typeof mountLispSurface>>|undefined,agentScope:any,asks=0
  try{
    fibers.push(await ctx.plugin(prompt.default,{}));await mountNativeTools(ctx,tools,packages!,fibers)
    fibers.push(await ctx.plugin({name:'startup-native-fixture',apply(c:any){
      c.provide('agents',{get:(id:string)=>id===agent.id?agent:undefined,roots:()=>[agent]})
      c.provide('sessions',{get:(id:string)=>id===agent.session.id?agent.session:undefined})
      c.provide('commands',{register:()=>()=>{}})
      c.provide('credentials',{resolve:async()=>undefined})
      c.provide('userQuestions',{ask:async(q:any)=>{asks++;return{answers:[{id:q.questions[0].id,selected:[TASK_STARTUP_OPTIONS[0]]}]}}})
    }}))
    agentScope=scope.createScope(ctx,agent);agent.ctx=agentScope.ctx
    surface=await mountLispSurface(ctx,runtime,LispConfig.parse({enabled:true,executionMode:'development',sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}))
    const decisions=createDecisionService(ctx,runtime)
    const startup=new TaskStartup({decisions,questions:ctx.get('userQuestions'),root:()=>base,lisp:()=>ctx.get(LISP_CODING_SERVICE) as LispCodingService})
    const input={agent,sessionId:agent.session.id,turn:1,task:'Verify Lisp computation',taskType:'research' as const,signal:new AbortController().signal}
    await startup.prepare(input)
    for(const name of LISP_TOOLS)assert.ok(ctx.tools.get(name,agent),`${name} must exist before model tool capture`)
    const outcome=await decisions.evaluate(dshTurnRequestId({dshSessionId:agent.session.id,turn:1}),{purpose:'lisp',state:{},questions:[{id:'q',instructions:'Check',choices:[{id:'yes',description:'Yes'},{id:'unknown',description:'Unknown'}],abstainId:'unknown'}]},input.signal)
    assert.deepEqual(outcome,{status:'fallback',reason:'DECISION_AUTH'})
    const calculated=await executeNativeTool(ctx,packages!,{callId:'startup-calc',name:'lisp_eval',arguments:{operationId:'startup-calc',code:'(+ 40 2)'},agent,signal:input.signal})
    assert.equal(calculated.isError,false,JSON.stringify(calculated));assert.match(JSON.stringify(calculated),/42/)
    await startup.prepare(input);assert.equal(asks,1)
  }finally{
    surface?.stop();await surface?.dispose();await agentScope?.dispose()
    for(const fiber of fibers.reverse())await fiber.dispose()
    db.close();await rm(base,{recursive:true,force:true})
  }
})
