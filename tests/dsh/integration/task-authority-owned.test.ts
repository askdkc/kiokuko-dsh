import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import { observedTaskCompletionEvidence } from '../../../src/dsh/owned-completion-evidence.js'
import { NativeTaskAuthority, stopTaskNativeChildren } from '../../../src/dsh/native-task-authority.js'
import { readOwnedIdentity } from '../../../src/dsh/owned-read-owner.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { OwnedExecutionService, mountOwnedExecution, stopTaskOwnedExecutions, type ExecutionIdentity } from '../../../src/dsh/owned-execution.js'
import { assessTaskCompletion, bindTaskCriterion } from '../../../src/dsh/task-completion.js'
import { mountTaskCompletion } from '../../../src/dsh/task-completion-host.js'
import { observeProcessResult } from '../../../src/dsh/execution-result.js'
import { bindTaskRepository, captureTaskLease, readTaskSnapshot, type TaskState } from '../../../src/dsh/task-state.js'
import { withTaskAuthority } from '../../../src/dsh/task-authority-context.js'

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = await read(); if (value !== undefined) return value; await delay(10) }
  throw new Error('Timed out waiting for the controlled process')
}
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve} }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kioku-authority-')))
  await mkdir(join(root, '.git')); await writeFile(join(root, 'source.txt'), 'original')
  const db = openConnection(join(root, 'state.sqlite3')); migrateDatabase(db)
  const task = await prepareAgentTask(db, {requestId:'authority',cwd:root,task:'Inspect source.\n完了条件:\n- Confirm the observed output',
    dshSessionId:'authority-session',completionMode:'enforce',profileHints:{taskType:'research',target:'source.txt',expected:'Observed output',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
  const agent = {id:'authority-agent'}, identity: ExecutionIdentity = {runId:task.run.runId,sessionId:'authority-session',
    workspace:task.project.workspace,repositoryRoot:root,generation:'host-generation',agent}
  const taskIdentity = {taskId:identity.runId,sessionId:identity.sessionId,repositoryRoot:root}
  bindTaskRepository(db, taskIdentity)
  const runtime: any = {withDatabase:async(fn:any)=>fn(db)}
  let confirmation: (() => Promise<boolean>) | undefined
  const host = {runtime,resolve:(execution:any)=>execution.agent===agent?identity:undefined,
    confirm:async()=>confirmation?.() ?? false}
  const service = new OwnedExecutionService(host)
  const execution = (name:string,args:unknown,id:string) => ({name,arguments:args,callId:id,agent,signal:new AbortController().signal})
  const execute = (name:string,args:unknown,id:string) => service.execute(name,args,execution(name,args,id)) as Promise<any>
  const state = (value:TaskState) => db.prepare('UPDATE ledger_runs SET task_state=?,task_revision=task_revision+1,task_generation=task_generation+1 WHERE run_id=?').run(value,identity.runId)
  const bind = (command:string) => bindTaskCriterion(db, {runId:identity.runId,callId:'binding',criterionId:assessTaskCompletion(db,identity.runId).criteria[0]!.criterionId,
    method:{kind:'native_command',command,cwd:root,sourcePaths:['source.txt'],assertion:'output_matches',expectedOutput:'done'},approved:true})
  return {root,db,identity,taskIdentity,runtime,host,service,execution,execute,state,bind,
    confirm(handler:()=>Promise<boolean>){confirmation=handler},
    async cleanup(){await service.close();db.close();await rm(root,{recursive:true,force:true})}}
}

test('only Working grants effects; all five states retain reads and no failed status becomes Ignore', async () => {
  const f = await fixture()
  try {
    for (const state of ['ToDo','Working','Pending','Done','Ignore'] as const) {
      f.state(state)
      assert.equal((await f.execute('kioku_read',{path:'source.txt'},`read-${state}`)).content,'original')
      const call = f.execute('kioku_write',{path:`${state}.txt`,content:state},`write-${state}`)
      if (state === 'Working') assert.equal((await call).applied,true)
      else { await assert.rejects(call,/not Working/); await assert.rejects(readFile(join(f.root,`${state}.txt`)),{code:'ENOENT'}) }
    }
    for (const status of ['failed','cancelled','interrupted'] as const) {
      f.state('Working'); f.db.prepare('UPDATE ledger_runs SET status=? WHERE run_id=?').run(status,f.identity.runId)
      const snapshot = readTaskSnapshot(f.db,f.taskIdentity)
      assert.equal(snapshot.runStatus,status); assert.notEqual(snapshot.state,'Ignore')
      await assert.rejects(f.execute('kioku_exec',{command:'printf no'},status),/not Working/)
    }
  } finally { await f.cleanup() }
})

test('a stale host-only lease survives native-style input reconstruction and cannot rebind after resume', async () => {
  const f = await fixture()
  try {
    const lease = captureTaskLease(f.db,f.taskIdentity)
    f.state('Pending'); f.state('Working')
    await assert.rejects(withTaskAuthority(lease,()=>f.execute('kioku_write',{path:'stale.txt',content:'no'},'stale')),/stale/)
    await assert.rejects(readFile(join(f.root,'stale.txt')),{code:'ENOENT'})
    assert.equal((await f.execute('kioku_write',{path:'fresh.txt',content:'yes'},'fresh')).applied,true)
  } finally { await f.cleanup() }
})

test('authority changes during native destructive approval prevent the file effect', async () => {
  const f = await fixture()
  try {
    f.confirm(async()=>{f.state('Pending'); return true})
    const result = await f.execute('kioku_remove',{path:'source.txt'},'remove')
    assert.equal(result.receipt.state,'unknown'); assert.match(result.error,/stale|stopped/)
    assert.equal(await readFile(join(f.root,'source.txt'),'utf8'),'original')
  } finally { await f.cleanup() }
})

test('asynchronous completion preserves process observations but rejects stale verification commit', async () => {
  const f = await fixture()
  try {
    const command = 'printf started > started; while [ ! -e release ]; do sleep 0.01; done; printf done'
    f.bind(command)
    const started = await f.execute('kioku_exec',{command,background:true},'background')
    await until(async()=>readFile(join(f.root,'started'),'utf8').catch(()=>undefined))
    f.state('Pending'); f.state('Working')
    await writeFile(join(f.root,'release'),'finish')
    const result = await until(async()=>{const value=await f.execute('kioku_result',{operationId:started.receipt.operationId},'result');return value.receipt.state==='started'?undefined:value})
    assert.equal(result.exitCode,0); assert.equal(result.output,'done')
    assert.equal(result.receipt.authority,'stale'); assert.equal(result.receipt.verification,'unknown')
    assert.equal(result.receipt.state,'completed','actual process completion is retained')
    assert.notEqual(f.db.prepare('SELECT outcome FROM dsh_completion_executions WHERE call_id=?').get<any>(started.receipt.operationId)?.outcome,'passed')
    assert.equal(readTaskSnapshot(f.db,f.taskIdentity).state,'Working')
  } finally { await f.cleanup() }
})

test('task stop waits for owned jobs; result/cancel works while Pending and unknown restart jobs do not prove stop', async () => {
  const f = await fixture()
  try {
    const started = await f.execute('kioku_exec',{command:'printf started > started; while true; do sleep 0.05; done',background:true},'stop-job')
    await until(async()=>readFile(join(f.root,'started'),'utf8').catch(()=>undefined))
    f.state('Pending')
    await f.execute('kioku_result',{operationId:started.receipt.operationId,cancel:true},'cancel-job')
    assert.equal(await stopTaskOwnedExecutions(f.runtime,f.taskIdentity),true)
    const result = await f.execute('kioku_result',{operationId:started.receipt.operationId},'stopped-result')
    assert.equal(result.receipt.cancelled,true); assert.notEqual(result.receipt.state,'started')
    f.db.prepare("UPDATE dsh_owned_operations SET state='started',receipt_json=? WHERE operation_id=?")
      .run(JSON.stringify({...result.receipt,state:'started'}),started.receipt.operationId)
    assert.equal(await stopTaskOwnedExecutions(f.runtime,f.taskIdentity),false)
  } finally { await f.cleanup() }
})

test('native effect seam preserves pure PTC and control identity proof; same-name spoof still needs Working', async () => {
  const f = await fixture(); const listeners=new Map<string,Function[]>(); let control:object|undefined
  const dispose=mountOwnedExecution({tools:{register:()=>()=>{}},on(name,listener){listeners.set(name,[...listeners.get(name)??[],listener]);return()=>{}}},
    {...f.host,isTaskControl:execution=>execution===control})
  try {
    f.state('Pending'); let called=0
    const dispatch=listeners.get('tools/execute')![0]!
    const next=async()=>{called++;return 'native'}
    assert.equal(await dispatch(f.execution('read',{},'read'),next),'native')
    assert.equal(await dispatch(f.execution('run_code',{code:'return 1+1'},'pure'),next),'native')
    const real=f.execution('task_operation',{},'control');control=real
    assert.equal(await dispatch(real,next),'native')
    for(const name of ['task_operation','write','edit','bash','spawn']) await assert.rejects(dispatch(f.execution(name,{},name),next),/not Working/)
    assert.equal(called,3)
    f.state('Working')
    const delayed=f.execution('write',{file_path:'later'},'delayed')
    const pre=listeners.get('tools/pre-execute')![0]!
    const denied={kind:'deny',reason:'native permission denied'}
    assert.equal(await pre(f.execution('write',{},'native-denied'),async()=>denied),denied)
    await pre(delayed,async()=>({kind:'allow'}))
    f.state('Pending');f.state('Working')
    await assert.rejects(dispatch(delayed,next),/stale/)
    assert.equal(called,3,'permission and stale-generation rejections never call the effect')
  } finally {await dispose();await f.cleanup()}
})

test('native task completion observer rejects a delayed result after generation change', async () => {
  const f = await fixture();const listeners=new Map<string,Function>()
  const dispose=mountTaskCompletion({tools:{register:()=>()=>{}},on(name,listener){listeners.set(name,listener);return()=>{}}},f.host)
  try {
    f.bind('printf done')
    const execution=f.execution('bash',{command:'printf done'},'native')
    await listeners.get('tools/pre-execute')!(execution,async()=>({kind:'allow'}))
    assert.ok(f.db.prepare('SELECT outcome FROM dsh_completion_executions WHERE call_id=?').get('native'))
    f.state('Pending');f.state('Working')
    await listeners.get('tools/result')!(execution,observeProcessResult({isError:false,value:{exitCode:0,signal:null,timedOut:false,aborted:false,outputComplete:true},content:[{type:'text',text:'done'}]}))
    assert.notEqual(f.db.prepare('SELECT outcome FROM dsh_completion_executions WHERE call_id=?').get<any>('native')?.outcome,'passed')
  } finally {dispose();await f.cleanup()}
})


test('native children require host spawn proof and retain the original parent authority across resume', async () => {
  const f = await fixture(), agents = new Map<string,any>(), sessions = new Map<string,any>()
  const parent:any = f.identity.agent
  parent.session = {id:f.identity.sessionId,header:{cwd:f.root}}
  agents.set(parent.id,parent);sessions.set(parent.session.id,parent.session)
  const create = (id:string, parentId=parent.session.id) => {
    const child:any = {id:`agent:${id}`,status:'running',cancel(){this.status='idle'},async whenIdle(){},session:{id,header:{cwd:f.root,parentSession:parentId,origin:'subagent',delegationDepth:1}}}
    agents.set(child.id,child);sessions.set(id,child.session);return child
  }
  const backend = {async startActivation(spec:any) {create(spec.childId,spec.request.parent.session.id);return {childId:spec.childId}}}
  const original = backend.startActivation
  const authority = new NativeTaskAuthority({runtime:f.runtime,repositoryRoot:f.root,backend,agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions,resolveParent:f.host.resolve})
  const service = new OwnedExecutionService({...f.host,resolve: execution => authority.resolve(execution) ?? f.host.resolve(execution),
    resolveRead:async execution=>authority.read(execution)??readOwnedIdentity(f.db,execution.agent,f.root,execution.arguments?.operationId)})
  const exec = (agent:any,name:string,args:any,id:string) => service.execute(name,args,{agent,name,arguments:args,callId:id,signal:new AbortController().signal}) as Promise<any>
  try {
    const fake = create('forged-lineage')
    await assert.rejects(exec(fake,'kioku_write',{path:'forged',content:'no'},'fake'),/No current/)
    const first = await backend.startActivation({provider:'spawn',delivery:'parent',request:{parent},signal:new AbortController().signal})
    const child = agents.get(`agent:${first.childId}`)
    assert.equal((await exec(child,'kioku_write',{path:'child.txt',content:'yes'},'child')).applied,true)
    f.state('Pending');f.state('Working')
    await assert.rejects(exec(child,'kioku_write',{path:'stale-child.txt',content:'no'},'stale'),/stale/)
    await assert.rejects(backend.startActivation({provider:'spawn',delivery:'parent',request:{parent:child},signal:new AbortController().signal}),/stale/)
    assert.equal((await exec(child,'kioku_read',{path:'child.txt'},'read')).content,'yes')
    const fresh = await backend.startActivation({provider:'fork',delivery:'parent',request:{parent},signal:new AbortController().signal})
    const newChild=agents.get(`agent:${fresh.childId}`)
    assert.equal((await exec(newChild,'kioku_write',{path:'fresh-child.txt',content:'yes'},'fresh')).applied,true)
    sessions.set(parent.session.id,{...parent.session})
    await assert.rejects(exec(newChild,'kioku_write',{path:'replaced-parent',content:'no'},'replaced'),/identity changed/)
    sessions.set(parent.session.id,parent.session)
    assert.equal(await stopTaskNativeChildren(f.runtime,{taskId:f.identity.runId,repositoryRoot:f.root}),true)
    assert.equal(child.status,'idle');assert.equal(newChild.status,'idle')
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM dsh_owned_operations WHERE state='started'").get<any>()!.count,0)
    const unconfirmed=await backend.startActivation({provider:'spawn',delivery:'parent',request:{parent},signal:new AbortController().signal})
    assert.ok(unconfirmed.childId)
    authority.dispose()
    assert.equal(await stopTaskNativeChildren(f.runtime,{taskId:f.identity.runId,repositoryRoot:f.root}),false,'restart/absence is not stopped proof')
    assert.equal(backend.startActivation,original)
    await assert.rejects(exec(newChild,'kioku_write',{path:'after-reload',content:'no'},'reload'),/No current/)
  } finally {authority.dispose();await service.close();await f.cleanup()}
})

test('natural native child settlement records exact idle teardown without cancelling or granting newer authority', async () => {
  for(const stale of [false,true]) {
    const f=await fixture(),agents=new Map<string,any>(),sessions=new Map<string,any>(),settled=deferred<unknown>()
    const parent:any=f.identity.agent;parent.session={id:f.identity.sessionId,header:{cwd:f.root}}
    agents.set(parent.id,parent);sessions.set(parent.session.id,parent.session)
    let child:any,cancels=0,disposed=0
    const backend={async startActivation(spec:any){
      child={id:spec.childId,status:'running',cancel(){cancels++},async whenIdle(){},session:{id:spec.childId,
        header:{cwd:f.root,parentSession:parent.session.id,origin:'subagent',delegationDepth:1}}}
      agents.set(child.id,child);sessions.set(child.session.id,child.session)
      return {childId:spec.childId,result:settled.promise,async dispose(){disposed++}}
    }}
    const authority=new NativeTaskAuthority({runtime:f.runtime,repositoryRoot:f.root,backend,agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions,resolveParent:f.host.resolve})
    try {
      const lease=captureTaskLease(f.db,f.taskIdentity)
      const activation=await backend.startActivation({provider:'spawn',delivery:'parent',request:{parent},signal:new AbortController().signal})
      const read=()=>JSON.parse(f.db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=?').get<any>(`native-child:${activation.childId}`).receipt_json)
      assert.equal(read().state,'started')
      if(stale){f.state('Pending');f.state('Working')}
      child.status='idle';agents.delete(child.id);sessions.delete(child.session.id);settled.resolve({stopReason:'end_turn'})
      const receipt=await until(async()=>{const value=read();return value.state==='completed'?value:undefined})
      assert.equal(cancels,0);assert.equal(disposed,1)
      assert.deepEqual(receipt.taskAuthority,lease);assert.equal(receipt.authority,stale?'stale':'current')
      assert.equal(observedTaskCompletionEvidence(f.db,readTaskSnapshot(f.db,f.taskIdentity),[receipt.evidenceRef]).length,0)
      assert.equal(await stopTaskNativeChildren(f.runtime,f.taskIdentity),true,'a naturally removed child retains proven completion')
    } finally {authority.dispose();await f.cleanup()}
  }
})

test('native settlement never marks teardown failures, replacement children or unloaded observations complete', async () => {
  for(const boundary of ['teardown-failure','replacement','unload'] as const) {
    const f=await fixture(),agents=new Map<string,any>(),sessions=new Map<string,any>(),settled=deferred<unknown>(),observed=deferred<void>()
    const parent:any=f.identity.agent;parent.session={id:f.identity.sessionId,header:{cwd:f.root}}
    agents.set(parent.id,parent);sessions.set(parent.session.id,parent.session)
    let child:any
    const backend={async startActivation(spec:any){
      child={id:spec.childId,status:'running',async whenIdle(){},session:{id:spec.childId,
        header:{cwd:f.root,parentSession:parent.session.id,origin:'subagent',delegationDepth:1}}}
      agents.set(child.id,child);sessions.set(child.session.id,child.session)
      return {childId:spec.childId,result:settled.promise,async dispose(){observed.resolve();if(boundary==='teardown-failure')throw new Error('teardown unconfirmed')}}
    }}
    const authority=new NativeTaskAuthority({runtime:f.runtime,repositoryRoot:f.root,backend,agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions,resolveParent:f.host.resolve})
    try {
      const activation=await backend.startActivation({provider:'spawn',delivery:'parent',request:{parent},signal:new AbortController().signal})
      child.status='idle'
      if(boundary==='replacement')agents.set(child.id,{...child})
      if(boundary==='unload')authority.dispose()
      settled.resolve({stopReason:'end_turn'});await observed.promise;await new Promise(resolve=>setImmediate(resolve))
      assert.equal(f.db.prepare('SELECT state FROM dsh_owned_operations WHERE operation_id=?').get<any>(`native-child:${activation.childId}`).state,'started')
    } finally {authority.dispose();await f.cleanup()}
  }
})

test('terminal result owner lookup retains reads and cancellation without rebinding to a new task', async () => {
  const f=await fixture(), agent:any=f.identity.agent
  agent.session={id:f.identity.sessionId,header:{cwd:f.root}}
  try {
    const wrote=await f.execute('kioku_write',{path:'finished.txt',content:'done'},'finished')
    f.state('Done');f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.identity.runId)
    const service=new OwnedExecutionService({runtime:f.runtime,resolve:()=>undefined,
      resolveRead:async execution=>readOwnedIdentity(f.db,execution.agent,f.root,execution.arguments?.operationId)})
    try {
      const execute=(name:string,args:any,id:string)=>service.execute(name,args,{agent,name,arguments:args,callId:id,signal:new AbortController().signal}) as Promise<any>
      assert.equal((await execute('kioku_read',{path:'finished.txt'},'read')).content,'done')
      assert.equal((await execute('kioku_result',{operationId:wrote.receipt.operationId,cancel:true},'result')).receipt.operationId,wrote.receipt.operationId)
      assert.equal(readOwnedIdentity(f.db,{session:{id:'other-session'}},f.root,wrote.receipt.operationId),undefined)
      await assert.rejects(execute('kioku_write',{path:'no',content:'no'},'write'),/No current/)
    } finally {await service.close()}
  } finally {await f.cleanup()}
})


test('PTC pure execution retains its entry lease or no-task sentinel across delayed inner effects', async()=>{
  const f=await fixture()
  try {
    const pure=f.execution('run_code',{},'pure')
    await f.service.composite(pure,async()=>{
      f.state('Pending');f.state('Working')
      await assert.rejects(f.execute('kioku_write',{path:'ptc-stale',content:'no'},'old-ptc'),/stale/)
      assert.equal((await f.execute('kioku_read',{path:'source.txt'},'ptc-read')).content,'original')
    })
    f.state('Pending')
    assert.equal(await f.service.composite(f.execution('run_code',{},'pending-pure'),async()=>42),42)
    const absent=new OwnedExecutionService({runtime:f.runtime,resolve:()=>undefined})
    try {await absent.composite(f.execution('run_code',{},'no-task'),async()=>{
      f.state('Working')
      await assert.rejects(f.execute('kioku_write',{path:'ptc-new-task',content:'no'},'new-ptc'),/started without task authority/)
      return 42
    })}finally{await absent.close()}
  }finally{await f.cleanup()}
})


test('explicit completion references require current host-observed receipt provenance, not JSON or process claims',async()=>{
  const f=await fixture()
  const evidence=(refs:string[])=>observedTaskCompletionEvidence(f.db,readTaskSnapshot(f.db,f.taskIdentity),refs)
  try {
    const read=await f.execute('kioku_read',{path:'source.txt'},'read-proof')
    const write=await f.execute('kioku_write',{path:'written.txt',content:'verified bytes'},'write-proof')
    const process=await f.execute('kioku_exec',{command:'printf observed'},'process-proof')
    for(const result of [read,write,process])assert.deepEqual(evidence([result.receipt.evidenceRef]),[result.receipt.evidenceRef])
    assert.deepEqual(evidence([]),[],'success is never selected without explicit reference')
    assert.deepEqual(evidence(['owned:'+ 'a'.repeat(64)]),[])
    const failed=await f.execute('kioku_exec',{command:'exit 3'},'failed-proof')
    assert.deepEqual(evidence([failed.receipt.evidenceRef]),[])
    assert.deepEqual(observedTaskCompletionEvidence(f.db,{...readTaskSnapshot(f.db,f.taskIdentity),sessionId:'different-owner'},[read.receipt.evidenceRef]),[])
    const forged=structuredClone(read.receipt);forged.verification='passed';forged.targets[0].after='fabricated'
    f.db.prepare('UPDATE dsh_owned_operations SET receipt_json=? WHERE operation_id=?').run(JSON.stringify(forged),read.receipt.operationId)
    assert.deepEqual(evidence([read.receipt.evidenceRef]),[],'receipt JSON changes cannot preserve host provenance')
    f.db.prepare('DELETE FROM ledger_task_evidence WHERE evidence_ref=?').run('observation:'+write.receipt.evidenceRef)
    assert.deepEqual(evidence([write.receipt.evidenceRef]),[],'unproven journal/database receipts are not observations')
    f.state('Pending');f.state('Working')
    assert.deepEqual(evidence([process.receipt.evidenceRef]),[],'prior generation evidence cannot complete resumed work')
    const fresh=await f.execute('kioku_read',{path:'source.txt'},'fresh-proof')
    assert.deepEqual(evidence([fresh.receipt.evidenceRef]),[fresh.receipt.evidenceRef])
    f.state('Pending')
    const paused=await f.execute('kioku_read',{path:'source.txt'},'paused-read-proof')
    assert.equal(paused.content,'original');assert.deepEqual(evidence([paused.receipt.evidenceRef]),[])
  }finally{await f.cleanup()}
})

// The approval gate is deterministic: cancellation is committed before launch resumes.
test('owned cancellation before process admission records a confirmed stop and no side effect',async()=>{
  const f=await fixture(),entered=deferred<void>(),release=deferred<boolean>()
  f.confirm(async()=>{entered.resolve();return release.promise})
  try{
    const started=await f.execute('kioku_exec',{command:"node -e \"require('fs').writeFileSync('cancel-marker','wrong')\"",background:true,destructiveTargets:['cancel-marker']},'cancel-before-launch')
    await entered.promise
    const pending=await f.service.result(f.identity,{operationId:started.receipt.operationId,cancel:true}) as any
    assert.equal(pending.receipt.state,'started')
    release.resolve(true);await f.service.close()
    const terminal=await f.service.result(f.identity,{operationId:started.receipt.operationId,cancel:false}) as any
    await assert.rejects(readFile(join(f.root,'cancel-marker')),{code:'ENOENT'})
    assert.equal(terminal.receipt.state,'completed','a known never-launched process is not an unknown effect')
    assert.equal(terminal.receipt.cancelled,true);assert.equal(terminal.receipt.processStarted,false)
    assert.equal(terminal.receipt.processStopped,true);assert.notEqual(terminal.receipt.verification,'passed')
  }finally{release.resolve(true);await f.cleanup()}
})

test('central task stop rejects actual child execution with missing supervisor terminal proof',async()=>{
 const f=await fixture(),original=childProcess.spawn
 try{
  childProcess.spawn=((...args:any[])=>{const child=(original as any)(...args)
   if(Array.isArray(args[1])&&String(args[1][0]).endsWith('/lisp/supervisor.mjs')){const stream=child.stdio[4],emit=stream.emit;stream.emit=function(event:string,...values:any[]){return event==='data'?true:emit.call(this,event,...values)}}
   return child
  }) as typeof childProcess.spawn;syncBuiltinESMExports()
  const result=await f.execute('kioku_exec',{command:'node -e "require(\'fs\').writeFileSync(\'ran-marker\',\'ran\')"'},'lost-terminal')
  assert.equal(await readFile(join(f.root,'ran-marker'),'utf8'),'ran','the actual child ran despite its missing terminal channel')
  assert.equal(result.receipt.processStopped,false)
  assert.equal(await stopTaskOwnedExecutions(f.runtime,f.taskIdentity),false,'exit fields or processStarted=false cannot substitute for terminal proof')
 }finally{childProcess.spawn=original;syncBuiltinESMExports();await f.cleanup()}
})
