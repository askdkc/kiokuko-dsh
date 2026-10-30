import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LispWorker } from '../../../../src/dsh/lisp/worker.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'

// Protocol consumer only: this Node fixture executes no Lisp or requested effects.
// Real SBCL and OS isolation are tested separately.
test('resident task RPC denial is request-local and cannot inherit persistent host capabilities', async t => {
  const base=await mkdtemp(join(tmpdir(),'hot-rpc-'))
  const library=join(base,'library'),scratch=join(base,'scratch'),inputs=join(base,'inputs'),cache=join(base,'cache')
  for(const path of [library,scratch,inputs,cache])await mkdir(path)
  await writeFile(join(library,'supervisor.mjs'),`import {createReadStream,writeSync} from 'node:fs';
import {createInterface} from 'node:readline';
const send=value=>writeSync(3,JSON.stringify(value)+'\\n');let pending;
send({version:1,type:'ready'});
createInterface({input:createReadStream('',{fd:3,autoClose:false})}).on('line',line=>{
 const f=JSON.parse(line);if(f.method){pending=f.id;send({version:1,type:'rpc',id:'rpc',request:pending,method:f.code,arguments:{}})}
 else send({version:1,type:'result',id:pending,ok:true,value:f,proposals:[]});
});`)
  let effects=0
  const worker=new LispWorker({base,library,scratch,inputs,cache,protected:false},
    LispConfig.parse({executionMode:'protected',sbclPath:process.execPath,startupTimeoutMs:2000}),async()=>{effects++;return 'allowed'})
  t.after(async()=>{await worker.stop();await rm(base,{recursive:true,force:true})})
  await worker.start()
  assert.equal(((await worker.request('eval',{code:'tools-list'},2000)).value as {ok:boolean}).ok,true)
  for(const method of ['task-compile','task'])for(const rpc of ['tools-list','tool-call','run','decisions-evaluate']){
    const result=await worker.request(method,{code:rpc},2000,undefined,false)
    assert.equal((result.value as {code:string}).code,'CAPABILITY_DENIED',`${method}/${rpc}`)
    assert.equal(effects,1,'denial must precede the host adapter')
  }
  assert.equal(((await worker.request('eval',{code:'tools-list'},2000)).value as {ok:boolean}).ok,true)
  assert.equal(effects,2,'normal persistent capabilities return on the next request')
})
