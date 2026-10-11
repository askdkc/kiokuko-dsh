import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {openConnection} from '../../../../src/db/connection.js'
import {migrateDatabase} from '../../../../src/db/migrate.js'
import {prepareAgentTask} from '../../../../src/dsh/task-intake.js'
import {mountOwnedExecution as sourceOwnedExecution} from '../../../../src/dsh/owned-execution.js'
import {mountLispSurface as sourceLispSurface} from '../../../../src/dsh/lisp/surface.js'
import {LispConfig} from '../../../../src/dsh/lisp/contracts.js'
import {assessTaskCompletion,bindTaskCriterion} from '../../../../src/dsh/task-completion.js'

const ownedPackageRoot=process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const mountOwnedExecution:typeof sourceOwnedExecution=ownedPackageRoot?(await import(pathToFileURL(join(ownedPackageRoot,'dist/dsh/owned-execution.js')).href)).mountOwnedExecution:sourceOwnedExecution
const mountLispSurface:typeof sourceLispSurface=ownedPackageRoot?(await import(pathToFileURL(join(ownedPackageRoot,'dist/dsh/lisp/surface.js')).href)).mountLispSurface:sourceLispSurface
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('default development mode: native DSH, SBCL, shared file/process receipts, subdirectory tests and async final results',{
  skip:!packages||process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires pinned native DSH and actual SBCL':false,timeout:120000,
},async()=>{
  const [cordis,prompt,tools,scope,sessions]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-scope','dsh-session'].map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name,'lib/index.js')).href)))
  const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-owned-development-'))),root=join(base,'project')
  await mkdir(root);await mkdir(join(root,'.git'));await mkdir(join(root,'src'))
  await writeFile(join(root,'src/check.test.mjs'),"import test from 'node:test';test('actual test',()=>{});\n")
  const db=openConnection(join(base,'state.sqlite3'));migrateDatabase(db)
  const prepared=await prepareAgentTask(db,{requestId:'native-owned',cwd:root,dshSessionId:'owned-development',task:'Implement parser\n完了条件:\n- テストが成功する',completionMode:'enforce',profileHints:{taskType:'research',target:'src',expected:'verify',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
  const runtime:any={executionJournalDirectory:join(base,'journal'),withDatabase:async(fn:any)=>fn(db)}
  const session=sessions.Session.create('owned-development',[],{version:4,id:'owned-development',createdAt:Date.now(),isSeeded:false,cwd:root})
  const agent:any={id:'owned-agent',session},ctx=new cordis.Context(),fibers:any[]=[],commands=new Map<string,any>()
  let plan=false
  let surface:any,local:any,unmountOwned:(()=>Promise<void>)|undefined,approvals=0
  const signal=new AbortController().signal
  try{
    fibers.push(await ctx.plugin(prompt.default,{}),await ctx.plugin(tools.default,{mode:'native'}))
    fibers.push(await ctx.plugin({name:'owned-development-services',apply(c:any){
      c.provide('planMode',{get:()=>({active:plan})})
      c.provide('agents',{get:(id:string)=>id===agent.id?agent:undefined})
      c.provide('sessions',{get:(id:string)=>id===session.id?session:undefined})
      c.provide('commands',{register:(definition:any)=>{commands.set(definition.name,definition);return()=>commands.delete(definition.name)}})
      c.provide('userQuestions',{ask:async()=>{approvals++;throw new Error('No routine approvals expected')}})
    }}))
    local=scope.createScope(ctx,agent);agent.ctx=local.ctx
    unmountOwned=mountOwnedExecution(ctx,{runtime,resolve:execution=>execution.agent===agent?{runId:prepared.run.runId,sessionId:session.id,repositoryRoot:root,workspace:prepared.project.workspace,generation:'native-generation-1',agent}:undefined})
    ctx.tools.register({name:'fixture_native',modelFacing:true,parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:()=>({available:true})})
    surface=await mountLispSurface(ctx,runtime,LispConfig.parse({enabled:true,startupTimeoutMs:60000}))
    const enabled=await commands.get('kioku-lisp').handler({rawInput:'enable',agent,signal})
    assert.equal(enabled.kind,'success',enabled.text)
    const evaluate=async(code:string)=>{
      const result=await ctx.tools.execute({callId:randomUUID(),name:'lisp_eval',arguments:{operationId:randomUUID(),code},agent,signal})
      assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.ok,true,JSON.stringify(result))
      return result.value.value.json
    }
    assert.equal((await ctx.tools.execute({callId:randomUUID(),name:'fixture_native',arguments:{},agent,signal})).value.available,true)
    await evaluate('(kioku.files:propose-write "new/deep/source.txt" "source result")')
    assert.equal(await readFile(join(root,'new/deep/source.txt'),'utf8'),'source result')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dsh_owned_operations WHERE state='completed' AND receipt_json LIKE '%kioku_write%'").get<any>().n,1)
    const command='node --test --test-reporter=tap check.test.mjs'
    bindTaskCriterion(db,{runId:prepared.run.runId,callId:'bind',criterionId:assessTaskCompletion(db,prepared.run.runId).criteria[0]!.criterionId,method:{kind:'native_command',command,cwd:'src',sourcePaths:['src/check.test.mjs'],assertion:'selected_tests_pass'},approved:true})
    const checked=await evaluate('(kioku.process:run "node" (list "--test" "--test-reporter=tap" "check.test.mjs") :directory "src")')
    assert.equal(checked.code,0);assert.equal(checked.receipt.verification,'passed');assert.equal(checked.receipt.checks[0].outcome,'passed')
    const failed=await evaluate('(kioku.process:run "node" (list "-e" "console.log(JSON.stringify({passed:true}));process.exit(9)"))')
    assert.equal(failed.code,9);assert.equal(failed.receipt.verification,'failed')
    const job=await evaluate('(kioku.process:start-job "node" (list "-e" "require(\'fs\').appendFileSync(\'count\',\'x\')"))')
    let collected:any
    for(let i=0;i<100;i++){collected=await evaluate(`(kioku.process:job-status ${JSON.stringify(job)})`);if(collected.receipt.state!=='started')break;await new Promise(resolve=>setTimeout(resolve,10))}
    assert.equal(collected.receipt.state,'completed');assert.equal(collected.receipt.exitCode,0)
    await evaluate(`(kioku.process:job-status ${JSON.stringify(job)})`)
    assert.equal(await readFile(join(root,'count'),'utf8'),'x');assert.equal(approvals,0)
    const cancelJob=await evaluate('(kioku.process:start-job "node" (list "-e" "setInterval(()=>{},1000)"))')
    const generation=(await surface.manager.status({sessionId:session.id,agentId:agent.id,root}) as any).generation
    plan=true
    const cancelled=await ctx.tools.execute({callId:randomUUID(),name:'lisp_cancel',arguments:{operationId:randomUUID(),generation},agent,signal})
    assert.equal(cancelled.value.ok,true,JSON.stringify(cancelled))
    plan=false
    let terminal:any
    for(let n=0;n<100;n++){
      terminal=(await ctx.tools.execute({callId:randomUUID(),name:'kioku_result',arguments:{operationId:cancelJob},agent,signal})).value
      if(terminal.receipt.state!=='started')break
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(terminal.receipt.cancelled,true,'Plan keeps cancellation available and records the actual terminal result')
    surface.stop();await surface.dispose();surface=undefined
    surface=await mountLispSurface(ctx,runtime,LispConfig.parse({executionMode:'protected',enabled:true,startupTimeoutMs:60000}))
    assert.equal((await ctx.tools.execute({callId:randomUUID(),name:'fixture_native',arguments:{},agent,signal})).isError,true,'explicit protected reload reinstates its legacy fence')
    surface.stop();await surface.dispose();surface=undefined
    surface=await mountLispSurface(ctx,runtime,LispConfig.parse({executionMode:'development',enabled:true,startupTimeoutMs:60000}))
    assert.equal((await ctx.tools.execute({callId:randomUUID(),name:'fixture_native',arguments:{},agent,signal})).value.available,true,'development reload releases the old ordinary-tool restriction')
    assert.equal((await ctx.tools.execute({callId:randomUUID(),name:'kioku_read',arguments:{path:'count'},agent,signal})).value.content,'x')
  }finally{surface?.stop();await surface?.dispose();await unmountOwned?.();await local?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
