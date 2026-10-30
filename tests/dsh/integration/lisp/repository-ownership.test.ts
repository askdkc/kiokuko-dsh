import assert from 'node:assert/strict'
import test from 'node:test'
import { fork, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../../src/db/connection.js'
import { LispConfig, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

const native={skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires actual SBCL':false,timeout:120000}
function host(base:string,config:Record<string,unknown>={}) {
  const child=fork(new URL('../../helpers/lisp-host-process.ts',import.meta.url),[base,JSON.stringify(config)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']})
  let sequence=0,stderr='';child.stderr!.on('data',data=>{stderr+=data.toString().slice(0,2000)})
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>(),exited=once(child,'exit')
  child.on('message',({id,value,error}:any)=>{const p=pending.get(id);pending.delete(id);if(error)p?.reject(Object.assign(new Error(error.message),{code:error.code}));else p?.resolve(value)})
  child.on('exit',()=>{for(const p of pending.values())p.reject(new Error(`owned test host exited: ${stderr}`));pending.clear()})
  return {child,exited,call(method:string,owner?:LispOwner,input?:unknown):Promise<any>{const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.send({id,method,owner,input})})},
    async dispose(){if(child.exitCode===null&&child.signalCode===null){await this.call('dispose');await exited}},
    async crash(){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}}}
}
async function fixture(t:import('node:test').TestContext){
  const base=await realpath(await mkdtemp(join(tmpdir(),'repo-lisp-owner-')))
  const roots=[join(base,'repo-a'),join(base,'repo-b')]
  for(const root of roots){await mkdir(root);execFileSync('git',['init','-q',root])}
  const homes=[join(base,'host-a'),join(base,'host-b'),join(base,'competitor')]
  const owners=roots.map((root,i)=>({root,sessionId:`session-${i}`,agentId:`agent-${i}`}))
  const dbs:ReturnType<typeof openConnection>[]=[]
  for(let i=0;i<homes.length;i++){await mkdir(homes[i]!);const db=openConnection(join(homes[i]!,'state.sqlite3'));dbs.push(db);workingLispTask(db,owners[i===2?0:i]!)}
  return{base,roots,homes,owners,dbs,async close(){for(const db of dbs)db.close();await rm(base,{recursive:true,force:true})}}
}
async function until(check:()=>Promise<boolean>){const end=Date.now()+5000;while(!await check()){assert.ok(Date.now()<end,'owned process did not settle');await new Promise(r=>setTimeout(r,10))}}
async function stopped(pid:number){
  try{process.kill(pid,0);if(process.platform!=='linux')return false
    const stat=await readFile(`/proc/${pid}/stat`,'utf8');return /^[ZX] /.test(stat.slice(stat.lastIndexOf(')')+2))
  }catch(error){return ['ESRCH','ENOENT'].includes((error as NodeJS.ErrnoException).code??'')}
}

test('repository ownership rejects a second session through an alias and a separate database',native,async t=>{
  const f=await fixture(t),first=host(f.homes[0]!),competitor=host(f.homes[2]!)
  t.after(async()=>{await first.dispose();await competitor.dispose();await f.close()})
  const alias=join(f.base,'alias-a');await symlink(f.roots[0]!,alias)
  // Session working directories are canonical; a subdirectory still belongs to the same Git repo.
  const sub=join(f.roots[0]!,'src');await mkdir(sub)
  const other={root:sub,sessionId:'another-session',agentId:'another-agent'}
  workingLispTask(f.dbs[2]!,other,'another-session')
  await Promise.all([first.call('start'),competitor.call('start')]);await first.call('enable',f.owners[0])
  const before=await first.call('lisp_status',f.owners[0])
  await assert.rejects(competitor.call('enable',other),{code:'REPOSITORY_IN_USE'})
  const aliasOwner={root:await realpath(alias),sessionId:'alias-session',agentId:'alias-agent'}
  workingLispTask(f.dbs[2]!,aliasOwner,'alias-session')
  await assert.rejects(competitor.call('enable',aliasOwner),{code:'REPOSITORY_IN_USE'})
  assert.equal((await first.call('lisp_status',f.owners[0])).supervisorPid,before.supervisorPid)
  assert.equal((await first.call('lisp_eval',f.owners[0],{operationId:'still-alive',code:'(+ 40 2)'})).value.printed,'(42)')
  assert.equal(await realpath(alias),f.roots[0])
})

test('capacity rejection preserves another repository worker and its definitions',native,async t=>{
  const f=await fixture(t),owner=host(f.homes[0]!,{maxWorkers:1})
  workingLispTask(f.dbs[0]!,f.owners[1]!)
  t.after(async()=>{await owner.dispose();await f.close()});await owner.call('start');await owner.call('enable',f.owners[0])
  await owner.call('lisp_eval',f.owners[0],{operationId:'set-token',code:'(defparameter *repo-token* 17)'})
  const before=await owner.call('lisp_status',f.owners[0])
  await assert.rejects(owner.call('enable',f.owners[1]),{code:'WORKER_LIMIT'})
  assert.equal((await owner.call('lisp_status',f.owners[0])).supervisorPid,before.supervisorPid)
  assert.equal((await owner.call('lisp_eval',f.owners[0],{operationId:'read-token',code:'*repo-token*'})).value.printed,'(17)')
  assert.equal(LispConfig.parse({}).idleTimeoutMs,0,'default idle behavior preserves repository state')
})

test('persistent hot install reuses only its owner and preserves PID, heap, replay and active code',native,async t=>{
  const f=await fixture(t),owner=f.owners[0]!
  let catalogs=0
  const manager=new LispManager({store:new LispStore(async fn=>fn(f.dbs[0]!)),dataRoot:join(f.homes[0]!,'data'),
    toolCatalog:()=>{catalogs++;return []},
    config:LispConfig.parse({enabled:true,executionMode:'development',maxWorkers:1,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}),
    questions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:[q.questions[0].intent!.approve]}]})}})
  t.after(async()=>{await manager.dispose();await f.close()})
  await manager.start();const status=await manager.enable(owner) as any
  assert.equal((await manager.execute(owner,'lisp_eval',{operationId:'keep-heap',code:'(defparameter *repo-token* 17)'}) as any).ok,true)
  const contract=await manager.execute(owner,'lisp_hot_contract',{operationId:'contract',name:'add-one',description:'Add one',inputSchema:{type:'integer'},outputSchema:{type:'integer'},properties:[{input:1,expected:2},{input:4,expected:5}]}) as any
  assert.equal(contract.ok,true)
  const install={operationId:'install',name:'add-one',contractRef:contract.contractRef,expectedRevision:0,source:"(lambda (x) (assert (not (boundp '*repo-token*))) (+ x 1))"}
  const installed=await manager.execute(owner,'lisp_hot_install',install) as any
  assert.equal(installed.ok,true,JSON.stringify(installed));assert.equal(installed.revision,1)
  const replay=await manager.execute(owner,'lisp_hot_install',install) as any
  assert.equal(replay.replay,true)
  const called=await manager.execute(owner,'lisp_hot_call',{operationId:'call',name:'add-one',input:41}) as any
  assert.equal(called.ok,true,JSON.stringify(called));assert.equal(called.value,42);assert.equal(called.generation,status.generation)
  const wrong=await manager.execute(owner,'lisp_hot_install',{...install,operationId:'bad-update',expectedRevision:1,source:'(lambda (x) (+ x 2))'}) as any
  assert.equal(wrong.code,'HOT_PROPERTY_FAILED')
  const rpc=await manager.execute(owner,'lisp_hot_install',{...install,operationId:'rpc-update',expectedRevision:1,source:'(lambda (x) (kioku.tools:available-tools) (+ x 1))'}) as any
  assert.equal(rpc.code,'TASK_EXECUTION_FAILED');assert.equal(catalogs,0,'resident hot code cannot invoke host RPC')
  assert.equal((await manager.execute({...owner,agentId:'other-agent'},'lisp_hot_call',{operationId:'other-agent-call',name:'add-one',input:41}) as any).code,'REPOSITORY_IN_USE')
  assert.equal((await manager.execute(owner,'lisp_hot_call',{operationId:'call-after-failure',name:'add-one',input:41}) as any).value,42)
  const another={...owner,sessionId:'other-session',agentId:'other-agent'}
  workingLispTask(f.dbs[0]!,another);await manager.enableTask(another)
  const rejected=await manager.execute(another,'lisp_hot_call',{operationId:'other-call',name:'add-one',input:41}) as any
  assert.equal(rejected.code,'REPOSITORY_IN_USE','a different owner cannot borrow the persistent heap')
  const after=await manager.status(owner) as any
  assert.equal(after.runtimePid,status.runtimePid);assert.equal(after.supervisorPid,status.supervisorPid);assert.equal(after.generation,status.generation)
  assert.equal((await manager.execute(owner,'lisp_eval',{operationId:'read-kept-heap',code:'*repo-token*'}) as any).value.printed,'(17)')
  await manager.disable(owner);await manager.disable(another);await manager.enableTask(owner)
  const result=await manager.execute(owner,'lisp_eval',{operationId:'task-calc',code:'(+ 40 2)'}) as any
  assert.equal(result.ok,true);assert.equal(result.value.printed,'(42)')
})

test('simultaneous repository admission elects exactly one runtime across databases',native,async t=>{
  const f=await fixture(t),hosts=[host(f.homes[0]!),host(f.homes[2]!)]
  t.after(async()=>{await Promise.all(hosts.map(h=>h.dispose()));await f.close()})
  await Promise.all(hosts.map(h=>h.call('start')))
  const results=await Promise.allSettled(hosts.map(h=>h.call('enable',f.owners[0])))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult
  assert.equal(failure.reason.code,'REPOSITORY_IN_USE')
  const winner=hosts[results.findIndex(r=>r.status==='fulfilled')]!
  assert.equal((await winner.call('lisp_eval',f.owners[0],{operationId:'race-winner',code:'(+ 40 2)'})).value.printed,'(42)')
})

test('parallel actual repository workers keep separate PIDs/state through cancellation, shutdown and crash recovery',native,async t=>{
  const f=await fixture(t),a=host(f.homes[0]!),b=host(f.homes[1]!),replacement=host(f.homes[0]!)
  t.after(async()=>{await Promise.all([a.dispose(),b.dispose(),replacement.dispose()]);await f.close()})
  await Promise.all([a.call('start'),b.call('start')]);const [sa,sb]=await Promise.all([a.call('enable',f.owners[0]),b.call('enable',f.owners[1])])
  assert.equal(sa.state,'READY');assert.equal(sb.state,'READY');assert.notEqual(sa.supervisorPid,sb.supervisorPid)
  assert.ok(Number.isInteger(sa.runtimePid)&&Number.isInteger(sb.runtimePid));assert.notEqual(sa.runtimePid,sb.runtimePid)
  assert.equal((await a.call('enable',f.owners[0])).runtimePid,sa.runtimePid,'normal reconnect keeps the owned worker')
  if(process.platform==='linux'){for(const pid of [sa.runtimePid,sb.runtimePid])assert.match(await readFile(`/proc/${pid}/comm`,'utf8'),/sbcl/)}
  await Promise.all([a.call('lisp_eval',f.owners[0],{operationId:'token',code:'(defparameter *repo-token* 11)'}),b.call('lisp_eval',f.owners[1],{operationId:'token',code:'(defparameter *repo-token* 22)'})])
  const running=a.call('lisp_eval',f.owners[0],{operationId:'cancel',code:'(sleep 30)'})
  await until(async()=>f.dbs[0]!.prepare("SELECT state FROM dsh_lisp_operations WHERE operation_id='cancel'").get()?.state==='RUNNING')
  await a.call('lisp_cancel',f.owners[0]);assert.equal((await running).ok,false)
  assert.equal((await b.call('lisp_eval',f.owners[1],{operationId:'after-cancel',code:'*repo-token*'})).value.printed,'(22)')
  await a.call('recover',f.owners[0]);const crashed=a.call('lisp_eval',f.owners[0],{operationId:'crash',code:'(sleep 30)'}).catch(()=>undefined)
  await until(async()=>f.dbs[0]!.prepare("SELECT state FROM dsh_lisp_operations WHERE operation_id='crash'").get()?.state==='RUNNING')
  const dead=await a.call('lisp_status',f.owners[0]);await a.crash();await crashed
  await until(()=>stopped(dead.runtimePid))
  await replacement.call('start');await replacement.call('enable',f.owners[0])
  assert.equal(f.dbs[0]!.prepare("SELECT state FROM dsh_lisp_operations WHERE operation_id='crash'").get()?.state,'UNKNOWN')
  assert.equal((await replacement.call('recover',f.owners[0])).state,'READY')
  assert.equal((await replacement.call('lisp_eval',f.owners[0],{operationId:'new-eval',code:'(+ 40 2)'})).value.printed,'(42)')
  assert.equal((await b.call('lisp_status',f.owners[1])).runtimePid,sb.runtimePid)
  assert.equal((await b.call('lisp_eval',f.owners[1],{operationId:'after-crash',code:'*repo-token*'})).value.printed,'(22)')
  await replacement.dispose()
  assert.equal((await b.call('lisp_eval',f.owners[1],{operationId:'after-shutdown',code:'*repo-token*'})).value.printed,'(22)')
})

test('a killed supervisor leaves live-runtime evidence and never authorizes a duplicate',native,async t=>{
  const f=await fixture(t),first=host(f.homes[0]!),replacement=host(f.homes[2]!),other=host(f.homes[1]!)
  let orphan:number|undefined
  t.after(async()=>{
    if(orphan){try{process.kill(orphan,'SIGKILL')}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}}
    await Promise.all([first.dispose(),replacement.dispose(),other.dispose()]);await f.close()
  })
  await Promise.all([first.call('start'),other.call('start')])
  const [original,independent]=await Promise.all([first.call('enable',f.owners[0]),other.call('enable',f.owners[1])])
  orphan=original.runtimePid
  process.kill(original.supervisorPid,'SIGKILL')
  await until(async()=>(await first.call('lisp_status',f.owners[0])).state!=='READY')
  await assert.rejects(first.call('dispose'),{code:'STOP_UNCONFIRMED'})
  await replacement.call('start')
  await assert.rejects(replacement.call('enable',f.owners[0]),{code:'REPOSITORY_IN_USE'})
  assert.equal((await other.call('lisp_status',f.owners[1])).runtimePid,independent.runtimePid)
  process.kill(orphan!,'SIGKILL')
  await until(()=>stopped(orphan!))
  orphan=undefined
  await first.dispose()
  assert.equal((await replacement.call('recover',f.owners[0])).state,'READY')
})

test('busy and cancelled resident hot calls keep another repository alive',native,async t=>{
  const f=await fixture(t),owner=f.owners[0]!,other=f.owners[1]!
  workingLispTask(f.dbs[0]!,other)
  const manager=new LispManager({store:new LispStore(async fn=>fn(f.dbs[0]!)),dataRoot:join(f.homes[0]!,'data'),
    config:LispConfig.parse({enabled:true,executionMode:'development',maxWorkers:2,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}),
    questions:{ask:async q=>({answers:[{id:q.questions[0].id,selected:[q.questions[0].intent!.approve]}]})}})
  t.after(async()=>{await manager.dispose();await f.close()})
  await manager.start();await manager.enable(owner);const otherStatus=await manager.enable(other) as any
  const contract=await manager.execute(owner,'lisp_hot_contract',{operationId:'slow-contract',name:'slow-add',description:'Add one',inputSchema:{type:'integer'},outputSchema:{type:'integer'},properties:[{input:1,expected:2}]}) as any
  const installed=await manager.execute(owner,'lisp_hot_install',{operationId:'slow-install',name:'slow-add',contractRef:contract.contractRef,expectedRevision:0,source:'(lambda (x) (when (= x 41) (sleep 5)) (+ x 1))'}) as any
  assert.equal(installed.ok,true,JSON.stringify(installed))
  let entered!:()=>void
  const running=new Promise<void>(resolve=>{entered=resolve})
  const {LispWorker}=await import('../../../../src/dsh/lisp/worker.js')
  const request=LispWorker.prototype.request
  t.mock.method(LispWorker.prototype,'request',function(this:InstanceType<typeof LispWorker>,...args:Parameters<typeof request>){
    const result=request.apply(this,args)
    if(args[0]==='task')entered()
    return result
  })
  const abort=new AbortController()
  const calling=manager.execute(owner,'lisp_hot_call',{operationId:'slow-call',name:'slow-add',input:41},abort.signal)
  await running
  const busy=await manager.execute(owner,'lisp_eval',{operationId:'while-hot',code:'(+ 1 1)'}) as any
  assert.equal(busy.code,'BUSY')
  abort.abort()
  assert.equal((await calling as any).code,'CANCELLED')
  assert.equal((await manager.status(owner) as any).state,'RECOVERY_REQUIRED')
  assert.equal((await manager.status(other) as any).runtimePid,otherStatus.runtimePid)
  assert.equal((await manager.execute(other,'lisp_eval',{operationId:'other-still-live',code:'(+ 40 2)'}) as any).value.printed,'(42)')
})
