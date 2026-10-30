import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { DshSessionLogMirror } from '../../../src/dsh/session-log-mirror.js'
import { DshSessionLogExportService } from '../../../src/dsh/session-log-export.js'
import { dshSessionExportResponse } from '../../../src/dsh/session-log-surface.js'
import { AuxiliaryRecovery } from '../../../src/dsh/auxiliary-recovery.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { assessTaskCompletion, bindTaskCriterion, beginTaskCompletionExecution, finishTaskCompletionExecution } from '../../../src/dsh/task-completion.js'
import { sessionDatabaseAnalysis } from '../../../src/dsh/session-export-analysis.js'

function unzip(bytes:Buffer) {
  const files=new Map<string,Buffer>();let p=0
  while(bytes.readUInt32LE(p)===0x04034b50){const n=bytes.readUInt16LE(p+26),e=bytes.readUInt16LE(p+28),start=p+30+n+e,
    end=bytes.indexOf(Buffer.from([0x50,0x4b,0x07,0x08]),start)
    assert.ok(end>=start);files.set(bytes.subarray(p+30,p+30+n).toString(),bytes.subarray(start,end));p=end+16}
  return files
}
test('actual Web export preserves conversation and host links, excludes raw model data, and includes unknown Goal reasons',async()=>{
  const base=await mkdtemp('/tmp/kiokuko-safe-export-'),root=join(base,'repo');await mkdir(root)
  const db=openConnection(join(base,'db.sqlite3'));migrateDatabase(db,join(process.cwd(),'migrations'))
  const runtime:any={withDatabase:async(fn:any)=>fn(db)}
  const mirror=new DshSessionLogMirror({runtime,databasePath:join(base,'mirror.sqlite3')})
  try {
    const p=await prepareAgentTask(db,{cwd:root,requestId:'safe-export',task:'Read the source.\n完了条件:\n- 対象テストが成功する\n- 結果を報告する',dshSessionId:'export',
      completionMode:'enforce',profileHints:{taskType:'research',target:'src',expected:'report',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
    const events=[{seq:0,time:1,type:'tool/call',data:{turn:1,callId:'call',name:'lisp_eval'}},
      {seq:1,time:4,type:'tool/result',data:{turn:1,message:{role:'tool',toolCallId:'call',isError:false,content:[{type:'text',text:'observed result'}]}}},
      {seq:2,time:5,type:'assistant/message',data:{turn:1,message:{role:'assistant',content:[{type:'text',text:'検索結果を確認しました。',rawText:'SYNTHETIC_PRIVATE_RAW',signature:'SYNTHETIC_SIGNATURE'}]},
        usage:{input_tokens:10},authorization:'SYNTHETIC_AUTH',replayState:{value:'SYNTHETIC_STATE'}}},
      {seq:3,time:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]
    await mirror.checkpointAfterNativeFlush({id:'export',snapshotEvents:()=>events})
    const recovery=new AuxiliaryRecovery(runtime,join(base,'quarantine'))
    await recovery.defer({source:{sessionId:'export',turn:1,origin:'answer-context',sourceDigest:canonicalContentHash('original'),contextDigest:canonicalContentHash('context')},current:()=>true,async check(){return {state:'verified',reason:'memory_rechecked'}}},'memory_unavailable')
    await recovery.idle('export');await recovery.close()
    const service=new DshSessionLogExportService(mirror,{analysis:async id=>sessionDatabaseAnalysis(db,id)})
    const response=await dshSessionExportResponse(service,new Request('http://localhost/api/session.export?sessionId=export'))
    assert.equal(response.status,200)
    const files=unzip(Buffer.from(await response.arrayBuffer())),text=files.get('dsh-session-export.jsonl')!.toString()
    for(const forbidden of ['SYNTHETIC_PRIVATE_RAW','SYNTHETIC_SIGNATURE','SYNTHETIC_AUTH','SYNTHETIC_STATE'])assert.ok(!text.includes(forbidden))
    assert.ok(text.includes('検索結果を確認しました。'));assert.ok(text.includes('"input_tokens":10'))
    assert.equal(((await mirror.readSession('export')).events[2]!.data as any).message.content[0].rawText,'SYNTHETIC_PRIVATE_RAW','private source remains canonical')
    const analysis=JSON.parse(files.get('kiokuko-analysis.json')!.toString())
    assert.equal(analysis.tools[0].callId,'call');assert.equal(analysis.tools[0].route,'lisp');assert.equal(analysis.tools[0].durationMs,3)
    assert.equal(analysis.tools[0].outcome,'returned');assert.equal(analysis.tools[0].execution,'not_recorded')
    assert.equal(analysis.database.runs[0].runId,p.run.runId);assert.equal(analysis.database.runs[0].completion.verified,false)
    assert.equal(analysis.database.runs[0].completion.criteria[0].reason,'no_binding')
    assert.equal(analysis.database.recovery[0].state,'verified');assert.equal(analysis.database.recovery[0].attempts,1)
    assert.equal(analysis.database.improvementHandoff.consumerReceipt,'not_recorded');assert.equal(analysis.database.improvementHandoff.automaticAdoption,false)
    await writeFile(join(root,'check.mjs'),'// source version one')
    const criterionId=assessTaskCompletion(db,p.run.runId).criteria[0]!.criterionId
    bindTaskCriterion(db,{runId:p.run.runId,criterionId,callId:'binding',approved:true,method:{kind:'native_command',command:'node check.mjs',cwd:'.',sourcePaths:['check.mjs'],assertion:'exit_zero'}})
    const criterion=()=> (sessionDatabaseAnalysis(db,'export') as any).runs[0].completion.criteria[0]
    for(const [callId,exitCode,expected] of [['failure',1,'unmet'],['success',0,'satisfied']] as const){
      assert.equal(beginTaskCompletionExecution(db,{runId:p.run.runId,callId,command:'node check.mjs',repositoryRoot:root}),true)
      finishTaskCompletionExecution(db,{runId:p.run.runId,callId,result:{value:{exitCode},content:[]}})
      assert.equal(criterion().state,expected)
    }
    await writeFile(join(root,'check.mjs'),'// source version two')
    assert.equal(criterion().state,'stale');assert.equal(criterion().reason,'source_changed')
    assert.equal((await dshSessionExportResponse(service,new Request('http://localhost/api/session.export?sessionId=export',{method:'HEAD'}))).body,null)
  } finally {await mirror.close();db.close();await rm(base,{recursive:true,force:true})}
})


test('an unavailable optional analysis cannot veto actual Web export or imply verification',async()=>{
  const base=await mkdtemp('/tmp/kiokuko-export-analysis-timeout-'),db=openConnection(join(base,'db.sqlite3'));migrateDatabase(db)
  const mirror=new DshSessionLogMirror({runtime:{withDatabase:async(fn:any)=>fn(db)} as any,databasePath:join(base,'mirror.sqlite3')})
  let reject!:(error:Error)=>void
  const keepalive=setTimeout(()=>{},2000)
  try{
    await mirror.checkpointAfterNativeFlush({id:'timeout',snapshotEvents:()=>[{seq:0,time:1,type:'turn/end',data:{turn:1,reason:{kind:'cancelled'}}}]})
    const service=new DshSessionLogExportService(mirror,{analysis:()=>new Promise((_r,j)=>reject=j)})
    const start=performance.now(),response=await dshSessionExportResponse(service,new Request('http://localhost/api/session.export?sessionId=timeout'))
    assert.equal(response.status,200);assert.ok(performance.now()-start<1500)
    const files=unzip(Buffer.from(await response.arrayBuffer())),analysis=JSON.parse(files.get('kiokuko-analysis.json')!.toString())
    assert.equal(analysis.database.status,'unavailable');assert.equal(analysis.turns[0].reason,'cancelled')
    reject(Error('late analysis failure'));await new Promise(r=>setImmediate(r))
  }finally{clearTimeout(keepalive);await mirror.close();db.close();await rm(base,{recursive:true,force:true})}
})
