import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { workingLispTask } from '../../helpers/lisp-task.js'

test('disable kills a frozen Lisp, its stopped supervisor and a TERM-resistant job; enable starts a usable fresh heap', {
  skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires SBCL':false,timeout:90000,
},async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-hard-restart-'))),root=join(base,'repo'),dataRoot=join(base,'runtime')
  await mkdir(root)
  const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:')),store=new LispStore(async fn=>fn(db))
  const owner={sessionId:'hard-restart',agentId:'agent',root},other={...owner,sessionId:'unrelated'}
  workingLispTask(db,owner);workingLispTask(db,other)
  const manager=new LispManager({store,dataRoot,config:LispConfig.parse({enabled:true,executionMode:'protected',startupTimeoutMs:60000})})
  let supervisor:number|undefined
  const until=async<T>(read:()=>Promise<T|undefined>):Promise<T>=>{
    const end=Date.now()+10000
    for(;;){const value=await read();if(value!==undefined)return value;assert.ok(Date.now()<end,'process did not reach expected state');await new Promise(resolve=>setTimeout(resolve,20))}
  }
  const gone=(pid:number)=>assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
  try{
    await manager.start();await manager.enable(owner);await manager.enable(other)
    const old=await manager.status(owner) as any;supervisor=old.supervisorPid
    const started=await manager.execute(owner,'lisp_eval',{operationId:'start-job',code:`(defparameter *old-heap* 41) (kioku.process:start-job "node" (list "-e" ${JSON.stringify('process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.env.KIOKU_SCRATCH+"job.pid",String(process.pid));setInterval(()=>{},1000)')}) :timeout-ms 60000)`}) as any
    assert.equal(started.ok,true,JSON.stringify(started))
    const jobPid=await until(async()=>{
      for(const dir of await readdir(dataRoot))if(dir.startsWith('w-')){
        const value=await readFile(join(dataRoot,dir,'scratch','job.pid'),'utf8').catch(()=>undefined)
        if(value)return Number(value)
      }
    })
    process.kill(old.runtimePid,'SIGSTOP')
    const interrupted=manager.execute(owner,'lisp_eval',{operationId:'interrupted',code:'(loop)'})
    await until(async()=>(await manager.status(owner) as any).state==='EVALUATING'?true:undefined)
    // Stop can reach a helper suspended by a debugger or OS, too.
    process.kill(supervisor!,'SIGSTOP')
    const stopping=manager.disable(owner)
    await assert.rejects(manager.enable(owner),{code:'BUSY'},'enable cannot race termination')
    const disabled=await stopping as any
    assert.equal(disabled.state,'DISABLED')
    await interrupted
    gone(old.runtimePid);gone(supervisor!);supervisor=undefined
    // Linux jobs report a PID inside their private namespace. Their supervisor
    // confirms namespace teardown; only macOS exposes this PID to the host.
    if(process.platform==='darwin')gone(jobPid)
    assert.equal((await store.get(owner,'interrupted'))!.state,'UNKNOWN','termination must not fabricate evaluation success')
    assert.equal((await manager.enable(owner) as any).state,'READY')
    const fresh=await manager.execute(owner,'lisp_eval',{operationId:'fresh',code:'(list (boundp (quote *old-heap*)) (+ 20 22))'}) as any
    assert.equal(fresh.ok,true,JSON.stringify(fresh));assert.notEqual(fresh.generation,old.generation)
    assert.equal(fresh.value.printed,'((NIL 42))')
    const replay=await manager.execute(owner,'lisp_eval',{operationId:'interrupted',code:'(loop)'}) as any
    assert.equal(replay.replay,true);assert.equal(replay.state,'UNKNOWN')
    assert.equal((await manager.execute(other,'lisp_eval',{operationId:'unrelated-still-alive',code:'(+ 20 22)'}) as any).value.json,42)
    await manager.disable(owner);await manager.enable(owner)
    assert.equal((await manager.execute(owner,'lisp_eval',{operationId:'second-restart',code:'42'}) as any).value.json,42)
  }finally{
    if(supervisor)try{process.kill(supervisor,'SIGCONT')}catch{}
    await manager.dispose();db.close();await rm(base,{recursive:true,force:true})
  }
})
