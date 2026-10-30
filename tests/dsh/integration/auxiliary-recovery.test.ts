import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { AuxiliaryRecovery } from '../../../src/dsh/auxiliary-recovery.js'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'

async function fixture(t:import('node:test').TestContext){
  const root=await mkdtemp(join(tmpdir(),'auxiliary-recovery-')),db=openConnection(join(root,'state.sqlite3'))
  migrateDatabase(db)
  let available=true,now=1000
  const runtime={async withDatabase<T>(fn:Parameters<AuxiliaryRecovery['runtime']['withDatabase']>[0]):Promise<T>{if(!available)throw Error('database unavailable');return await fn(db) as T}}
  const directory=join(root,'quarantine'),options={retryMs:10000,budgetMs:25,now:()=>now}
  const recoveries:AuxiliaryRecovery[]=[]
  const create=(path=directory)=>{const r=new AuxiliaryRecovery(runtime,path,options);recoveries.push(r);return r}
  const recovery=create(),source={sessionId:'native-session',turn:1,origin:'answer-context' as const,
    sourceDigest:canonicalContentHash('original private request'),contextDigest:canonicalContentHash('native source')}
  const row=()=>db.prepare('SELECT * FROM dsh_auxiliary_recovery WHERE id=?').get(canonicalContentHash(source))!
  t.after(async()=>{for(const r of recoveries)await r.close();db.close();await rm(root,{recursive:true,force:true})})
  return {root,db,directory,runtime,options,recovery,create,source,row,offline(){available=false},online(){available=true},advance(){now+=20000}}
}

for(const state of ['verified','rejected'] as const)test(`idle ${state} is durable, deduplicated and does not adopt memory`,async t=>{
  const f=await fixture(t);let checks=0,applied=0
  const binding={source:f.source,current:()=>true,async check(){checks++;return {state,reason:'source_rechecked'}},verified(){applied++}}
  const receipt=await f.recovery.defer(binding,'memory_unavailable')
  assert.equal(receipt.memoryAdopted,false);assert.equal(receipt.workMayContinue,true);assert.equal(checks,0)
  await f.recovery.defer(binding,'duplicate');await Promise.all([f.recovery.idle(f.source.sessionId),f.recovery.idle(f.source.sessionId)])
  assert.equal(checks,1);assert.equal(applied,state==='verified'?1:0);assert.equal(f.row().state,state);assert.equal(f.row().attempts,1)
  await f.recovery.idle(f.source.sessionId);assert.equal(checks,1)
  assert.equal(f.recovery.status(f.source.sessionId)[0]!.memoryAdopted,false)
})

test('retry attempts stop at three across an explicitly rebound restart',async t=>{
  const f=await fixture(t);let checks=0
  const binding={source:f.source,current:()=>true,async check(){checks++;throw Error('unavailable')}}
  await f.recovery.defer(binding,'network_unavailable');await f.recovery.idle(f.source.sessionId)
  assert.equal(f.row().state,'retry_wait');await f.recovery.close();f.advance()
  const second=f.create();await second.defer(binding,'restart');await second.idle(f.source.sessionId);f.advance()
  await second.idle(f.source.sessionId);assert.equal(f.row().state,'rejected');assert.equal(f.row().last_reason,'attempt_limit')
  await second.idle(f.source.sessionId);assert.equal(checks,3);assert.equal(f.row().attempts,3)
})

test('a non-cooperative late result cannot survive a newer instruction or explicit Stop',async t=>{
  const f=await fixture(t);let current=true,apply=0,entered!:()=>void,resolve!:()=>void
  const started=new Promise<void>(r=>entered=r),late=new Promise<void>(r=>resolve=r)
  await f.recovery.defer({source:f.source,current:()=>current,async check(){entered();await late;return {state:'verified',reason:'late_result'}},verified(){apply++}},'interrupted')
  const running=f.recovery.idle(f.source.sessionId);await started;current=false;f.recovery.active(f.source.sessionId)
  await running;resolve();await new Promise(r=>setImmediate(r))
  assert.equal(apply,0);assert.equal(f.row().state,'stale')
})

test('deadline persists retry_wait and rejects a later success without applying it',async t=>{
  const f=await fixture(t);let apply=0
  await f.recovery.defer({source:f.source,current:()=>true,async check(){await new Promise(r=>setTimeout(r,65));return {state:'verified',reason:'too_late'}},verified(){apply++}},'network_unavailable')
  await f.recovery.idle(f.source.sessionId);assert.equal(f.row().state,'retry_wait')
  await new Promise(r=>setTimeout(r,75));assert.equal(f.row().state,'retry_wait');assert.equal(apply,0)
})

test('database outage before save uses a private payload-free file and recovers on native rebind',async t=>{
  const f=await fixture(t);f.offline();let checks=0
  const binding={source:f.source,current:()=>true,async check(){checks++;return {state:'verified' as const,reason:'reconnected'}}}
  const receipt=await f.recovery.defer(binding,'secret value must not be persisted')
  assert.equal(receipt.storage,'private_file');assert.equal(receipt.memoryAdopted,false)
  const files=await readdir(f.directory);assert.equal(files.length,1)
  const path=join(f.directory,files[0]!),text=await readFile(path,'utf8')
  assert.equal((await stat(path)).mode&0o777,0o600);assert.ok(!text.includes('original private request'));assert.ok(!text.includes('secret value'))
  await f.recovery.idle(f.source.sessionId);assert.equal(checks,0)
  await f.recovery.close();f.online();const next=f.create();await next.defer(binding,'native_rebind');await next.idle(f.source.sessionId)
  assert.equal(f.row().state,'verified');assert.equal(checks,1)
})

test('database and private storage failure is explicit and does not prevent independent work',async t=>{
  const f=await fixture(t);f.offline();const file=join(f.root,'not-a-directory');await writeFile(file,'owned test file')
  const recovery=f.create(file);let checks=0
  const receipt=await recovery.defer({source:f.source,current:()=>true,async check(){checks++;return {state:'verified',reason:'unused'}}},'database_unavailable')
  assert.equal(receipt.storage,'unavailable');assert.equal(receipt.workMayContinue,true);assert.equal(receipt.memoryAdopted,false)
  let work=0;work++;await recovery.idle(f.source.sessionId);assert.equal(work,1);assert.equal(checks,0)
})

test('a database call released after its deadline cannot make a late quarantine write',async t=>{
  const f=await fixture(t);let release!:()=>void
  const held=new Promise<void>(r=>release=r)
  const recovery=new AuxiliaryRecovery({withDatabase:async fn=>{await held;return fn(f.db)}},f.directory,f.options)
  const keepalive=setTimeout(()=>{},2000)
  try{
    const receipt=await recovery.defer({source:f.source,current:()=>true,async check(){return {state:'verified',reason:'unused'}}},'database_unavailable')
    assert.equal(receipt.storage,'private_file');release();await new Promise(r=>setImmediate(r))
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_auxiliary_recovery').get()!.n,0)
  }finally{release();clearTimeout(keepalive);await recovery.close()}
})

test('an expired interrupted lease can resume but concurrent instances cannot both check',async t=>{
  const f=await fixture(t);let checks=0,release!:()=>void,started!:()=>void
  const entered=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r)
  const binding={source:f.source,current:()=>true,async check(){checks++;started();await held;return {state:'verified' as const,reason:'recovered'}}}
  await f.recovery.defer(binding,'before_crash')
  f.db.prepare("UPDATE dsh_auxiliary_recovery SET state='running',attempts=1,lease_nonce='old',lease_until=0").run()
  const other=f.create();await other.defer(binding,'rebind')
  const first=f.recovery.idle(f.source.sessionId);await entered;await other.idle(f.source.sessionId)
  assert.equal(checks,1);release();await first;assert.equal(f.row().state,'verified');assert.equal(f.row().attempts,2)
})

test('lease loss never reports verified or invokes the verifier application',async t=>{
  const f=await fixture(t);let apply=0
  await f.recovery.defer({source:f.source,current:()=>true,async check(){f.db.prepare("UPDATE dsh_auxiliary_recovery SET lease_nonce='different-owner' WHERE id=?").run(canonicalContentHash(f.source));return {state:'verified',reason:'lost_owner'}},verified(){apply++}},'initial')
  await f.recovery.idle(f.source.sessionId);assert.equal(apply,0);assert.equal(f.row().state,'running')
  assert.equal(f.recovery.status(f.source.sessionId)[0]!.state,'lease_lost')
})

test('another session, stale sources and malformed identities cannot execute the check',async t=>{
  const f=await fixture(t);let checks=0
  const binding={source:f.source,current:()=>false,async check(){checks++;return {state:'verified' as const,reason:'unused'}}}
  await f.recovery.defer(binding,'initial');await f.recovery.idle('another-session');assert.equal(checks,0)
  await f.recovery.idle(f.source.sessionId);assert.equal(checks,0);assert.equal(f.row().state,'stale')
  await assert.rejects(f.recovery.defer({...binding,source:{...f.source,contextDigest:'malformed'}},'invalid'))
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_auxiliary_recovery').get()!.n,1)
})

test('a verified check with an unresponsive application stays bounded and is never replayed as a new check',async t=>{
  const f=await fixture(t);let checks=0,applications=0
  await f.recovery.defer({source:f.source,current:()=>true,async check(){checks++;return {state:'verified',reason:'checked'}},async verified(){applications++;await new Promise(()=>{})}},'initial')
  const keepalive=setTimeout(()=>{},2000)
  try{await f.recovery.idle(f.source.sessionId);assert.equal(f.row().state,'verified');assert.equal(f.recovery.status(f.source.sessionId)[0]!.state,'verified_effect_unconfirmed')
    await f.recovery.idle(f.source.sessionId);assert.equal(checks,1);assert.equal(applications,1)}finally{clearTimeout(keepalive)}
})


test('real SQLite writer contention is bounded and restores the native connection timeout',async t=>{
  const f=await fixture(t),script=`import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');process.stdin.once('data',()=>setTimeout(()=>{db.close();process.exit(0)},1400));process.stdin.resume()`
  const child=spawn(process.execPath,['--input-type=module','-e',script,join(f.root,'state.sqlite3')],{stdio:['pipe','pipe','pipe']}),exited=once(child,'exit')
  try{
    await once(child.stdout!,'data');child.stdin!.write('release-later')
    const started=performance.now(),receipt=await f.recovery.defer({source:f.source,current:()=>true,async check(){return {state:'verified',reason:'unused'}}},'database_locked')
    assert.ok(performance.now()-started<1000,'optional quarantine must not inherit five 5s SQLite waits')
    assert.equal(receipt.storage,'private_file');assert.equal(receipt.memoryAdopted,false)
    assert.equal(f.db.prepare('PRAGMA busy_timeout').get()!.timeout,5000,'native connection policy must be restored')
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited}
})
