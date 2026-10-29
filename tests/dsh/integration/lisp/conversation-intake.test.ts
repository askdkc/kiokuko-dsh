import { execFileSync } from 'node:child_process'
import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import test from 'node:test'
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {claimExecutionOwner} from '../../../../src/dsh/orchestration/execution-owner.js'
import {prepareAgentTask} from '../../../../src/dsh/task-intake.js'
import {initializeCodingWorkflow,sessionCodingWorkflow} from '../../../../src/dsh/coding-workflow/store.js'
import {openConnection} from '../../../../src/db/connection.js'
import {migrateDatabase} from '../../../../src/db/migrate.js'
import {mountLispSurface as sourceLispSurface} from '../../../../src/dsh/lisp/surface.js'
import {LispConfig} from '../../../../src/dsh/lisp/contracts.js'
import {OnDemandIntake as SourceOnDemandIntake} from '../../../../src/dsh/on-demand-intake.js'
const ownedPackageRoot=process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const mountLispSurface:typeof sourceLispSurface=ownedPackageRoot?(await import(pathToFileURL(join(ownedPackageRoot,'dist/dsh/lisp/surface.js')).href)).mountLispSurface:sourceLispSurface
const OnDemandIntake:typeof SourceOnDemandIntake=ownedPackageRoot?(await import(pathToFileURL(join(ownedPackageRoot,'dist/dsh/on-demand-intake.js')).href)).OnDemandIntake:SourceOnDemandIntake
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const load=(name:string)=>import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href)
for(const mode of ['unknown','research','optional-workflow','controlled','explicit-deferred'] as const)test(`ordinary root Lisp pure evaluation without task intake (${mode})`,{timeout:120000},async()=>{
 const classified=mode==='research',deferredOnly=mode==='explicit-deferred',controlled=mode==='controlled',metadata=mode==='optional-workflow'||controlled
 const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-conversation-'))),db=openConnection(join(base,'state.sqlite3'));migrateDatabase(db);execFileSync('git',['init','-q',base])
 const [cordis,prompt,tools,scope,sessions]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-scope','dsh-session'].map(load))
 const ctx=new cordis.Context(),fibers:any[]=[],commands=new Map<string,any>()
 const session=sessions.Session.create('conversation',[],{version:4,id:'conversation',createdAt:Date.now(),isSeeded:false,cwd:base})
 session.append('turn/start',{turn:1})
 if(metadata){
  const prepared=await prepareAgentTask(db,{requestId:'optional-coding',dshSessionId:session.id,cwd:base,task:'Implement an unrelated parser',profileHints:{taskType:'build',target:'.',expected:'Parser works',constraints:null},capabilities:[],skillDiscoveryMode:'off',completionMode:'shadow'})
  claimExecutionOwner(db,{sessionId:session.id,workspace:prepared.project.workspace,mode:'normal',startId:'optional-coding',runId:prepared.run.runId})
  initializeCodingWorkflow(db,{runId:prepared.run.runId,sessionId:session.id,repositoryRoot:base,requestId:'optional-coding',task:'Implement an unrelated parser'})
 }
 if(metadata)assert.ok(sessionCodingWorkflow(db,session.id),'the optional/controlled workflow is bound to this exact session')
 const originalRunCount=db.prepare('SELECT count(*) n FROM ledger_runs').get<any>()!.n
 const agent:any={id:'conversation-agent',session};let surface:any,local:any,intake:SourceOnDemandIntake|undefined,preparations=0,plan=false,approvals=0,verdict='allowed-once'
 let onApproval:(()=>void)|undefined,bodies=0
 const controller=new AbortController(),runtime:any={executionJournalDirectory:join(base,'journal'),withDatabase:async(fn:any)=>fn(db)}
 try{
  fibers.push(await ctx.plugin(prompt.default,{}));await mountNativeTools(ctx,tools,packages,fibers)
  for(const name of ['dsh-session-projection','dsh-fs-local','dsh-working-directory','dsh-subprocess-local','dsh-bash-local','dsh-shell-env','dsh-tool-bash','dsh-user-approval']) {
   const module=await load(name),config=name==='dsh-fs-local'||name==='dsh-bash-local'?{cwd:base}:name==='dsh-working-directory'?{defaultDirectory:base}:name==='dsh-shell-env'?{dshHome:base}:name==='dsh-user-approval'?{policy:'ask'}:{}
   fibers.push(await ctx.plugin(module.default??module,config))
  }
  const ask=ctx.on('tools/pre-execute',async(e:any,next:any)=>e.name==='bash'?{kind:'ask',reason:'Native fixture requires approval for this exact Lisp command'}:next())
  const answer=ctx.on('approval/request',async()=>{approvals++;onApproval?.();return verdict})
  fibers.push({dispose:()=>{ask();answer()}})
  fibers.push(await ctx.plugin({name:'conversation-services',apply(c:any){c.provide('planMode',{get:()=>({active:plan})});c.provide('agents',{get:(id:string)=>id===agent.id?agent:undefined});c.provide('sessions',{get:(id:string)=>id===session.id?session:undefined});c.provide('commands',{register:(d:any)=>{commands.set(d.name,d);return()=>commands.delete(d.name)}})}}))
  const bash=ctx.tools.get('bash'),nativeBash=bash.execute
  bash.execute=(...args:any[])=>{bodies++;return nativeBash(...args)}
  local=scope.createScope(ctx,agent);agent.ctx=local.ctx
  intake=new OnDemandIntake({validate:async()=>{},nativeOwnership:async()=>'owned',existing:async()=>controlled,...(controlled?{replay:async()=>true}:{}),classify:async()=>classified?{taskType:'research',deferInference:false}:{deferInference:true},prepare:async()=>{preparations++;throw new Error('Optional intake must not gate ordinary Lisp computation')},ready:()=>controlled},{onlyWhenDeferred:deferredOnly})
  intake.mount(ctx,ctx.tools)
  surface=await mountLispSurface(ctx,runtime,LispConfig.parse({executionMode:'development',enabled:true,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}))
  const enabled=await commands.get('kioku-lisp').handler({rawInput:'enable',agent,signal:controller.signal});assert.equal(enabled.kind,'success',enabled.text)
  if(mode==='optional-workflow'){
   const workflow=sessionCodingWorkflow(db,session.id)
   const disabled=await commands.get('kioku-lisp').handler({rawInput:'disable',agent,signal:controller.signal})
   assert.equal(disabled.kind,'success',disabled.text)
   assert.equal(ctx.tools.get('lisp_eval',agent),undefined)
   const reenabled=await commands.get('kioku-lisp').handler({rawInput:'enable',agent,signal:controller.signal})
   assert.equal(reenabled.kind,'success',reenabled.text)
   assert.deepEqual(sessionCodingWorkflow(db,session.id),workflow,'ordinary mode controls must not rewrite the unrelated Goal-less workflow')
  }
  await intake.capture({agent,turn:1,step:0,messages:[{id:'original-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'Calculate 20 plus 22 in this conversation. Inspect only; do not change workspace files.'}]}],signal:controller.signal})
  if(mode==='optional-workflow'){
   const projected=await (ctx.get('kiokukoLispAssembly') as any).project(agent,{sections:[],variables:{},tools:ctx.tools.schemas(agent)})
   assert.ok(projected.tools.some((t:any)=>t.name==='lisp_eval'),'optional Goal metadata cannot remove the native model-facing Lisp surface')
  }
  let call=0;const execute=(name:string,args:object)=>executeNativeTool(ctx,packages,{name,arguments:args,agent,callId:`conversation-${++call}`,signal:controller.signal})
  if (!deferredOnly && !controlled) {
   const directShell=await execute('bash',{command:'node --version',description:'Attempt direct shell while Lisp is selected'})
   assert.equal(directShell.isError,true,JSON.stringify(directShell));assert.match(JSON.stringify(directShell),/LISP_ROUTE_REQUIRED/)
   assert.equal(bodies,0,'route rejection must happen before the native shell body')
   assert.equal(approvals,0,'a rejected route must not ask for native command approval')
  }
  const result=await execute('lisp_eval',{operationId:'pure',code:'(+ 20 22)'})
  if(deferredOnly){assert.equal(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result),/prepare_requested_work/);assert.equal(preparations,0);return}
  if(controlled){assert.equal(result.value.ok,false);assert.match(JSON.stringify(result),/CODING_CHOICE_PENDING|Goal/);return}
  assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.ok,true,JSON.stringify(result));assert.match(JSON.stringify(result.value),/42/)
  assert.equal(preparations,0);assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get<any>()!.n,originalRunCount)
  assert.equal((await execute('lisp_status',{})).isError,false)
  const effect=await execute('lisp_eval',{operationId:'unowned-effect',code:'(kioku.files:propose-write "denied.txt" "bad")'})
  assert.equal(effect.value.ok,false);assert.match(JSON.stringify(effect.value),/Working タスク/,'delegating Lisp dispatch never grants an effect lease')
  await assert.rejects(readFile(join(base,'denied.txt')),{code:'ENOENT'})
  const processEffect=await execute('lisp_eval',{operationId:'unowned-process',code:'(kioku.process:run "node" (list "--version"))'})
  assert.equal(processEffect.value.ok,true,JSON.stringify(processEffect));assert.equal(processEffect.value.value.json.code,0)
  assert.match(processEffect.value.value.json.stdout,/v[0-9]+\./);assert.equal(approvals,1)
  let requests=0;const server=createServer((_request,response)=>{requests++;response.end('CONVERSATIONAL_LOCAL_CURL')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
   const port=(server.address() as {port:number}).port
   const curl=await execute('lisp_eval',{operationId:'unowned-curl',code:`(kioku.process:run "curl" (list "-fsS" "--max-time" "5" "http://127.0.0.1:${port}/probe"))`})
   assert.equal(curl.value.ok,true,JSON.stringify(curl));assert.equal(curl.value.value.json.code,0);assert.match(curl.value.value.json.stdout,/CONVERSATIONAL_LOCAL_CURL/);assert.equal(requests,1)
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
  assert.equal(preparations,0);assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get<any>()!.n,originalRunCount)
  verdict='rejected'
  const rejected=await execute('lisp_eval',{operationId:'native-process-denied',code:'(kioku.process:run "node" (list "--version"))'})
  assert.equal(rejected.value.ok,false);assert.match(JSON.stringify(rejected),/rejected tool/)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dsh_managed_operations WHERE state='denied' AND json_extract(operation_json,'$.route')='native'").get<{n:number}>()!.n,1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dsh_managed_operations WHERE state='unknown'").get<{n:number}>()!.n,0)
  verdict='allowed-once'
  const mutation=ctx.tools.guard((e:any)=>{if(e.name==='bash')e.arguments={...e.arguments,command:'printf forbidden > changed-command.txt'};return undefined})
  const changed=await execute('lisp_eval',{operationId:'changed-native-args',code:'(kioku.process:run "node" (list "--version"))'});mutation()
  assert.equal(changed.value.ok,false);await assert.rejects(readFile(join(base,'changed-command.txt')),{code:'ENOENT'})
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dsh_managed_operations WHERE state='unknown'").get<{n:number}>()!.n,0,JSON.stringify(changed))
  const originalContext=agent.ctx,beforeOwnerChange=bodies
  onApproval=()=>{agent.ctx=Object.create(originalContext)}
  try {
   const rebound=await execute('lisp_eval',{operationId:'changed-native-owner',code:'(kioku.process:run "node" (list "--version"))'})
   assert.equal(rebound.value.ok,false);assert.equal(bodies,beforeOwnerChange,'a changed owner context never reaches native execution')
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dsh_managed_operations WHERE state='unknown'").get<{n:number}>()!.n,0,JSON.stringify(rebound))
  } finally {agent.ctx=originalContext;onApproval=undefined}
  const nested=await executeNativeTool(ctx,packages,{name:'lisp_eval',arguments:{operationId:'untrusted-child',code:'(+ 1 2)'},agent,callId:'untrusted-child',parent:Symbol('untrusted'),signal:controller.signal})
  assert.equal(nested.isError,true,'an arbitrary child Lisp call cannot acquire the root native capability')
  plan=true
  assert.equal((await execute('lisp_eval',{operationId:'plan',code:'(+ 1 2)'})).value.ok,true,'pure native computation does not replace host Plan/sandbox policy')
  assert.equal((await execute('lisp_status',{})).isError,false)
  plan=false
  const deny=ctx.tools.guard((e:any)=>e.name==='lisp_eval'?'NATIVE_LISP_DENIED':undefined)
  assert.match(JSON.stringify(await execute('lisp_eval',{operationId:'native-deny',code:'(+ 1 2)'})),/NATIVE_LISP_DENIED/);deny()
  const mutate=ctx.tools.guard((e:any)=>{if(e.name==='lisp_eval')e.arguments={...e.arguments,code:'(error "mutated after admission")'};return undefined})
  assert.match(JSON.stringify(await execute('lisp_eval',{operationId:'mutated',code:'(+ 1 2)'})),/identity or arguments changed/);mutate()
  let spoofed=0
  const registered=ctx.tools.get('lisp_eval',agent),original=registered.execute
  registered.execute=()=>{spoofed++;return 42}
  try { assert.equal((await execute('lisp_eval',{operationId:'spoof',code:'(+ 1 2)'})).isError,true);assert.equal(spoofed,0) } finally { registered.execute=original }
  if(mode==='unknown'){
   const timeout=await execute('lisp_eval',{operationId:'conversation-timeout',code:'(loop)',timeoutMs:100})
   assert.equal(timeout.value.code,'TIMEOUT',JSON.stringify(timeout))
   intake.finish(session,1);session.append('turn/end',{turn:1,reason:{kind:'completed'}})
   assert.equal((await execute('lisp_eval',{operationId:'previous-turn-rejected',code:'(+ 1 2)'})).isError,true,'a closed turn cannot retain native execution authority')
   const recovery=await commands.get('kioku-lisp').handler({rawInput:'recover',agent,signal:controller.signal})
   assert.equal(recovery.kind,'success',recovery.text)
   session.append('turn/start',{turn:2})
   await intake.capture({agent,turn:2,step:0,messages:[{id:'next-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'Continue with a pure calculation.'}]}],signal:controller.signal})
   const resumed=await execute('lisp_eval',{operationId:'conversation-after-recovery',code:'(+ 20 22)'})
   assert.equal(resumed.value.ok,true,JSON.stringify(resumed))
   assert.equal(resumed.value.value.json,42,JSON.stringify(resumed))
   assert.equal(preparations,0,'human worker recovery must not create a workflow')
  }
  controller.abort(new Error('Explicit native human Stop'))
  assert.equal((await execute('lisp_eval',{operationId:'stopped',code:'(+ 1 2)'})).isError,true)

 }finally{await intake?.dispose();surface?.stop();await surface?.dispose();await local?.dispose();for(const f of fibers.reverse())await f.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
