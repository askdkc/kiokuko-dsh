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

test('fresh concurrent SQLite admissions elect one owner, including before runtime ready',{timeout:30000},async()=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'owner-election-')))
  const script=join(base,'contender.mjs')
  writeFileSync(script,`import{claimRepository}from ${JSON.stringify(new URL('../../../../lisp/repository-owner.mjs',import.meta.url).href)};
    process.send('waiting');process.once('message',()=>{try{const lease=claimRepository(process.argv[2]);
      process.send({state:'owner'});process.once('message',()=>{lease.close();process.exit(0)})}
      catch(error){process.send({state:'rejected',reason:error.message});process.exit(0)}})`)
  try {
    for(let round=0;round<24;round++){
      const root=mkdtempSync(join(base,'repo-'))
      const children=[0,1].map(()=>fork(script,[root],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']}))
      const exits=children.map(c=>once(c,'exit'))
      try{
        await Promise.all(children.map(c=>once(c,'message')))
        const results=children.map(c=>once(c,'message'));children.forEach(c=>c.send('go'))
        const values=(await Promise.all(results)).map(([value])=>value as {state:string;reason?:string})
        assert.equal(values.filter(v=>v.state==='owner').length,1,JSON.stringify({round,values}))
        assert.equal(values.find(v=>v.state==='rejected')!.reason,'REPOSITORY_IN_USE')
        assert.throws(()=>claimRepository(root),/REPOSITORY_IN_USE/,'owner is protected before SBCL readiness')
      }finally{children.forEach(c=>{if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL')});await Promise.all(exits)}
      const recovered=claimRepository(root);recovered.close()
    }
  } finally {rmSync(base,{recursive:true,force:true})}
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
