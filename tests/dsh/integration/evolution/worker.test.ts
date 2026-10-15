import { openConnection } from '../../../../src/db/connection.js'
import type { SqliteDatabase } from '../../../../src/db/adapter.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, seed, NOW } from './fixture.js'
import { scheduleEvolution, configureEvolution } from '../../../../src/memory/evolution/store.js'
import { EvolutionWorker } from '../../../../src/memory/evolution/worker.js'
import { canonicalJson } from '../../../../src/serialization/validate.js'
import { digest, EVOLUTION_VERSION, MemoryEvolutionConfig } from '../../../../src/memory/evolution/contracts.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import type { DshLlm } from '../../../../src/dsh/session-memory-finalizer.js'

// Exact native preview approval replaces both legacy model induction and
// deterministic promotion. Positive save/revise/decline tests are in
// ../replay-memory-review.test.ts; historical source and scheduler utilities stay covered.
function setup(contextWindow: number | undefined = 100000) {
  const f = fixture()
  const es = ['a','b','c'].map(id => seed(f.db,id))
  const d = es[0]!.draft
  const response = { applicability:d.applicability,procedure:d.procedure,verification:d.verification,boundary:d.boundary,evidence:es.map(e=>e.runId),conflict:false }
  withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,'c',{provider:'original-provider',model:'original-model',...(contextWindow===0?{}:{contextWindow})},NOW))
  return { ...f, es, response }
}
/** Queue an immutable legacy job to prove the retired v1 LLM route never resumes it. */
function setupLegacy(contextWindow: number | undefined = 100000) {
  const f = setup(contextWindow)
  const kind = 'positive' as const
  const input = canonicalJson(f.es)
  const inputDigest = digest({ version: EVOLUTION_VERSION, kind, episodes: f.es })
  const model = { provider: 'original-provider', model: 'original-model', sessionId: 'session-c', ...(contextWindow === 0 ? {} : { contextWindow }) }
  f.db.prepare('DELETE FROM memory_evolution_jobs').run()
  f.db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest, f.es[0]!.workspace, 'c', f.es[0]!.signature, kind, input,
      canonicalJson(f.es.map(e => e.evidenceDigest)), inputDigest, canonicalJson(model), EVOLUTION_VERSION, NOW, NOW)
  return f
}

function queueLegacy(db: SqliteDatabase, episodes: ReturnType<typeof seed>[], triggerRun: string, now: string) {
  const kind = 'positive' as const
  const input = canonicalJson(episodes)
  const inputDigest = digest({ version: EVOLUTION_VERSION, kind, episodes })
  const model = { provider: 'p', model: 'm', sessionId: episodes.find(e => e.runId === triggerRun)!.sessionId, contextWindow: 100000 }
  db.prepare('DELETE FROM memory_evolution_jobs WHERE trigger_run=?').run(triggerRun)
  db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest, episodes[0]!.workspace, triggerRun, episodes[0]!.signature, kind, input,
      canonicalJson(episodes.map(e => e.evidenceDigest)), inputDigest, canonicalJson(model), EVOLUTION_VERSION, now, now)
}
test('new generation requires three unseen episodes after the previous scheduling', async () => {
  const f=setup()
  try {
    for(const id of ['d','e']) {seed(f.db,id);withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,id,{provider:'p',model:'m',contextWindow:100000},NOW))}
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_jobs').get()?.n,1)
    seed(f.db,'f');withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,'f',{provider:'p',model:'m',contextWindow:100000},NOW))
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_jobs').get()?.n,2)
  } finally {f.db.close()}
})

const snapshot=(db:SqliteDatabase)=>({
 jobs:db.prepare('SELECT * FROM memory_evolution_jobs ORDER BY id').all(),
 calls:db.prepare('SELECT * FROM memory_evolution_calls ORDER BY id').all(),
 derivations:db.prepare('SELECT * FROM memory_derivations ORDER BY entry_id').all(),
 entries:db.prepare('SELECT id,current_revision,status FROM entries ORDER BY id').all(),
})
for(const algorithm of ['legacy','reference'] as const)for(const mode of ['active','observe','off'] as const)test(`${mode} ${algorithm} jobs remain inert under concurrent and repeated kicks`,async()=>{
 const f=algorithm==='legacy'?setupLegacy():setup();let calls=0
 configureEvolution(f.db,mode)
 const llm:DshLlm={async *stream(){calls++;throw new Error('unapproved induction')}}
 const options={runtime:f.runtime,llm,config:MemoryEvolutionConfig.parse({mode}),now:()=>NOW}
 const a=new EvolutionWorker(options),b=new EvolutionWorker(options)
 try{
  const before=snapshot(f.db),writes=f.db.prepare('SELECT total_changes() AS n').get()?.n
  a.kick();b.kick();await Promise.all([a.whenIdle(),b.whenIdle()]);a.kick();await a.whenIdle()
  assert.equal(calls,0);assert.deepEqual(snapshot(f.db),before)
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()?.n,writes)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_derivations WHERE kind='positive'").get()?.n,0)
 }finally{await a.dispose();await b.dispose();f.db.close()}
})
for(const dispatched of [false,true])test(`expired historical ${dispatched?'dispatched':'undispatched'} claims are never recovered into an automatic save`,async()=>{
 const f=setupLegacy();let calls=0
 const job=f.db.prepare('SELECT id,trigger_run,workspace FROM memory_evolution_jobs').get<{id:string;trigger_run:string;workspace:string}>()!
 f.db.prepare("UPDATE memory_evolution_jobs SET state='processing',claim_token='old',attempts=1,lease_until='2026-09-09T00:00:00.000Z'").run()
 if(dispatched)f.db.prepare("INSERT INTO memory_evolution_calls(id,job_id,trigger_run,workspace,utc_day,input_bytes,outcome,created_at) VALUES('old',?,?,?,'2026-09-09',10,'unknown',?)").run(job.id,job.trigger_run,job.workspace,NOW)
 const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>NOW,llm:{async *stream(){calls++;yield {type:'finish',reason:{kind:'stop'}}}}})
 try{
  const before=snapshot(f.db);worker.kick();await worker.whenIdle()
  assert.equal(calls,0);assert.deepEqual(snapshot(f.db),before)
 }finally{await worker.dispose();f.db.close()}
})
test('missing model context and an uncooperative provider do not become task dependencies',async()=>{
 const f=setupLegacy(0);let calls=0
 const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({timeoutMs:100}),llm:{async *stream(){calls++;await new Promise(()=>{});yield {}}}})
 try{
  const before=snapshot(f.db);worker.kick();await worker.whenIdle()
  assert.equal(calls,0);assert.deepEqual(snapshot(f.db),before)
 }finally{await worker.dispose();f.db.close()}
})
test('UTC-day and budget changes cannot authorize automatic legacy dispatch',async()=>{
 const f=fixture();let now=NOW,calls=0
 const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>now,llm:{async *stream(){calls++;throw new Error('unapproved provider call')}}})
 try{
  for(let i=0;i<10;i++){
   if(i===9)now='2026-09-11T00:00:00.000Z'
   const ids=Array.from({length:3},(_,j)=>`batch-${i}-${j}`),episodes=ids.map(id=>seed(f.db,id))
   queueLegacy(f.db,episodes,ids[2]!,now)
   const before=snapshot(f.db);worker.kick();await worker.whenIdle();assert.deepEqual(snapshot(f.db),before)
  }
  assert.equal(calls,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls').get()?.n,0)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_evolution_jobs WHERE state='pending'").get()?.n,10)
 }finally{await worker.dispose();f.db.close()}
})
test('reopened database and independent connections preserve historical jobs without dispatch or promotion',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'evolution-restart-')),file=path.join(root,'state.sqlite3')
 let db=fixture(file).db
 const episodes=['a','b','c'].map(id=>seed(db,id))
 queueLegacy(db,episodes,'c',NOW);const before=snapshot(db);db.close();db=openConnection(file)
 const other=openConnection(file);let calls=0
 const runtime=(connection:SqliteDatabase)=>({withDatabase:async<T>(fn:(database:SqliteDatabase,embedding:never)=>T|PromiseLike<T>)=>await fn(connection,undefined as never)})
 const options={config:MemoryEvolutionConfig.parse({}),now:()=>NOW,llm:{async *stream(){calls++;yield {type:'finish',reason:{kind:'stop'}}}} as DshLlm}
 const a=new EvolutionWorker({...options,runtime:runtime(db)}),b=new EvolutionWorker({...options,runtime:runtime(other)})
 try{
  a.kick();b.kick();await Promise.all([a.whenIdle(),b.whenIdle()])
  assert.equal(calls,0);assert.deepEqual(snapshot(db),before);assert.deepEqual(snapshot(other),before)
 }finally{await a.dispose();await b.dispose();other.close();db.close();await rm(root,{recursive:true,force:true})}
})
test('automatic evolution does not acquire unavailable optional storage',async()=>{
 let reads=0
 const worker=new EvolutionWorker({runtime:{withDatabase:async()=>{reads++;throw new Error('memory unavailable')}},config:MemoryEvolutionConfig.parse({})})
 try{worker.kick();await worker.whenIdle();assert.equal(reads,0)}finally{await worker.dispose()}
})
