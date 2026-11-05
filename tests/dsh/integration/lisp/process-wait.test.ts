import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { workingLispTask } from '../../helpers/lisp-task.js'

for (const executionMode of ['development','protected'] as const) test(`${executionMode}: bounded process waits preserve Lisp state beyond its default evaluation budget`, {
  skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires SBCL':false,timeout:90000,
},async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-process-wait-'))),root=join(base,'repo')
  await mkdir(root)
  const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:'))
  const owner={sessionId:'waiting-session',agentId:'waiting-agent',root}
  workingLispTask(db,owner)
  const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),
    config:LispConfig.parse({enabled:true,executionMode,timeoutMs:1000,startupTimeoutMs:60000}),
    toolCall:async()=>{throw new Error('This fixture uses the native process adapter')}})
  let dispatches=0
  const native={assertCurrent(){},async run(input:any,signal:AbortSignal){
    dispatches++
    const value=await promisify(execFile)(input.program,input.argv,{cwd:root,timeout:input.timeoutMs,signal})
    return {code:0,...value,receipt:{route:'native',processStopped:true}}
  }}
  const run=(operationId:string,code:string,timeoutMs?:number)=>manager.execute(owner,'lisp_eval',
    {operationId,code,...(timeoutMs===undefined?{}:{timeoutMs})},undefined,executionMode==='development'?native:undefined) as Promise<any>
  const wait=`(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" "setTimeout(()=>console.log('done'),1600)") :timeout-ms 5000)`
  try{
    await manager.start();await manager.enable(owner)
    const before=await run('define-state','(defparameter *retained-value* 41)')
    assert.equal(before.ok,true,JSON.stringify(before))
    const result=await run('long-host-wait',`${wait} (+ *retained-value* 1)`)
    assert.equal(result.ok,true,'a host process wait must not kill Lisp: '+JSON.stringify(result))
    assert.equal(result.value.json,42)
    assert.equal(result.generation,before.generation)
    const next=await run('after-host-wait','(+ *retained-value* 1)')
    assert.equal(next.ok,true,JSON.stringify(next));assert.equal(next.generation,before.generation)
    assert.equal((await manager.status(owner) as any).managedReconciliationRequired,false)
    if(executionMode==='development')assert.equal(dispatches,1,'no process replay')
    const explicit=await run('explicit-deadline',wait,100)
    assert.equal(explicit.code,'TIMEOUT','an explicit total deadline still cancels the operation')
  }finally{await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
