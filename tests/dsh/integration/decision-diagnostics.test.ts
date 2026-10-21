import assert from 'node:assert/strict'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { loadMigrationSnapshot } from '../../../src/db/migrate.js'
import { mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalContentHash as hash } from '../../../src/serialization/validate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { AkinatorMemoryConfig } from '../../../src/akinator/memory-probe-types.js'
import { bindTaskRepository,transitionTask,transferTaskOwner,readTaskSnapshot } from '../../../src/dsh/task-state.js'
import { createDiagnosticAttempt,appendDiagnosticEvent,diagnosticId,diagnosticEventId,captureDiagnosticBinding,readDecisionDiagnostics,
  bestEffortDiagnostic,reviewDiagnosticStop,createIntakeDiagnosticSink,recordDiagnosticAdmission,recordDiagnosticTurn } from '../../../src/dsh/decisions/diagnostics.js'
import { DecisionService,databaseDecisionStore } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { mountDecisionCommand } from '../../../src/dsh/decisions/host.js'
import { enqueueUnsubmittedTurn } from '../../../src/dsh/turn-process.js'
import { classifyRequestIntent,createRequestIntentContext,rebindRequestIntentDecision } from '../../../src/dsh/decisions/request-intent.js'
import { requestIntentDiagnosticId } from '../../../src/dsh/decisions/diagnostic-correlation.js'

function fixture(t: import('node:test').TestContext) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'decision-diagnostic-'))),path=join(root,'state.sqlite3')
  let db=openConnection(path);migrateDatabase(db)
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true})})
  const service=new DshRunIntakeService(db,{akinatorMemory:AkinatorMemoryConfig.parse({mode:'off'})})
  const opened=service.openRun({idempotencyKey:'fixture',dshSessionId:'native-session',request:{apiVersion:'1',workspace:'project:diagnostics',task:{title:'Inspect parser',query:'Inspect parser',profileHints:{taskType:'research',target:'.',expected:'Report observations',constraints:null}},captureProfile:'minimal',coverage:{run:'unavailable',tool:'unavailable',command:'unavailable',file:'unavailable',approval:'unavailable'},metadata:{taskStateExplicit:true}}})
  const identity={taskId:opened.runId,sessionId:'native-session',repositoryRoot:root}
  const task=bindTaskRepository(db,identity)
  const attempt=()=>{
    const decisionId=diagnosticId(),binding=captureDiagnosticBinding(db,identity.taskId,identity.sessionId)
    createDiagnosticAttempt(db,decisionId,{origin:'intake',purpose:'request-intent',sessionId:identity.sessionId,turn:1,requestRef:hash('host-request'),inputDigest:hash('original-body'),policyRef:hash('host-policy'),binding})
    return decisionId
  }
  return {root,path,identity,task,attempt,get db(){return db},reopen(){db.close();db=openConnection(path)},runtime:{withDatabase:async<T>(f:(db:ReturnType<typeof openConnection>)=>T)=>f(db)}}
}
const event=(id:string,key:string)=>diagnosticEventId(id,key)
const question={kind:'question' as const,status:'waiting' as const,reason:'clarification_required' as const,referenceDigest:hash('host-question')}

test('migration adds decision attempts and causal events without changing existing decision results', () => {
  const db = openConnection(':memory:')
  try {
    migrateDatabase(db)
    for (const name of ['dsh_diagnostic_attempts', 'dsh_diagnostic_events', 'dsh_diagnostic_gaps', 'dsh_diagnostic_reviews']) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name), name)
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_decision_results').get()!.n, 0)
  } finally { db.close() }
})

test('migration upgrades a populated pre-diagnostics DB, is idempotent and rolls back an interrupted schema change', t=>{
  const root=mkdtempSync(join(tmpdir(),'diagnostic-upgrade-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const old=join(root,'old');mkdirSync(old)
  const snapshot=loadMigrationSnapshot()
  const targets=snapshot.migrations.filter(m=>m.name.slice(m.name.indexOf('_')+1,-'.sql'.length)==='decision_diagnostics')
  assert.equal(targets.length,1,'Expected exactly one decision_diagnostics migration')
  const target=targets[0]!,targetIndex=snapshot.migrations.indexOf(target)
  assert.ok(targetIndex>0,'Diagnostics migration needs a preceding storage schema')
  for(const source of snapshot.migrations.slice(0,targetIndex))writeFileSync(join(old,source.name),source.sql)
  const db=openConnection(join(root,'old.sqlite3'));t.after(()=>db.close());migrateDatabase(db,old)
  db.prepare('INSERT INTO dsh_decision_bindings VALUES(?,?,?)').run('existing','{}',hash({}))
  db.prepare('INSERT INTO dsh_decision_results VALUES(?,?,?)').run('existing',hash('old'),'OLD_RESULT_RETAINED')
  const historyBefore=db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all()
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='dsh_diagnostic_attempts'").get(),undefined)
  const interruption=new Error('diagnostics migration interrupted')
  assert.throws(()=>migrateDatabase(db,undefined,{beforeMarkApplied(database,m){if(m.name===target.name){
    for(const table of ['dsh_diagnostic_attempts','dsh_diagnostic_events','dsh_diagnostic_gaps','dsh_diagnostic_reviews'])
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),table)
    assert.equal(database.prepare('SELECT version FROM schema_migrations WHERE name=?').get(target.name),undefined)
    throw interruption
  }}}),error=>error===interruption)
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='dsh_diagnostic_attempts'").get(),undefined)
  assert.deepEqual(db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all(),historyBefore)
  assert.equal(db.prepare('SELECT result_json FROM dsh_decision_results WHERE request_id=?').get('existing')!.result_json,'OLD_RESULT_RETAINED')
  assert.deepEqual(migrateDatabase(db).applied,snapshot.migrations.slice(targetIndex).map(m=>m.version));assert.deepEqual(migrateDatabase(db).applied,[])
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dsh_diagnostic_attempts'").get())
  assert.equal(db.prepare('SELECT result_json FROM dsh_decision_results WHERE request_id=?').get('existing')!.result_json,'OLD_RESULT_RETAINED')
})

test('immutable attempts/events, exact replay and question-answer causality survive reopening',t=>{
  const f=fixture(t),id=f.attempt(),qid=event(id,'question'),aid=event(id,'answer')
  assert.equal(appendDiagnosticEvent(f.db,id,qid,question),1)
  assert.equal(appendDiagnosticEvent(f.db,id,qid,question),1)
  assert.throws(()=>appendDiagnosticEvent(f.db,id,qid,{...question,status:'blocked'}),/causal_conflict/)
  assert.throws(()=>appendDiagnosticEvent(f.db,id,event(id,'bad-answer'),{kind:'answer',status:'queued',reason:'answer_queued'}),/causal_conflict/)
  appendDiagnosticEvent(f.db,id,aid,{kind:'answer',status:'queued',reason:'answer_queued',parentEventId:qid,referenceDigest:hash('native-answer-id')})
  f.reopen()
  appendDiagnosticEvent(f.db,id,event(id,'resume'),{kind:'resume',status:'observed',reason:'resume_observed',parentEventId:aid,targetSessionId:f.identity.sessionId,binding:captureDiagnosticBinding(f.db,f.identity.taskId,f.identity.sessionId)})
  const read=readDecisionDiagnostics(f.db,f.identity.sessionId,id)
  assert.deepEqual(read.attempts[0]!.events.map(e=>e.sequence),[1,2,3])
  assert.equal(read.metrics.falseStopRate,null);assert.equal(read.metrics.evaluationRate,0)
  assert.equal(read.attempts[0]!.stages.semanticMatch,'not_run');assert.equal(read.attempts[0]!.stages.detector,'not_run')
  assert.throws(()=>f.db.prepare('UPDATE dsh_diagnostic_events SET kind=? WHERE event_id=?').run('route',qid),/immutable/)
  assert.throws(()=>createDiagnosticAttempt(f.db,id,{origin:'provider',purpose:'lisp',requestRef:hash('x'),inputDigest:hash('x'),policyRef:hash('p')}),/causal_conflict/)
})

for(const changed of ['revision','generation','epoch','session','workflow'] as const)test(`stale ${changed} cannot append under an old captured binding`,t=>{
  const f=fixture(t),id=f.attempt()
  if(changed==='revision')f.db.prepare('UPDATE ledger_runs SET task_revision=task_revision+1 WHERE run_id=?').run(f.identity.taskId)
  if(changed==='generation')f.db.prepare('UPDATE ledger_runs SET task_generation=task_generation+1 WHERE run_id=?').run(f.identity.taskId)
  if(changed==='session')f.db.prepare('UPDATE ledger_runs SET task_owner_session_id=? WHERE run_id=?').run('another-session',f.identity.taskId)
  if(changed==='epoch')f.db.prepare(`INSERT INTO dsh_task_source_history(run_id,source_epoch,source_session_id,original_session_id,task_generation,next_owner_session_id,operation_id,reason,archived_at) VALUES(?,1,?,?,1,?,'archive','test',?)`)
    .run(f.identity.taskId,f.identity.sessionId,f.identity.sessionId,f.identity.sessionId,new Date().toISOString())
  if(changed==='workflow') {
    const document=JSON.parse(String(f.db.prepare('SELECT document_json FROM dsh_diagnostic_attempts WHERE decision_id=?').get(id)!.document_json))
    // A claimed Goal revision not in the current workflow is not valid evidence.
    assert.throws(()=>createDiagnosticAttempt(f.db,diagnosticId(),{...document,binding:{...document.binding,workflowRevision:99,goalRevision:99,scopeRevision:99}}),/stale_binding/)
    return
  }
  assert.throws(()=>appendDiagnosticEvent(f.db,id,event(id,'stale'),question),/stale_binding/)
})

test('independent connections append consecutive sequences without lost or duplicate events',async t=>{
  const f=fixture(t),id=f.attempt()
  const script=`import {openConnection} from ${JSON.stringify(resolve('src/db/connection.ts'))};import {appendDiagnosticEvent,diagnosticEventId} from ${JSON.stringify(resolve('src/dsh/decisions/diagnostics.ts'))};const db=openConnection(process.argv[1]);for(let i=0;i<8;i++)appendDiagnosticEvent(db,process.argv[2],diagnosticEventId(process.argv[2],[process.argv[3],i]),{kind:'route',status:'observed',reason:'resolved'});db.close();`
  await Promise.all(['a','b','c'].map(worker=>promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script,f.path,id,worker])))
  const rows=f.db.prepare('SELECT sequence FROM dsh_diagnostic_events WHERE decision_id=? ORDER BY sequence').all(id)
  assert.deepEqual(rows.map(r=>r.sequence),Array.from({length:24},(_,i)=>i+1))
})

test('outer rollback removes diagnostics; diagnostic savepoint failure leaves authoritative state intact and exposes loss',t=>{
  const f=fixture(t),id=f.attempt()
  assert.throws(()=>withImmediateTransaction(f.db,()=>{appendDiagnosticEvent(f.db,id,event(id,'rollback'),question);throw new Error('outer rollback')}),/outer rollback/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_diagnostic_events').get()!.n,0)
  f.db.exec("CREATE TRIGGER diagnostic_test_failure BEFORE INSERT ON dsh_diagnostic_events BEGIN SELECT RAISE(ABORT,'RAW_SECRET_ERROR_DO_NOT_STORE'); END;")
  withImmediateTransaction(f.db,()=>{
    f.db.prepare('UPDATE ledger_runs SET task_reason=? WHERE run_id=?').run('authoritative-state',f.identity.taskId)
    assert.equal(bestEffortDiagnostic(f.db,'native-session',()=>appendDiagnosticEvent(f.db,id,event(id,'fail'),question)),false)
  })
  assert.equal(readTaskSnapshot(f.db,f.identity).reason,'authoritative-state')
  const diagnostics=readDecisionDiagnostics(f.db,f.identity.sessionId)
  assert.equal(diagnostics.completeness.persistedGaps,1);assert.equal(diagnostics.completeness.volatileLosses,1)
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM dsh_diagnostic_gaps').all()),/RAW_SECRET/)
})

test('false-stop denominator uses independent labels only; cascade leaves other waiting cases intact',t=>{
  const f=fixture(t),ids=[f.attempt(),f.attempt(),f.attempt()]
  for(const id of ids)appendDiagnosticEvent(f.db,id,event(id,'q'),question)
  reviewDiagnosticStop(f.db,ids[0]!,'false_stop',hash('independent-review-1'))
  reviewDiagnosticStop(f.db,ids[1]!,'justified_stop',hash('independent-review-2'))
  assert.deepEqual(readDecisionDiagnostics(f.db,f.identity.sessionId).metrics,{stopped:3,evaluated:2,falseStops:1,falseStopRate:0.5,evaluationRate:2/3})
  assert.throws(()=>reviewDiagnosticStop(f.db,ids[0]!,'justified_stop',hash('replaced')),/causal_conflict/)
  f.db.prepare('DELETE FROM dsh_diagnostic_attempts WHERE decision_id=?').run(ids[0]!)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_diagnostic_reviews').get()!.n,1)
  f.reopen();assert.equal(readDecisionDiagnostics(f.db,f.identity.sessionId).metrics.stopped,2)
  assert.equal(f.db.prepare('SELECT kind FROM dsh_diagnostic_events WHERE decision_id=?').get(ids[2]!)!.kind,'question')
})

test('explicit native handoff records target session and source epoch in the authoritative transaction',t=>{
  const f=fixture(t),id=f.attempt(),qid=event(id,'q')
  appendDiagnosticEvent(f.db,id,qid,question)
  appendDiagnosticEvent(f.db,id,event(id,'a'),{kind:'answer',status:'queued',reason:'answer_queued',parentEventId:qid,referenceDigest:hash('native-answer')})
  const before=readTaskSnapshot(f.db,f.identity)
  const transferred=transferTaskOwner(f.db,f.identity,{sessionId:'next-session',operationId:'native-handoff',expectedRevision:before.revision,expectedGeneration:before.generation,reason:'User selected next session',evidence:[]})
  f.reopen()
  const read=readDecisionDiagnostics(f.db,'next-session',id),resume=read.attempts[0]!.events.at(-1)!
  assert.equal(resume.kind,'resume');assert.equal(resume.targetSessionId,'next-session');assert.equal(resume.binding!.sourceEpoch,2)
  assert.equal(resume.binding!.generation,transferred.generation);assert.equal(read.metrics.falseStopRate,null)
  assert.equal(read.metrics.stopped,1)
})

for(const fault of [false,true])test(`explicit task resume preserves authority with diagnostic recording ${fault?'unavailable':'available'}`,t=>{
  const f=fixture(t),id=f.attempt(),qid=event(id,'q')
  appendDiagnosticEvent(f.db,id,qid,question)
  appendDiagnosticEvent(f.db,id,event(id,'a'),{kind:'answer',status:'queued',reason:'answer_queued',parentEventId:qid,referenceDigest:hash('answer-message')})
  const pending=transitionTask(f.db,f.identity,{operation:'wait',operationId:'wait',expectedRevision:f.task.revision,reason:'Explicit user wait'})
  if(fault)f.db.exec("CREATE TRIGGER resume_diagnostic_failure BEFORE INSERT ON dsh_diagnostic_events BEGIN SELECT RAISE(ABORT,'unavailable'); END;")
  const resumed=transitionTask(f.db,f.identity,{operation:'resume',operationId:'resume',expectedRevision:pending.revision,expectedGeneration:pending.generation,reason:'Explicit user resume',explicit:true})
  assert.equal(resumed.state,'Working');assert.equal(resumed.revision,pending.revision+1)
  const view=readDecisionDiagnostics(f.db,f.identity.sessionId,id)
  assert.equal(view.metrics.falseStopRate,null)
  if(fault)assert.ok(view.completeness.persistedGaps>0)
  else assert.ok(view.attempts[0]!.events.some(e=>e.kind==='resume' && e.binding?.sourceEpoch===2))
})

test('receipt and outbox references come from committed host rows and disappear on outer rollback',t=>{
  const f=fixture(t),id=f.attempt()
  const input={runId:f.identity.taskId,dshSessionId:f.identity.sessionId,nativeTurn:1,phase:'ideal' as const,contractRevision:1,inputDigest:hash('phase-input'),nextAction:'submit_ideal',operation:'ideal_submit' as const,idempotencyKey:'host-ideal-attempt'}
  assert.throws(()=>withImmediateTransaction(f.db,()=>{enqueueUnsubmittedTurn(f.db,input);assert.ok(f.db.prepare("SELECT 1 FROM dsh_diagnostic_events WHERE kind='receipt'").get());throw new Error('cut before commit')}),/cut before commit/)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_turn_receipts').get()!.n,0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_diagnostic_events').get()!.n,0)
  enqueueUnsubmittedTurn(f.db,input)
  const receipt=String(f.db.prepare('SELECT receipt_id FROM dsh_turn_receipts').get()!.receipt_id)
  recordDiagnosticTurn(f.db,receipt)
  const events=readDecisionDiagnostics(f.db,f.identity.sessionId,id).attempts[0]!.events
  assert.ok(events.some(e=>e.receiptId===receipt));assert.ok(events.some(e=>e.continuationId))
  assert.throws(()=>appendDiagnosticEvent(f.db,id,event(id,'fake'),{kind:'receipt',status:'observed',reason:'receipt_observed',receiptId:hash('made-up'),targetSessionId:f.identity.sessionId}),/causal_conflict/)
})

test('diagnostic failure does not veto a real receipt/outbox commit, and missing links remain observable after restart',t=>{
  const f=fixture(t),id=f.attempt()
  f.db.exec("CREATE TRIGGER diagnostic_test_failure BEFORE INSERT ON dsh_diagnostic_events BEGIN SELECT RAISE(ABORT,'not persisted'); END;")
  enqueueUnsubmittedTurn(f.db,{runId:f.identity.taskId,dshSessionId:f.identity.sessionId,nativeTurn:1,phase:'ideal',contractRevision:1,inputDigest:hash('phase-input'),nextAction:'submit_ideal',operation:'ideal_submit',idempotencyKey:'host-attempt'})
  f.reopen()
  const view=readDecisionDiagnostics(f.db,f.identity.sessionId,id)
  assert.equal(view.attempts[0]!.authoritativeLinks.receipts.length,1);assert.equal(view.attempts[0]!.authoritativeLinks.outbox.length,1)
  assert.equal(view.completeness.missingReceiptLinks,1);assert.equal(view.completeness.missingContinuationLinks,1)
  assert.ok(view.completeness.persistedGaps>0);assert.equal(readTaskSnapshot(f.db,f.identity).state,'ToDo')
})

test('an existing receipt from another native turn cannot be attached to this decision',t=>{
  const f=fixture(t),id=f.attempt()
  enqueueUnsubmittedTurn(f.db,{runId:f.identity.taskId,dshSessionId:f.identity.sessionId,nativeTurn:2,phase:'ideal',contractRevision:1,inputDigest:hash('other-turn'),nextAction:'submit_ideal',operation:'ideal_submit',idempotencyKey:'other-turn'})
  const receipt=String(f.db.prepare('SELECT receipt_id FROM dsh_turn_receipts').get()!.receipt_id)
  assert.throws(()=>appendDiagnosticEvent(f.db,id,event(id,'wrong-turn'),{kind:'receipt',status:'observed',reason:'receipt_observed',receiptId:receipt,targetSessionId:f.identity.sessionId}),/causal_conflict/)
})

test('provider observations persist real cache/Choice metadata; secrets and raw errors never enter diagnostics',async t=>{
  const f=fixture(t);let calls=0
  const service=new DecisionService(TypedDecisionsConfig.parse({}),(_config,observer)=>({capabilities:{maxQuestions:1,maxChoices:2,maxBytes:10000},evaluate:async()=>{
    calls++;observer?.({questionId:'question body SECRET',choice:'chosen SECRET',probabilities:[],topProbability:0.8,runnerUpProbability:0.2,margin:0.6,confidence:0.8,gate:'confidence',acceptance:{minConfidence:0.75},status:'selected',failedChecks:[]})
    return{provider:'typesafe',requestedModel:'model SECRET',revision:'version SECRET',policyVersion:'provider policy SECRET',answers:[{id:'q',status:'selected',choiceId:'yes'}]}
  }}),databaseDecisionStore(f.runtime))
  const batch={purpose:'request-intent',state:'ORIGINAL_SECRET_BODY',questions:[{id:'q',instructions:'QUESTION_SECRET',choices:[{id:'yes',description:'yes'},{id:'no',description:'no'}],abstainId:'no'}]}
  await service.evaluate('host-opaque-request',batch,new AbortController().signal)
  await service.evaluate('host-opaque-request',batch,new AbortController().signal)
  assert.equal(calls,1)
  const events=f.db.prepare('SELECT document_json FROM dsh_diagnostic_events').all().map(r=>JSON.parse(String(r.document_json)))
  assert.deepEqual(events.filter(e=>e.kind==='provider').map(e=>e.cacheHit),[false,true]);assert.equal(events.filter(e=>e.kind==='choice').length,1)
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM dsh_diagnostic_attempts').all())+JSON.stringify(events),/SECRET/)
  f.db.exec("CREATE TRIGGER provider_diagnostic_failure BEFORE INSERT ON dsh_diagnostic_attempts BEGIN SELECT RAISE(ABORT,'secret raw error'); END;")
  assert.equal((await service.evaluate('another-host-request',batch,new AbortController().signal)).status,'completed')
})

test('restart reconstructs question-answer-resume without storing either body or borrowing a foreign answer',async t=>{
  const f=fixture(t),input={agent:{session:{id:f.identity.sessionId}},turn:2,messages:[{id:'native-input-id',role:'user',content:'ORIGINAL_BODY_SECRET'}]}
  let sink=createIntakeDiagnosticSink(f.runtime)
  await sink(input,{kind:'question',questionRef:'host-question-id'})
  await sink(input,{kind:'answer',questionRef:'host-question-id',answerRef:'native-answer-id'})
  f.reopen();sink=createIntakeDiagnosticSink(f.runtime)
  await sink({agent:{session:{id:'foreign-session'}},turn:3,messages:[{id:'native-answer-id',role:'user',content:'ANSWER_BODY_SECRET'}]},{kind:'resume'})
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM dsh_diagnostic_events WHERE kind='resume'").get()!.n,0)
  await sink({...input,turn:3,messages:[{id:'native-answer-id',role:'user',content:'ANSWER_BODY_SECRET'}]},{kind:'resume'})
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM dsh_diagnostic_events WHERE kind='resume'").get()!.n,1)
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM dsh_diagnostic_events').all()),/BODY_SECRET/)
})

test('diagnostic command and reader use only SELECT and never probe, dispatch, migrate or label',async t=>{
  const f=fixture(t),id=f.attempt();appendDiagnosticEvent(f.db,id,event(id,'q'),question)
  const service=new DecisionService(TypedDecisionsConfig.parse({}),()=>{throw new Error('provider must not run')})
  let command:any;mountDecisionCommand({register:value=>{command=value;return()=>{}}},service,undefined,f.runtime)
  const readonly=openConnection(f.path,{readOnly:true});t.after(()=>readonly.close())
  const result=readDecisionDiagnostics(readonly,f.identity.sessionId);assert.equal(result.metrics.falseStopRate,null)
  const before=JSON.stringify(f.db.prepare('SELECT * FROM dsh_diagnostic_attempts').all())
  const displayed=await command.handler({rawInput:'diagnostics',signal:new AbortController().signal,agent:{session:{id:f.identity.sessionId}}})
  assert.equal(displayed.kind,'success');assert.equal(JSON.parse(displayed.text).metrics.falseStopRate,null)
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM dsh_diagnostic_attempts').all()),before)
  assert.equal(readDecisionDiagnostics(readonly,'foreign-session').attempts.length,0)
})

test('telemetry attempt IDs stay outside serialized request interpretations',async t=>{
  const f=fixture(t)
  const service=new DecisionService(TypedDecisionsConfig.parse({}),()=>({capabilities:{maxQuestions:32,maxChoices:32,maxBytes:65536},evaluate:async batch=>({provider:'fixture',requestedModel:'fixture',policyVersion:'fixture',answers:batch.questions.map(q=>q.id==='request-change-scope'?{id:q.id,status:'abstained' as const,reason:'uncertain' as const}:{id:q.id,status:'selected' as const,choiceId:q.id==='request-relation'?'new':'research'})})}),databaseDecisionStore(f.runtime))
  const context=createRequestIntentContext({task:'Inspect the parser without changes',messageRefs:[{id:'native-message',digest:hash('input')}]})!
  const first=await classifyRequestIntent(service,'host-cache-key',context,new AbortController().signal)
  const second=await classifyRequestIntent(service,'host-cache-key',context,new AbortController().signal)
  assert.ok(first && second)
  // Existing providerSent reports actual dispatch and intentionally changes on a cache hit.
  const {providerSent:firstSent,...firstInterpretation}=first,{providerSent:secondSent,...secondInterpretation}=second
  assert.equal(firstSent,true);assert.equal(secondSent,false)
  assert.deepEqual(firstInterpretation,secondInterpretation);assert.equal(hash(firstInterpretation),hash(secondInterpretation))
  assert.deepEqual(Object.keys(first).sort(),['relation','action','changeScope','source','policyVersion','evidence','providerSent'].sort())
  assert.ok(requestIntentDiagnosticId(first));assert.notEqual(requestIntentDiagnosticId(first),requestIntentDiagnosticId(second))
  assert.equal(requestIntentDiagnosticId(rebindRequestIntentDecision(first,context)),requestIntentDiagnosticId(first))
  assert.doesNotMatch(JSON.stringify(first),/dgn_/)
})

test('resume links the accepted answer to a fresh same-session source attempt and rejects foreign or stale lineage',t=>{
  const f=fixture(t),old=diagnosticId(),fresh=diagnosticId(),foreign=diagnosticId(),stale=diagnosticId()
  for(const [decisionId,sessionId,turn]of [[old,'native-session',1],[fresh,'native-session',2],[foreign,'foreign-session',2],[stale,'native-session',1]] as const)
    createDiagnosticAttempt(f.db,decisionId,{origin:'intake',purpose:'request-intent',requestRef:hash(`${sessionId}:${turn}`),sessionId,turn,inputDigest:hash(decisionId),policyRef:hash('policy'),referenceDigests:[hash('native-answer')]})
  const q=event(old,'question'),a=event(old,'answer')
  appendDiagnosticEvent(f.db,old,q,question)
  appendDiagnosticEvent(f.db,old,a,{kind:'answer',status:'queued',reason:'answer_queued',parentEventId:q,referenceDigest:hash('native-answer')})
  const resume={kind:'resume' as const,status:'observed' as const,reason:'resume_observed' as const,parentEventId:a,targetSessionId:'native-session'}
  assert.throws(()=>appendDiagnosticEvent(f.db,old,event(old,'foreign'),{...resume,nextDecisionId:foreign}))
  assert.throws(()=>appendDiagnosticEvent(f.db,old,event(old,'stale'),{...resume,nextDecisionId:stale}))
  appendDiagnosticEvent(f.db,old,event(old,'resume'),{...resume,nextDecisionId:fresh})
  assert.equal(readDecisionDiagnostics(f.db,'native-session',old).attempts[0]!.events.at(-1)!.nextDecisionId,fresh)
})
