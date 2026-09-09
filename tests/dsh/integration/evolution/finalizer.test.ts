import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, createRun, draft, NOW } from './fixture.js'
import { DshMemoryFinalizer, reduceDshFinalizationLog, type DshLogEvent } from '../../../../src/dsh/session-memory-finalizer.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { MemoryEvolutionConfig, type Episode } from '../../../../src/memory/evolution/contracts.js'

function log(passed: boolean): DshLogEvent[] {
  const result=(seq:number,callId:string,exitCode:number):DshLogEvent=>({seq,time:seq,type:'tool/result',data:{exitCode,message:{role:'user',source:{kind:'tool',callId},content:[{type:'text',text:exitCode===0?'Migration test completed':'SQLITE_BUSY'}]}}})
  return [
    {seq:1,time:1,type:'turn/start',data:{turn:1}},
    {seq:2,time:2,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'SQLITE_BUSY sqlite migration 3.46'}]}},
    {seq:3,time:3,type:'request/header',data:{header:{config:{provider:'p',model:'m'}}}},
    {seq:4,time:4,type:'request/context',data:{contextWindow:100000}},
    {seq:5,time:5,type:'tool/call',data:{callId:'bad',name:'Shell',arguments:'migration'}},result(6,'bad',1),
    {seq:7,time:7,type:'tool/call',data:{callId:'retry',name:'Shell',arguments:draft().procedure}},result(8,'retry',passed?0:1),
    {seq:9,time:9,type:'turn/end',data:{turn:1,reason:{kind:passed?'completed':'failed'}}},
  ]
}
test('closed failed logs and completed recovery preserve distinct outcome and verification states', async () => {
  for(const outcome of ['completed','failed'] as const) {
    const f=fixture();createRun(f.db,'native');let finalized=0
    const d=draft();d.events[0]!.evidence=[6];d.events[1]!.evidence=[7];d.events[2]!.evidence=[8]
    const finalizer=new DshMemoryFinalizer({runtime:f.runtime,now:()=>NOW,onFinalized(){finalized++},
      sessionQuery:{async readSession(){return {session:{id:'session-native'},inheritedEventCount:0,events:log(outcome==='completed')}}},
      llm:{async *stream(request){
        assert.match(JSON.stringify(request.messages),new RegExp(`Native run outcome: ${outcome}`))
        yield {type:'text-delta',text:JSON.stringify({schemaVersion:2,memories:[{kind:'fact',title:'Migration observation',body:'SQLITE_BUSY was observed.',summary:null,tags:[],confidence:0.5}],episode:d})}
        yield {type:'finish',reason:{kind:'stop'}}
      }}})
    try {
      await finalizer.start()
      withImmediateTransaction(f.db,()=>{f.db.prepare('UPDATE ledger_runs SET status=? WHERE run_id=?').run(outcome,'native');finalizer.scheduleInTransaction(f.db,{runId:'native',workspace:'project:test',dshSessionId:'session-native',sourceEndSeq:9})})
      finalizer.kick();await finalizer.whenIdle()
      const row=f.db.prepare('SELECT episode_json FROM memory_episodes').get<{episode_json:string}>()
      assert.ok(row,JSON.stringify(f.db.prepare('SELECT status,episode_error FROM dsh_memory_finalizations').get()))
      const episode=JSON.parse(row.episode_json) as Episode
      assert.equal(episode.outcome,outcome);assert.equal(episode.successful,outcome==='completed');assert.equal(episode.failed,true)
      assert.equal(finalized,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalization_entries').get()?.n,1)
    } finally {await finalizer.dispose();f.db.close()}
  }
})
test('invalid v2 evidence saves ordinary memory and excludes unsupported episode', async () => {
  const f=fixture();createRun(f.db,'invalid')
  const finalizer=new DshMemoryFinalizer({runtime:f.runtime,
    sessionQuery:{async readSession(){return {session:{id:'session-invalid'},inheritedEventCount:0,events:log(true)}}},
    llm:{async *stream(){yield {type:'text-delta',text:JSON.stringify({schemaVersion:2,memories:[{kind:'reference',title:'Observed fact',body:'A migration ran.',summary:null,tags:[],confidence:0.5}],episode:draft()})};yield {type:'finish',reason:{kind:'stop'}}}}})
  try {
    await finalizer.start();withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ledger_runs SET status='failed'").run();finalizer.scheduleInTransaction(f.db,{runId:'invalid',workspace:'project:test',dshSessionId:'session-invalid',sourceEndSeq:9})})
    finalizer.kick();await finalizer.whenIdle()
    assert.equal(f.db.prepare('SELECT status FROM dsh_memory_finalizations').get()?.status,'completed')
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()?.n,0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalization_entries').get()?.n,1)
  } finally {await finalizer.dispose();f.db.close()}
})
test('native evidence excludes recalled tool output and unbound tool results', async () => {
  const events=log(true)
  events[4]={...events[4]!,data:{callId:'bad',name:'memory_search',arguments:'old experience'}}
  events[6]={...events[6]!,data:{callId:'different',name:'Shell',arguments:'read'}}
  async function* stream(){yield*events}
  const reduced=await reduceDshFinalizationLog(stream(),1,9)
  assert.ok(!reduced.episodeEvidence!.some(e=>[5,6,8].includes(e.seq)))
  await assert.rejects(reduceDshFinalizationLog(stream(),1,10),/end|boundary|range/)
})

test('off completes an existing v2 job using ordinary extraction without rewriting its persisted version', async () => {
  const f=fixture();createRun(f.db,'off')
  f.db.prepare("UPDATE ledger_runs SET status='completed'").run()
  f.db.prepare("INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,extraction_version) VALUES('off','project:test','session-off',1,9,'pending',0,?,?,2)").run(NOW,NOW)
  const finalizer=new DshMemoryFinalizer({runtime:f.runtime,memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),
    sessionQuery:{async readSession(){return {session:{id:'session-off'},inheritedEventCount:0,events:log(true)}}},
    llm:{async *stream(request){assert.doesNotMatch(JSON.stringify(request.messages),/schemaVersion:2|Episode schema/);yield {type:'text-delta',text:'{"schemaVersion":1,"memories":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
  try {
    await finalizer.start();await finalizer.whenIdle()
    assert.equal(f.db.prepare('SELECT status FROM dsh_memory_finalizations').get()?.status,'completed')
    assert.equal(f.db.prepare('SELECT extraction_version FROM dsh_memory_finalizations').get()?.extraction_version,2)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()?.n,0)
  } finally {await finalizer.dispose();f.db.close()}
})
