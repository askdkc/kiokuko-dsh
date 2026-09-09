import { readEntry, updateCandidateEntry } from '../../../../src/memory/entries.js'
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
import { MemoryEvolutionConfig } from '../../../../src/memory/evolution/contracts.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import type { DshLlm } from '../../../../src/dsh/session-memory-finalizer.js'

function setup(contextWindow: number | undefined = 100000) {
  const f = fixture()
  const es = ['a','b','c'].map(id => seed(f.db,id))
  const d = es[0]!.draft
  const response = { applicability:d.applicability,procedure:d.procedure,verification:d.verification,boundary:d.boundary,evidence:es.map(e=>e.runId),conflict:false }
  withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,'c',{provider:'original-provider',model:'original-model',...(contextWindow===0?{}:{contextWindow})},NOW))
  return { ...f, es, response }
}
test('parallel workers dispatch once, retain the trigger model and persist measured usage', async () => {
  const f=setup(); let calls=0
  const llm: DshLlm={async *stream(request) {
    calls++; assert.equal(request.model,'original-model');assert.equal(request.provider,'original-provider')
    assert.equal(request.sessionId,'session-c'); assert.equal(request.maxTokens,2048);assert.equal(request.tools,undefined)
    yield {type:'text-delta',text:JSON.stringify(f.response)}
    yield {type:'usage',usage:{inputTokens:123,outputTokens:45}}
    yield {type:'finish',reason:{kind:'stop'}}
  }}
  const options={runtime:f.runtime,llm,config:MemoryEvolutionConfig.parse({}),now:()=>NOW}
  const a=new EvolutionWorker(options),b=new EvolutionWorker(options)
  try {
    a.kick(); b.kick();await Promise.all([a.whenIdle(),b.whenIdle()])
    assert.equal(calls,1);assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_derivations WHERE kind='positive'").get()?.n,1)
    const measured=f.db.prepare('SELECT input_tokens,output_tokens,outcome FROM memory_evolution_calls').get()!
    assert.deepEqual({...measured},{input_tokens:123,output_tokens:45,outcome:'completed'})
    a.kick();await a.whenIdle();assert.equal(calls,1)
  } finally {await a.dispose();await b.dispose();f.db.close()}
})
test('source revision changes and mode changes during model execution reject adoption', async () => {
  for (const mutation of ['source','off'] as const) {
    const f=setup()
    const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>NOW,llm:{async *stream() {
      if(mutation==='off') configureEvolution(f.db,'off')
      else {
        const e=readEntry(f.db,{workspace:f.es[0]!.workspace,entryId:f.es[0]!.sources[0]!.entryId})
        updateCandidateEntry(f.db,{workspace:e.workspace,entryId:e.id,expectedRevision:e.revision,kind:e.kind,title:e.title,body:'Changed evidence'})
      }
      yield {type:'text-delta',text:JSON.stringify(f.response)};yield {type:'finish',reason:{kind:'stop'}}
    }}})
    try {
      worker.kick();await worker.whenIdle()
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_derivations WHERE kind='positive'").get()?.n,0)
      assert.equal(f.db.prepare('SELECT state FROM memory_evolution_jobs').get()?.state,'held')
      assert.equal(f.db.prepare('SELECT reason FROM memory_evolution_jobs').get()?.reason,mutation==='off'?'evolution_stale_claim':'evolution_stale_or_conflicting')
    } finally {await worker.dispose();f.db.close()}
  }
})
test('timeouts and invalid JSON remain bounded and never resend a dispatched trigger', async () => {
  for (const failure of ['timeout','json']) {
    const f=setup();let calls=0
    const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({timeoutMs:100}),now:()=>NOW,llm:{async *stream(request) {
      calls++
      if(failure==='timeout') await new Promise(resolve=>request.signal!.addEventListener('abort',resolve,{once:true}))
      yield {type:'text-delta',text:'invalid'};yield {type:'finish',reason:{kind:'stop'}}
    }}})
    try {
      worker.kick();await worker.whenIdle();worker.kick();await worker.whenIdle()
      assert.equal(calls,1);assert.notEqual(f.db.prepare('SELECT state FROM memory_evolution_jobs').get()?.state,'completed')
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalization_entries').get()?.n,3)
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()?.n,3)
    } finally {await worker.dispose();f.db.close()}
  }
})
test('unknown model context and unavailable provider do not dispatch or fall back', async () => {
  const f=setup(0);let calls=0
  const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),llm:{async *stream(){calls++;throw new Error('must not dispatch')}}})
  try {worker.kick();await worker.whenIdle();assert.equal(calls,0);assert.equal(f.db.prepare('SELECT reason FROM memory_evolution_jobs').get()?.reason,'context_budget_or_support')}
  finally {await worker.dispose();f.db.close()}
})
test('new generation requires three unseen episodes after the previous scheduling', async () => {
  const f=setup()
  try {
    for(const id of ['d','e']) {seed(f.db,id);withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,id,{provider:'p',model:'m',contextWindow:100000},NOW))}
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_jobs').get()?.n,1)
    seed(f.db,'f');withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,'f',{provider:'p',model:'m',contextWindow:100000},NOW))
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_jobs').get()?.n,2)
  } finally {f.db.close()}
})
test('the UTC-day budget includes failed dispatches and resets only for a new day', async () => {
  const f=fixture();let now=NOW,calls=0
  const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>now,llm:{async *stream(){calls++;throw new Error('provider failure')}}})
  const schedule=(n:number)=>{
    const ids=Array.from({length:3},(_,i)=>`batch-${n}-${i}`)
    ids.forEach(id=>seed(f.db,id))
    withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,ids[2]!,{provider:'p',model:'m',contextWindow:100000},now))
  }
  try {
    for(let i=0;i<9;i++){schedule(i);worker.kick();await worker.whenIdle()}
    assert.equal(calls,8)
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_evolution_jobs WHERE reason='call_budget'").get()?.n,1)
    now='2026-09-11T00:00:00.000Z';schedule(9);worker.kick();await worker.whenIdle()
    assert.equal(calls,9)
    assert.deepEqual(f.db.prepare('SELECT utc_day,COUNT(*) AS n FROM memory_evolution_calls GROUP BY utc_day ORDER BY utc_day').all().map(r=>({...r})),[{utc_day:'2026-09-10',n:8},{utc_day:'2026-09-11',n:1}])
  } finally {await worker.dispose();f.db.close()}
})
test('expired undispatched claims recover, while ambiguous dispatched claims never resend', async () => {
  for(const dispatched of [false,true]) {
    const f=setup();let calls=0
    const job=f.db.prepare('SELECT id,trigger_run,workspace FROM memory_evolution_jobs').get<{id:string;trigger_run:string;workspace:string}>()!
    f.db.prepare("UPDATE memory_evolution_jobs SET state='processing',claim_token='old',attempts=1,lease_until='2026-09-09T00:00:00.000Z'").run()
    if(dispatched)f.db.prepare("INSERT INTO memory_evolution_calls(id,job_id,trigger_run,workspace,utc_day,input_bytes,outcome,created_at) VALUES('old',?,?,?,'2026-09-09',10,'unknown',?)").run(job.id,job.trigger_run,job.workspace,NOW)
    const worker=new EvolutionWorker({runtime:f.runtime,config:MemoryEvolutionConfig.parse({}),now:()=>NOW,llm:{async *stream(){calls++;yield {type:'text-delta',text:JSON.stringify(f.response)};yield {type:'finish',reason:{kind:'stop'}}}}})
    try {
      worker.kick();await worker.whenIdle()
      assert.equal(calls,dispatched?0:1)
      const state=f.db.prepare('SELECT attempts,state,reason FROM memory_evolution_jobs').get()!
      assert.equal(state.state,dispatched?'held':'completed');assert.equal(state.attempts,dispatched?1:2)
      if(dispatched)assert.equal(state.reason,'expired_dispatched_claim')
    } finally {await worker.dispose();f.db.close()}
  }
})
test('independent SQLite connections cannot both dispatch the same durable job', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'evolution-claim-'))
  const f=fixture(path.join(root,'state.sqlite3')),other=openConnection(path.join(root,'state.sqlite3'))
  const es=['a','b','c'].map(id=>seed(f.db,id)),d=es[0]!.draft
  withImmediateTransaction(f.db,()=>scheduleEvolution(f.db,'c',{provider:'p',model:'m',contextWindow:100000},NOW))
  let entered!:()=>void,release!:()=>void,calls=0
  const started=new Promise<void>(resolve=>{entered=resolve}),waiting=new Promise<void>(resolve=>{release=resolve})
  const llm:DshLlm={async *stream(){calls++;entered();await waiting;yield {type:'text-delta',text:JSON.stringify({applicability:d.applicability,procedure:d.procedure,verification:d.verification,boundary:d.boundary,evidence:es.map(e=>e.runId),conflict:false})};yield {type:'finish',reason:{kind:'stop'}}}}
  const options={config:MemoryEvolutionConfig.parse({}),llm,now:()=>NOW}
  const a=new EvolutionWorker({...options,runtime:f.runtime})
  const b=new EvolutionWorker({...options,runtime:{withDatabase:async<T>(fn:(db:SqliteDatabase,embedding:never)=>T|PromiseLike<T>)=>await fn(other,undefined as never)}})
  try {
    a.kick();await started;b.kick();await b.whenIdle();assert.equal(calls,1)
    release();await a.whenIdle();assert.equal(other.prepare('SELECT state FROM memory_evolution_jobs').get()?.state,'completed')
    assert.equal(other.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls').get()?.n,1)
  } finally {release();await a.dispose();await b.dispose();other.close();f.db.close();await rm(root,{recursive:true,force:true})}
})
