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
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'

const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT
for (const executionMode of ['development', 'protected'] as const) test(
  `combined both-ON choice starts independent ${executionMode} Lisp workers in the same repository without Jev auth`, {
  skip:!packages||process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires explicit native DSH and SBCL':false,timeout:90000,
},async()=>{
  const [cordis,prompt,tools,scope]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-scope'].map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name,'lib/index.js')).href)))
  const base=await realpath(await mkdtemp(join(tmpdir(),'startup-real-lisp-'))),db=openConnection(join(base,'state.sqlite3'))
  execFileSync('git',['init','-q',base])
  const ctx=new cordis.Context(),fibers:any[]=[]
  const makeAgent = (id: string) => ({
    id, session: { id, header: { cwd: base } }, status: 'idle', ctx: undefined as any,
  })
  const agent = makeAgent('first'), other = makeAgent('second')
  const agents = [agent, other]
  const runtime:any={databasePath:join(base,'state.sqlite3'),withDatabase:async(fn:any)=>fn(db)}
  const owners = agents.map(candidate => ({sessionId:candidate.session.id,agentId:candidate.id,root:base}))
  let surface:Awaited<ReturnType<typeof mountLispSurface>>|undefined,asks=0
  const agentScopes: any[] = []
  try{
    for (const owner of owners) workingLispTask(db, owner)
    // A previous startup can leave a saved Lisp preference without a live worker.
    await new LispStore(runtime.withDatabase).enable(owners[1]!)
    fibers.push(await ctx.plugin(prompt.default,{}));await mountNativeTools(ctx,tools,packages!,fibers)
    fibers.push(await ctx.plugin({name:'startup-native-fixture',apply(c:any){
      c.provide('agents',{get:(id:string)=>agents.find(candidate=>candidate.id===id),roots:()=>agents})
      c.provide('sessions',{get:(id:string)=>agents.find(candidate=>candidate.session.id===id)?.session})
      c.provide('commands',{register:()=>()=>{}})
      c.provide('credentials',{resolve:async()=>undefined})
      c.provide('userQuestions',{ask:async(q:any)=>{asks++;return{answers:[{id:q.questions[0].id,selected:[TASK_STARTUP_OPTIONS[0]]}]}}})
    }}))
    for (const candidate of agents) {
      const agentScope = scope.createScope(ctx, candidate)
      candidate.ctx = agentScope.ctx
      agentScopes.push(agentScope)
    }
    surface=await mountLispSurface(ctx,runtime,LispConfig.parse({enabled:true,executionMode,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}))
    const decisions=createDecisionService(ctx,runtime)
    const startup=new TaskStartup({decisions,questions:ctx.get('userQuestions'),root:()=>base,lisp:()=>ctx.get(LISP_CODING_SERVICE) as LispCodingService})
    const input={agent,sessionId:agent.session.id,turn:1,task:'Verify Lisp computation',taskType:'research' as const,signal:new AbortController().signal}
    await startup.prepare(input)
    await startup.prepare({...input,agent:other,sessionId:other.session.id})
    for (const candidate of agents)
      for(const name of LISP_TOOLS)assert.ok(ctx.tools.get(name,candidate),`${name} must exist before model tool capture`)
    const outcome=await decisions.evaluate(dshTurnRequestId({dshSessionId:agent.session.id,turn:1}),{purpose:'lisp',state:{},questions:[{id:'q',instructions:'Check',choices:[{id:'yes',description:'Yes'},{id:'unknown',description:'Unknown'}],abstainId:'unknown'}]},input.signal)
    assert.deepEqual(outcome,{status:'fallback',reason:'DECISION_AUTH'})
    const evaluate = (candidate: typeof agent, id: string, code: string) => executeNativeTool(ctx,packages!,{
      callId:id,name:'lisp_eval',arguments:{operationId:id,code},agent:candidate,signal:input.signal,
    })
    const calculated=await evaluate(agent,'startup-calc','(defparameter *startup-value* 42) *startup-value*')
    assert.equal(calculated.isError,false,JSON.stringify(calculated));assert.match(JSON.stringify(calculated),/\(42\)/)
    const isolated=await evaluate(other,'startup-isolated',"(if (boundp '*startup-value*) 99 17)")
    assert.equal(isolated.isError,false,JSON.stringify(isolated));assert.match(JSON.stringify(isolated),/\(17\)/)
    const [first, second] = await Promise.all(owners.map(owner=>surface!.manager.status(owner))) as any[]
    assert.ok(first.runtimePid && second.runtimePid)
    assert.notEqual(first.runtimePid,second.runtimePid)
    await surface.manager.disposeSession(other.session.id)
    const retained=await evaluate(agent,'startup-retained','*startup-value*')
    assert.equal(retained.isError,false,JSON.stringify(retained));assert.match(JSON.stringify(retained),/\(42\)/)
    await startup.prepare(input);assert.equal(asks,2)
  }finally{
    surface?.stop();await surface?.dispose()
    for (const agentScope of agentScopes.reverse()) await agentScope.dispose()
    for(const fiber of fibers.reverse())await fiber.dispose()
    db.close();await rm(base,{recursive:true,force:true})
  }
})
