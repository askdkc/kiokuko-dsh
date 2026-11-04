import assert from 'node:assert/strict'
import test from 'node:test'
import { processIdentity, sameProcess } from '../../../../lisp/process-identity.mjs'
import { openConnection } from '../../../../src/db/connection.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

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
