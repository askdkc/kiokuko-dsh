import assert from 'node:assert/strict'
import test from 'node:test'
import { claimRepository } from '../../../../lisp/repository-owner.mjs'
import { processIdentity, sameProcess } from '../../../../lisp/process-identity.mjs'
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { fork, execFileSync } from 'node:child_process'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'

test('initialization reader is not mistaken for a repository owner',{timeout:5000},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'owner-reader-')))
  const lease=claimRepository(root);lease.close()
  const path=join(process.platform==='win32'?tmpdir():'/tmp',`kiokuko-lisp-owners-${process.getuid?.()??'user'}`,
    createHash('sha256').update(root).digest('hex')+'.sqlite3')
  const script=`import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);
    db.exec('BEGIN; SELECT * FROM sqlite_master');process.stdout.write('reader\\n');
    process.stdin.once('data',()=>setTimeout(()=>{db.close();process.exit(0)},80));process.stdin.resume()`
  const child=spawn(process.execPath,['--input-type=module','-e',script,path],{stdio:['pipe','pipe','pipe']})
  const exited=once(child,'exit');let owner:ReturnType<typeof claimRepository>|undefined
  try{
    await once(child.stdout!,'data');child.stdin!.write('release')
    owner=claimRepository(root)
  }finally{owner?.close();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;rmSync(root,{recursive:true,force:true})}
})

type ElectionValue = {state:'owner'|'rejected';reason?:string}
type ElectionChild = ReturnType<typeof fork>
function electionDeferred<T>() {
  let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason?:unknown)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
/** Observe IPC and process termination before any wait; every failed stage drains its own children. */
async function withElectionPair(script:string,root:string,options:{round:number;signal?:AbortSignal;timeoutMs?:number;
  onChild?:(child:ElectionChild)=>void;onStage?:(stage:string)=>void},verify:(values:ElectionValue[])=>void):Promise<void> {
  const fatal=electionDeferred<never>();void fatal.promise.catch(()=>{})
  let stage='spawn',stopping=false
  const fail=(code:string)=>{if(!stopping)fatal.reject(new Error(`round ${options.round}: ${code} during ${stage}`))}
  const children:Array<{child:ElectionChild;phase:string;value:ElectionValue|undefined;ready:ReturnType<typeof electionDeferred<void>>;
    result:ReturnType<typeof electionDeferred<ElectionValue>>;closed:ReturnType<typeof electionDeferred<void>>}>=[]
  const deadline=setTimeout(()=>fail('deadline'),options.timeoutMs??5000)
  const abort=()=>fail('aborted');options.signal?.addEventListener('abort',abort,{once:true})
  const enter=(value:string)=>{stage=value;options.onStage?.(value);options.signal?.throwIfAborted()}
  try {
    options.signal?.throwIfAborted()
    for(let index=0;index<2;index++) {
      const child=fork(script,[root],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
      const state={child,phase:'waiting',value:undefined as ElectionValue|undefined,ready:electionDeferred<void>(),
        result:electionDeferred<ElectionValue>(),closed:electionDeferred<void>()}
      children.push(state)
      child.on('message',(value:any)=>{
        if(stopping)return
        if(state.phase==='waiting'&&value==='waiting'){state.phase='ready';state.ready.resolve();return}
        if(state.phase==='claim'&&value&&(value.state==='owner'||value.state==='rejected'&&typeof value.reason==='string')){
          state.value=value;state.phase=value.state;state.result.resolve(value);return
        }
        fail(`child ${index} invalid IPC`)
      })
      child.on('error',()=>fail(`child ${index} process error`))
      child.on('disconnect',()=>{if(state.value?.state!=='rejected')fail(`child ${index} IPC disconnected`)})
      child.on('exit',(code)=>{if(state.value?.state!=='rejected'||code!==0)fail(`child ${index} exited before verification`)})
      child.once('close',()=>state.closed.resolve())
      options.onChild?.(child)
    }
    enter('ready')
    await Promise.race([Promise.all(children.map(s=>s.ready.promise)),fatal.promise])
    for(const state of children)state.phase='claim'
    enter('claim')
    for(const {child} of children) {
      try{child.send('go',error=>{if(error)fail('IPC send failed')})}catch{fail('IPC send failed')}
    }
    const values=await Promise.race([Promise.all(children.map(s=>s.result.promise)),fatal.promise])
    enter('verify');verify(values)
  } finally {
    stopping=true;clearTimeout(deadline);options.signal?.removeEventListener('abort',abort)
    for(const {child} of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([Promise.all(children.map(s=>s.closed.promise)),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`round ${options.round}: child cleanup unconfirmed`)),2000)
    })])}finally{clearTimeout(timer)}
  }
}

test('fresh concurrent SQLite admissions elect one owner, including before runtime ready',{timeout:30000},async t=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'owner-election-'))),started=performance.now()
  const script=join(base,'contender.mjs'),children=new Set<ElectionChild>(),controller=new AbortController()
  const signal=AbortSignal.any([t.signal,controller.signal])
  writeFileSync(script,`import{claimRepository}from ${JSON.stringify(new URL('../../../../lisp/repository-owner.mjs',import.meta.url).href)};
    process.once('message',()=>{try{const lease=claimRepository(process.argv[2]);
      process.once('message',()=>{lease.close();process.exit(0)});process.send({state:'owner'})}
      catch(error){process.send({state:'rejected',reason:error.message},error=>process.exit(error?1:0))}})
    process.send('waiting')`)
  let next=0,completed=0
  // Independent repositories permit two bounded pairs. Keep all 24 cold-process
  // elections and the original 30s test deadline without adding serial lock waits.
  const run=async()=>{
    while(next<24){
      signal.throwIfAborted();const round=next++,root=mkdtempSync(join(base,'repo-')),roundStarted=performance.now()
      t.diagnostic(JSON.stringify({round,phase:'start',elapsedMs:Math.round(performance.now()-started)}))
      await withElectionPair(script,root,{round,signal,onChild:child=>children.add(child)},values=>{
        assert.equal(values.filter(v=>v.state==='owner').length,1,JSON.stringify({round,values}))
        assert.equal(values.find(v=>v.state==='rejected')!.reason,'REPOSITORY_IN_USE')
        assert.throws(()=>claimRepository(root),/REPOSITORY_IN_USE/,'owner is protected before SBCL readiness')
      })
      const recovered=claimRepository(root);recovered.close();completed++
      t.diagnostic(JSON.stringify({round,phase:'complete',durationMs:Math.round(performance.now()-roundStarted),completed}))
    }
  }
  const workers=[run(),run()]
  try{await Promise.all(workers);assert.equal(completed,24)}
  finally{
    controller.abort();await Promise.allSettled(workers)
    assert.ok([...children].every(c=>c.exitCode!==null||c.signalCode!==null),'all fixture children must terminate before removing their repositories')
    rmSync(base,{recursive:true,force:true})
  }
})

for(const [fault,source,expected] of [
  // Node may notify IPC disconnect before exit for an abruptly terminated child.
  ['early exit',`process.exit(7)`,/(?:IPC disconnected|exited before verification) during ready/],
  ['IPC disconnect',`process.once('message',()=>process.disconnect());process.send('waiting')`,/IPC disconnected/],
  ['invalid IPC',`process.on('message',()=>process.send({state:'invalid'}));process.send('waiting')`,/invalid IPC/],
  ['no result',`process.on('message',()=>{});process.send('waiting')`,/deadline during claim/],
] as const)test(`owner election supervision rejects ${fault} and confirms cleanup`,{timeout:10000},async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'owner-supervision-'))),script=join(base,'fault.mjs'),children:ElectionChild[]=[]
  writeFileSync(script,source)
  try{
    await assert.rejects(withElectionPair(script,base,{round:0,onChild:child=>children.push(child)},()=>assert.fail('an incomplete election cannot reach verification')),expected)
    assert.equal(children.length,2);assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null))
  }finally{if(children.every(c=>c.exitCode!==null||c.signalCode!==null))rmSync(base,{recursive:true,force:true})}
})

test('owner election supervision cancels before claim and confirms cleanup',{timeout:10000},async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'owner-cancel-'))),script=join(base,'waiting.mjs'),children:ElectionChild[]=[]
  const controller=new AbortController();writeFileSync(script,`process.on('message',()=>{});process.send('waiting')`)
  try{
    await assert.rejects(withElectionPair(script,base,{round:0,signal:controller.signal,onChild:child=>children.push(child),
      onStage:stage=>{if(stage==='claim')controller.abort()}},()=>assert.fail('cancelled election cannot reach verification')),{name:'AbortError'})
    assert.equal(children.length,2);assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null))
  }finally{if(children.every(c=>c.exitCode!==null||c.signalCode!==null))rmSync(base,{recursive:true,force:true})}
})

test('invalid repository and denied lock directory are not classified as contention',()=>{
  assert.throws(()=>claimRepository('/nonexistent-kiokuko-owner-test'),error=>(error as NodeJS.ErrnoException).code==='ENOENT')
  const base=realpathSync(mkdtempSync(join(tmpdir(),'owner-denied-')))
  const directory=join(process.platform==='win32'?tmpdir():'/tmp',`kiokuko-lisp-owners-${process.getuid?.()??'user'}`)
  const module=new URL('../../../../lisp/repository-owner.mjs',import.meta.url).href
  // The fs boundary alone is injected; SQLite/process ownership code is real.
  const script=`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const original=fs.lstatSync;
    fs.lstatSync=(path,...args)=>{if(path===${JSON.stringify(directory)}){const e=new Error('denied');e.code='EACCES';throw e}return original(path,...args)};
    syncBuiltinESMExports();const{claimRepository}=await import(${JSON.stringify(module)});
    try{claimRepository(${JSON.stringify(base)});process.exit(2)}catch(e){if(e.code!=='EACCES'||e.message==='REPOSITORY_IN_USE')process.exit(3)}`
  try{execFileSync(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'})}finally{rmSync(base,{recursive:true,force:true})}
})

test('process birth fingerprint distinguishes a reused PID and a live current owner',async()=>{
  const identity=processIdentity(process.pid)
  if(process.platform==='linux'||process.platform==='darwin')assert.match(identity!,/^[a-f0-9]{64}$/)
  assert.equal(sameProcess(process.pid,identity),true)
  if(identity)assert.equal(sameProcess(process.pid,identity==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64)),false)
  const db=openConnection(':memory:');migrateDatabase(db)
  try{
    const store=new LispStore(async f=>f(db)),owner={sessionId:'reuse',agentId:'agent',root:'/fixture'}
    await store.enable(owner)
    db.prepare('INSERT INTO dsh_lisp_session_hosts VALUES(?,?,?,?)').run(owner.sessionId,owner.root,`${'0'.repeat(64)}:old-host`,process.pid)
    if(identity)await store.claimSession(owner,`${identity}:new-host`)
    if(identity)await assert.rejects(store.claimSession(owner,`${identity}:competitor`),{code:'SESSION_IN_USE'})
    if(identity){
      await store.releaseHost(`${identity}:new-host`)
      db.prepare('INSERT INTO dsh_lisp_session_hosts VALUES(?,?,?,?)').run(owner.sessionId,owner.root,'legacy-without-birth-identity',process.pid)
      await assert.rejects(store.claimSession(owner,`${identity}:new-host`),error=>(error as any).code==='SESSION_IN_USE'&&/PID だけでは確認できません/.test(String(error)))
      assert.equal(db.prepare('SELECT host_id FROM dsh_lisp_session_hosts WHERE session_id=?').get(owner.sessionId)!.host_id,'legacy-without-birth-identity')
    }
  }finally{db.close()}
})

test('supervisor crash cannot donate a still-live runtime; PID birth mismatch permits recovery without killing it',{timeout:10000},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'owner-metadata-')))
  const module=new URL('../../../../lisp/repository-owner.mjs',import.meta.url).href
  const script=`import{claimRepository}from ${JSON.stringify(module)};const lease=claimRepository(process.argv[1]);lease.recordRuntime(process.ppid);process.stdout.write('ready\\n');setInterval(()=>{},1000)`
  const child=spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','pipe','pipe']})
  let lease:ReturnType<typeof claimRepository>|undefined
  try{
    await once(child.stdout!,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited
    assert.throws(()=>claimRepository(root),/REPOSITORY_IN_USE/)
    const directory=join(process.platform==='win32'?tmpdir():'/tmp',`kiokuko-lisp-owners-${process.getuid?.()??'user'}`)
    const metadata=join(directory,createHash('sha256').update(root).digest('hex')+'.sqlite3.owner.json')
    const record=JSON.parse(readFileSync(metadata,'utf8'));assert.equal(record.pid,process.pid)
    if(processIdentity(process.pid)){
      record.identity='0'.repeat(64);writeFileSync(metadata,JSON.stringify(record))
      lease=claimRepository(root);assert.equal(sameProcess(process.pid,processIdentity(process.pid)),true)
      lease.recordRuntime(process.pid)
    }
  }finally{
    lease?.close();if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}
    rmSync(root,{recursive:true,force:true})
  }
})
