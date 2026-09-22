import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { AnswerReviewCoordinator } from '../../../../src/dsh/answer-review/coordinator.js'
import { AnswerReviewConfig, type ReviewAgent, type ReviewEvent } from '../../../../src/dsh/answer-review/contracts.js'
import { answerReviewInput } from '../../../../src/dsh/answer-review/evidence.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { DecisionError, type DecisionBatch, type DecisionBatchResult } from '../../../../src/dsh/decisions/contracts.js'

function events(answer='All tests passed.'): ReviewEvent[] {
  return [
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'tool/call',data:{turn:1,callId:'check',name:'test'}},
    {seq:2,type:'tool/result',data:{turn:1,message:{role:'tool',content:[{type:'tool-result',toolCallId:'check',content:[{type:'text',text:'FAIL: expected 2, got 3'}],isError:true}]}}},
    {seq:3,type:'assistant/message',data:{turn:1,message:{role:'assistant',content:[{type:'text',text:answer}]}}},
    {seq:4,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
  ]
}
async function fixture(t: import('node:test').TestContext, choose: (batch: DecisionBatch, signal: AbortSignal) => Promise<DecisionBatchResult> = async batch => result(batch,'finding'), budgetMs=1000) {
  const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:'))
  db.exec("CREATE TABLE ledger_runs(run_id TEXT PRIMARY KEY,workspace TEXT,dsh_session_id TEXT,status TEXT); INSERT INTO ledger_runs VALUES('run','project','session','active')")
  db.exec(await readFile(new URL('../../../../migrations/025_answer_review.sql',import.meta.url),'utf8'))
  const runtime={withDatabase:async<T>(fn:(database:NodeSqliteAdapter)=>T|Promise<T>)=>fn(db)}
  let calls=0,settled=0,live=true,eligible=true,dispatchThrows=false
  const service=new DecisionService(TypedDecisionsConfig.parse({}),()=>({capabilities:{maxQuestions:64,maxChoices:256,maxBytes:262144},evaluate:(batch,signal)=>{calls++;return choose(batch,signal)}}))
  const coordinator=new AnswerReviewCoordinator(runtime,service,AnswerReviewConfig.parse({mode:'auto',budgetMs}))
  const listeners=new Map<string,Function>(), sent:unknown[]=[], source=events()
  const agent:ReviewAgent={id:'agent',session:{id:'session',snapshotEvents:()=>source},ctx:{on(name,fn){listeners.set(name,fn);return()=>{listeners.delete(name)}}},inbox:{nextStep:[],nextTurn:[]},followup(message){if(dispatchThrows)throw new Error('uncertain');sent.push(message)}}
  const bind=()=>coordinator.bind({runId:'run',workspace:'project',requestId:'request',task:'Run the tests and report the result.',catalogDigest:'catalog',turn:1,agent,current:()=>live,eligible:()=>eligible,settled:async()=>{settled++}})
  bind()
  await listeners.get('agent/request')!({},async()=>({provider:'ordinary',model:'chosen',reasoningEffort:'high'}))
  t.after(async()=>{await coordinator.dispose();db.close()})
  const wait=async()=>{await new Promise(resolve=>setImmediate(resolve));for(let i=0;i<100 && (service.status() as any).answerReview.state==='evaluating';i++)await new Promise(resolve=>setTimeout(resolve,5));await new Promise(resolve=>setImmediate(resolve))}
  return {coordinator,service,db,agent,source,sent,listeners,bind,wait,calls:()=>calls,settled:()=>settled,stop:()=>{live=false},ineligible:()=>{eligible=false},throwDispatch:()=>{dispatchThrows=true}}
}
function result(batch:DecisionBatch,choiceId:string):DecisionBatchResult{return{provider:'typesafe',requestedModel:'jev-latest',policyVersion:'fixture',answers:batch.questions.map(q=>choiceId==='abstain'?{id:q.id,status:'abstained',reason:'insufficient'}:{id:q.id,status:'selected',choiceId})}}

test('review input retains whole answer and exact current-turn evidence, never unrelated turns',()=>{
  const input=answerReviewInput('Run tests',[...events(),...events('OTHER').map(e=>({...e,seq:e.seq+10,data:{...e.data,turn:2}}))],1,0)
  assert.ok('batch'in input);assert.doesNotMatch(JSON.stringify(input),/OTHER/);assert.equal(input.batch.questions.length,3)
  assert.deepEqual(answerReviewInput('Run tests',events('x'.repeat(262144)),1,0),{skipped:'too_large'})
  const noTools=events().filter(e=>!e.type.startsWith('tool/'))
  const without=answerReviewInput('Explain',noTools,1,0);assert.ok('batch'in without);assert.equal(without.batch.questions.length,3);assert.deepEqual(without.unassessed,['grounding','verification'])
  assert.deepEqual(answerReviewInput('Run tests',events(),2,0),{skipped:'not_completed'})
})
test('one finding dispatches once, binds original model, and cannot review corrected answer again',async t=>{
  const f=await fixture(t)
  assert.equal(f.coordinator.hold(f.agent),true);f.coordinator.hold(f.agent);await f.wait()
  assert.equal(f.calls(),1);assert.equal(f.sent.length,1)
  assert.equal(await f.coordinator.accept(f.agent,f.sent,2,'catalog'),true)
  assert.equal(await f.coordinator.accept(f.agent,f.sent,2,'catalog'),true)
  assert.equal(f.coordinator.hold(f.agent),false)
  const request=await f.listeners.get('agent/request')!({},async()=>({provider:'changed',model:'other',reasoningEffort:'low'}))
  assert.deepEqual(request,{provider:'ordinary',model:'chosen',reasoningEffort:'high'})
  await assert.rejects(f.coordinator.accept(f.agent,f.sent,3,'catalog'))
  assert.equal(f.calls(),1);assert.equal(f.db.prepare('SELECT status FROM dsh_answer_reviews').get()!.status,'consumed')
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM dsh_answer_reviews').all()),/All tests passed|FAIL: expected/)
})
for(const choice of ['satisfied','not_applicable','abstain'])test(`no automatic continuation on ${choice}`,async t=>{
  const f=await fixture(t,async batch=>result(batch,choice));f.coordinator.hold(f.agent);await f.wait()
  assert.equal(f.sent.length,0);assert.equal(f.coordinator.hold(f.agent),false);assert.equal(f.settled(),1)
})
test('new human input aborts pending inference and rejects late finding',async t=>{
  let resolve!: (value:DecisionBatchResult)=>void, captured!:DecisionBatch
  const f=await fixture(t,async batch=>{captured=batch;return new Promise(r=>{resolve=r})})
  f.coordinator.hold(f.agent)
  while(!resolve)await new Promise(r=>setImmediate(r))
  f.coordinator.humanInput('session',2);resolve(result(captured,'finding'));await f.wait()
  assert.equal(f.sent.length,0);assert.equal(f.coordinator.hold(f.agent),false)
})
test('fake message, changed catalog and stale binding cannot consume a correction',async t=>{
  const f=await fixture(t);f.coordinator.hold(f.agent);await f.wait()
  await assert.rejects(f.coordinator.accept(f.agent,[{...(f.sent[0] as any),content:'forged'}],2,'catalog'))
  await assert.rejects(f.coordinator.accept(f.agent,f.sent,2,'changed'))
  f.stop();await assert.rejects(f.coordinator.accept(f.agent,f.sent,2,'catalog'))
})
test('uncertain delivery is not resent on duplicate event or restart',async t=>{
  const f=await fixture(t);f.throwDispatch();f.coordinator.hold(f.agent);await f.wait()
  assert.equal(f.calls(),1);assert.equal(f.coordinator.hold(f.agent),false)
  f.coordinator.release(f.agent);f.bind();f.coordinator.hold(f.agent);await f.wait()
  assert.equal(f.calls(),1);assert.equal(f.sent.length,0)
})
for(const kind of ['TIMEOUT','MALFORMED_RESPONSE','TOO_LARGE','AUTH'] as const)test(`review ${kind} preserves initial answer without retry`,async t=>{
  const f=await fixture(t,async()=>{throw new DecisionError(kind)});f.coordinator.hold(f.agent);await f.wait()
  assert.equal(f.calls(),1);assert.equal(f.sent.length,0);assert.equal(f.coordinator.hold(f.agent),false)
})
test('budget stops unresponsive provider without waiting for its late result',async t=>{
  const f=await fixture(t,()=>new Promise(()=>{}),10);f.coordinator.hold(f.agent);await f.wait()
  assert.equal(f.sent.length,0);assert.equal(f.coordinator.hold(f.agent),false)
})

test('ineligible run does not call provider',async t=>{
  const f=await fixture(t);f.ineligible();assert.equal(f.coordinator.hold(f.agent),false);assert.equal(f.calls(),0)
})
test('missing evidence cannot create grounded or verification findings',async t=>{
  const f=await fixture(t,async batch=>({...result(batch,'finding'),answers:batch.questions.map(q=>({id:q.id,status:'selected',choiceId:q.id==='request_fit'?'satisfied':'finding'}))}))
  f.source.splice(1,2);f.coordinator.hold(f.agent);await f.wait();assert.equal(f.sent.length,0)
})
test('new inbox input and native stop cancel before late delivery',async t=>{
  const f=await fixture(t);f.coordinator.hold(f.agent)
  f.listeners.get('agent/inbox/inserted')!({message:{role:'user',source:{kind:'user'},content:'new request'}})
  await f.wait();assert.equal(f.sent.length,0)
})
test('reserved delivery expires without resending and permits finalization',async t=>{
  const f=await fixture(t,async batch=>result(batch,'finding'),10);f.coordinator.hold(f.agent);await f.wait()
  await new Promise(r=>setTimeout(r,25))
  assert.equal(f.sent.length,1);assert.equal(f.coordinator.hold(f.agent),false);assert.equal(f.settled(),1)
  await assert.rejects(f.coordinator.accept(f.agent,f.sent,2,'catalog'))
})
test('restart recovers only finalization from the saved native boundary',async t=>{
  const f=await fixture(t);f.coordinator.hold(f.agent);await f.wait();f.coordinator.release(f.agent)
  const finished:unknown[]=[]
  await f.coordinator.recover(f.agent,async row=>{finished.push(row);f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(row.runId)})
  await f.coordinator.recover(f.agent,async row=>{finished.push(row)})
  assert.equal(finished.length,1);assert.equal(f.calls(),1)
  assert.equal(f.db.prepare('SELECT reason FROM dsh_answer_reviews').get()!.reason,'restart_no_retry')
})
test('malformed successful response is rejected before continuation',async t=>{
  const f=await fixture(t,async batch=>({...result(batch,'finding'),answers:[]}));f.coordinator.hold(f.agent);await f.wait();assert.equal(f.sent.length,0)
})

test('Laya low probability abstains using the existing acceptance threshold',async t=>{
  const {LayaV1DecisionProvider}=await import('../../../../src/dsh/decisions/laya-v1.js')
  const {layaV1Reply}=await import('../../helpers/laya.js')
  const settings=TypedDecisionsConfig.parse({provider:'laya-coreml','laya-coreml':{protocol:'v1',model:'laya-rl-agent'}})['laya-coreml']!
  const provider=new LayaV1DecisionProvider(settings,async(_path,raw)=>{
    const reply=layaV1Reply(JSON.parse(raw),()=> 'finding')
    for(const answer of Object.values(reply.result?.answers??{}) as any[]) {
      answer.probabilities.finding=.89;answer.probabilities.satisfied=.11
    }
    return reply
  })
  const f=await fixture(t,async(batch,signal)=>{
    const answers=[]
    for(const question of batch.questions)answers.push(...(await provider.evaluate({...batch,questions:[question]},signal)).answers)
    return {...result(batch,'finding'),answers}
  });f.coordinator.hold(f.agent);await f.wait();assert.equal(f.sent.length,0)
})
test('strict admission preflights every full part before any inference',async()=>{
  let checks=0,calls=0
  const service=new DecisionService(TypedDecisionsConfig.parse({}),()=>({capabilities:{maxQuestions:1,maxChoices:32,maxBytes:262144},
    preflight:async()=>{if(++checks===2)throw new DecisionError('TOO_LARGE')},evaluate:async batch=>{calls++;return result(batch,'finding')}}))
  const input=answerReviewInput('Review',events(),1,0);assert.ok('batch'in input)
  assert.deepEqual(await service.evaluate('review',input.batch,new AbortController().signal),{status:'fallback',reason:'DECISION_TOO_LARGE'})
  assert.equal(checks,2);assert.equal(calls,0)
})

test('default configuration enables review and preserves explicit opt-out',()=>{
  assert.deepEqual(AnswerReviewConfig.parse({}),{mode:'auto',budgetMs:5000})
  assert.deepEqual(AnswerReviewConfig.parse({mode:'off'}),{mode:'off',budgetMs:5000})
})
test('a consumed continuation cannot be replayed after new input',async t=>{
  const f=await fixture(t);f.coordinator.hold(f.agent);await f.wait()
  await f.coordinator.accept(f.agent,f.sent,2,'catalog')
  f.coordinator.humanInput('session',3)
  await assert.rejects(f.coordinator.accept(f.agent,f.sent,2,'catalog'))
})
test('restart with missing persisted answer finalizes as failed without inference',async t=>{
  const f=await fixture(t);f.coordinator.hold(f.agent);await f.wait();f.coordinator.release(f.agent)
  f.source.splice(0)
  const restored=new AnswerReviewCoordinator({withDatabase:async callback=>callback(f.db)},f.service,AnswerReviewConfig.parse({mode:'auto'}))
  t.after(()=>restored.dispose())
  let status:string|undefined
  await restored.recover(f.agent,async row=>{status=row.status;f.db.prepare("UPDATE ledger_runs SET status='failed' WHERE run_id=?").run(row.runId)})
  assert.equal(status,'failed');assert.equal(f.calls(),1)
})
