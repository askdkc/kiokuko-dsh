/** Opt-in long-history benchmark. Seed is excluded from measured incremental work. */
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fixture,createRun,NOW} from '../evolution/fixture.js'
import {openConnection} from '../../../../src/db/connection.js'
import {DshSessionLogMirror} from '../../../../src/dsh/session-log-mirror.js'
import {AutoMemoryReviewCoordinator} from '../../../../src/dsh/auto-memory-review.js'
import {MemoryReviewConfig} from '../../../../src/memory/review/contracts.js'
import type {DshLogEvent} from '../../../../src/dsh/session-memory-finalizer.js'

for(const history of [10000,100000,1000000]){
 const root=await mkdtemp(join(tmpdir(),'review-history-')),path=join(root,'mirror.sqlite3'),f=fixture();createRun(f.db,'scale')
 const mirror=new DshSessionLogMirror({runtime:f.runtime,databasePath:path,now:()=>NOW});await mirror.start()
 const seed=openConnection(path)
 seed.prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<?)
  INSERT INTO session_events SELECT 'session-scale',x,json_object('type','history','seq',x,'time',x),64,?,? FROM n`).run(history-1,'a'.repeat(64),NOW)
 seed.prepare("INSERT INTO session_watermarks VALUES('session-scale',?,?,?,'healthy',NULL,NULL,?)").run(history-1,history-1,history-1,NOW)
 seed.prepare("INSERT INTO session_retention VALUES('session-scale','active',?,NULL,?)").run(NOW,history*64)
 const plan=seed.prepare('EXPLAIN QUERY PLAN SELECT event_json FROM session_events WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1').all('session-scale',history-1,history+499)
 assert.ok(plan.some(row=>String(row.detail).includes('SEARCH')&&String(row.detail).includes('seq>')))
 seed.close()
 const events=new Map<number,DshLogEvent>();let seq=history,nativeReads=0,rangeRows=0,calls=0,maximumBuffered=0
 const original=mirror.streamRange.bind(mirror)
 mirror.streamRange=async function*(...args:Parameters<typeof original>){for await(const event of original(...args)){rangeRows++;yield event}}
 const session={id:'session-scale',header:{},eventAt:(n:number)=>{nativeReads++;return events.get(n)}}
 const coordinator=new AutoMemoryReviewCoordinator({runtime:f.runtime,mirror,now:()=>NOW,flush:async()=>true,
  config:MemoryReviewConfig.parse({turnInterval:100,maxInputBytes:262144}),llm:{async *stream(){calls++;yield {type:'text-delta',text:'{"schemaVersion":1,"proposals":[]}'};yield {type:'finish',reason:{kind:'stop'}}}}})
 try{
  await coordinator.bind({workspace:'project:test',runId:'scale',session,startSeq:history})
  const rss=process.memoryUsage().rss,start=performance.now()
  for(let turn=1;turn<=100;turn++){
   const append=(type:string,data:unknown)=>{events.set(seq,{type,data,seq,time:seq});seq++}
   append('turn/start',{turn});append('user/message',{id:`input-${turn}`,source:{kind:'user'},content:'Project uses TypeScript.'})
   append('request/header',{header:{config:{provider:'fixture',model:'fixed'}}});append('request/context',{contextWindow:1000000});append('turn/end',{turn,reason:{kind:'completed'}})
   maximumBuffered=Math.max(maximumBuffered,events.size)
   coordinator.notify({workspace:'project:test',runId:'scale',session,startSeq:history},seq-1);await coordinator.whenIdle();events.clear()
  }
  assert.equal(nativeReads,501);assert.equal(rangeRows,2000);assert.equal(calls,1);assert.equal(maximumBuffered,5)
  console.log(JSON.stringify({history,deltaTurns:100,nativeReads,rangeRows,maximumBuffered,calls,durationMs:Math.round(performance.now()-start),rssDeltaBytes:process.memoryUsage().rss-rss}))
 }finally{await coordinator.dispose();await mirror.close();f.db.close();await rm(root,{recursive:true,force:true})}
}
