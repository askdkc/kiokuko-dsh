import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { bindTaskRepository } from '../../../src/dsh/task-state.js'
import { NativeTaskAuthority, stopTaskNativeChildren } from '../../../src/dsh/native-task-authority.js'

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done}); return {promise,resolve} }
async function bounded<T>(promise:Promise<T>):Promise<T> {
  const controller=new AbortController()
  try { return await Promise.race([promise,delay(500,undefined,{signal:controller.signal}).then(()=>{throw new Error('Caller did not settle promptly')})]) }
  finally { controller.abort() }
}
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'kioku-native-stop-')))
  await mkdir(join(root,'.git'))
  const db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  const task=await prepareAgentTask(db,{requestId:'stop',cwd:root,task:'Inspect source.',dshSessionId:'parent-session',completionMode:'enforce',profileHints:{taskType:'research',target:'source',expected:'Observed output',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
  const parent:any={id:'parent',session:{id:'parent-session',header:{cwd:root}}}
  const identity={runId:task.run.runId,sessionId:parent.session.id,workspace:task.project.workspace,repositoryRoot:root,generation:'host-generation',agent:parent}
  const taskIdentity={taskId:identity.runId,sessionId:identity.sessionId,repositoryRoot:root};bindTaskRepository(db,taskIdentity)
  const agents=new Map<string,any>([[parent.id,parent]]),sessions=new Map<string,any>([[parent.session.id,parent.session]])
  const launchGate=deferred<void>(),entered=deferred<void>(),idleGate=deferred<void>(),idleEntered=deferred<void>()
  let child:any,cancels=0
  const backend={async startActivation(spec:any){entered.resolve();await launchGate.promise;child={id:'child-agent',status:'running',session:{id:spec.childId,header:{cwd:root,parentSession:parent.session.id,origin:'subagent',delegationDepth:1}},cancel(){cancels++},async whenIdle(){idleEntered.resolve();await idleGate.promise}};agents.set(child.id,child);sessions.set(child.session.id,child.session);return {childId:spec.childId}}}
  const runtime:any={withDatabase:async(fn:any)=>fn(db)}
  const authority=new NativeTaskAuthority({runtime,repositoryRoot:root,backend,agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},sessions,resolveParent:execution=>execution.agent===parent?identity:undefined})
  const start=()=>backend.startActivation({provider:'spawn',delivery:'parent',request:{parent},childId:'child-session'})
  const state=()=>db.prepare('SELECT state FROM dsh_owned_operations WHERE operation_id=?').get<any>('native-child:child-session')?.state
  return {authority,runtime,taskIdentity,start,entered,launchGate,idleEntered,state,agents,sessions,get child(){return child},get cancels(){return cancels},finish(){if(child)child.status='idle';idleGate.resolve()},async cleanup(){launchGate.resolve();if(child)child.status='idle';idleGate.resolve();await new Promise(r=>setImmediate(r));authority.dispose();db.close();await rm(root,{recursive:true,force:true})}}
}

test('aborted stop returns promptly during launch but cancels and confirms the exact late child',async()=>{
  const f=await fixture();const launch=f.start()
  try {
    await f.entered.promise
    const controller=new AbortController(),reason=new Error('stop caller cancelled')
    const stopped=f.authority.stopTask(f.taskIdentity,controller.signal);controller.abort(reason)
    await assert.rejects(bounded(stopped),error=>error===reason)
    assert.equal(f.state(),'started','unresolved launch is not completed')
    f.launchGate.resolve();await launch;await bounded(f.idleEntered.promise)
    assert.equal(f.cancels,1);assert.equal(f.authority.resolve({agent:f.child}),undefined,'stop revokes child execution authority')
    assert.equal(f.state(),'started','cancel request alone is not idle proof')
    f.finish();assert.equal(await bounded(stopTaskNativeChildren(f.runtime,f.taskIdentity)),true)
    assert.equal(f.state(),'completed')
  } finally {f.launchGate.resolve();await launch;await f.cleanup()}
})

test('concurrent stop callers cancel independently while sharing exact idle cleanup',async()=>{
  const f=await fixture();const launch=f.start()
  try {
    await f.entered.promise;f.launchGate.resolve();await launch
    const controller=new AbortController(),reason=new Error('idle caller cancelled')
    const first=f.authority.stopTask(f.taskIdentity,controller.signal)
    await f.idleEntered.promise
    const second=f.authority.stopTask(f.taskIdentity)
    controller.abort(reason)
    await assert.rejects(bounded(first),error=>error===reason)
    assert.equal(f.state(),'started');assert.equal(f.cancels,1)
    f.finish();assert.equal(await bounded(second),true);assert.equal(f.state(),'completed')
  } finally {await f.cleanup()}
})

test('dispose during an unresolved launch still cancels late child without granting authority or terminal proof',async()=>{
  const f=await fixture();const launch=f.start()
  try {
    await f.entered.promise;f.authority.dispose();f.launchGate.resolve();await launch
    await bounded(f.idleEntered.promise);assert.equal(f.cancels,1)
    assert.equal(f.authority.resolve({agent:f.child}),undefined)
    f.finish();await new Promise(r=>setImmediate(r));assert.equal(f.state(),'started')
    assert.equal(await stopTaskNativeChildren(f.runtime,f.taskIdentity),false)
  } finally {await f.cleanup()}
})

test('late idle cannot confirm a replacement runtime object and retry does not grant authority',async()=>{
  const f=await fixture();const launch=f.start()
  try {
    await f.entered.promise;f.launchGate.resolve();await launch
    const stopped=f.authority.stopTask(f.taskIdentity)
    const rejection=assert.rejects(stopped,/runtime identity changed/)
    await f.idleEntered.promise
    f.agents.set(f.child.id,{...f.child});f.finish();await rejection
    assert.equal(f.state(),'started')
    f.agents.set(f.child.id,f.child)
    assert.equal(f.authority.resolve({agent:f.child}),undefined)
    assert.equal(await f.authority.stopTask(f.taskIdentity),true)
    assert.equal(f.state(),'completed')
  } finally {await f.cleanup()}
})

test('already aborted stop does not begin cleanup, and disposal cannot confirm an in-flight stop',async()=>{
  const f=await fixture();const launch=f.start()
  try {
    await f.entered.promise;f.launchGate.resolve();await launch
    const controller=new AbortController();controller.abort(new Error('already cancelled'))
    await assert.rejects(f.authority.stopTask(f.taskIdentity,controller.signal),/already cancelled/)
    assert.equal(f.cancels,0)
    const stopped=f.authority.stopTask(f.taskIdentity)
    await f.idleEntered.promise;f.authority.dispose();f.finish()
    assert.equal(await stopped,false);assert.equal(f.cancels,1);assert.equal(f.state(),'started')
  } finally {await f.cleanup()}
})
