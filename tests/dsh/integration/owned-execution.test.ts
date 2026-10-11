import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {prepareAgentTask} from '../../../src/dsh/task-intake.js'
import {OwnedExecutionService as SourceOwnedExecutionService,type ExecutionIdentity} from '../../../src/dsh/owned-execution.js'
import {assessTaskCompletion,bindTaskCriterion} from '../../../src/dsh/task-completion.js'
import {recordEntry,readEntry} from '../../../src/memory/entries.js'
import {recallScopedMemory} from '../../../src/memory/scoped-memory.js'
import {ownedRunEvidence,linkOwnedMemoryEvidence,memoryExecutionEvidence} from '../../../src/dsh/owned-evidence.js'
import {implementationRequested} from '../../../src/dsh/plan-transition.js'
import {parseTestSummary} from '../../../src/dsh/node-tap-summary.js'
import {DshMemoryFinalizer,type DshLogEvent} from '../../../src/dsh/session-memory-finalizer.js'
import {MemoryEvolutionConfig} from '../../../src/memory/evolution/contracts.js'
import {CoreTasks} from '../../../src/dsh/core/tasks.js'
import {memoryApplicationStatus,recordMemoryApplicationReview} from '../../../src/memory/application.js'

const ownedPackageRoot=process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const OwnedExecutionService:typeof SourceOwnedExecutionService=ownedPackageRoot?(await import(pathToFileURL(join(ownedPackageRoot,'dist/dsh/owned-execution.js')).href)).OwnedExecutionService:SourceOwnedExecutionService

async function finalize(f:Awaited<ReturnType<typeof fixture>>,result:any,failStorage=false){
  const events:DshLogEvent[]=[
    {seq:1,time:1,type:'turn/start',data:{turn:1}},
    {seq:2,time:2,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'Cargo parser: edit and verify selected tests.'}]}},
    {seq:3,time:3,type:'request/header',data:{header:{config:{provider:'fixture',model:'fixture'}}}},
    {seq:4,time:4,type:'request/context',data:{contextWindow:100000}},
    {seq:5,time:5,type:'tool/call',data:{callId:result.receipt.operationId,name:'kioku_exec',arguments:{command:result.receipt.command}}},
    {seq:6,time:6,type:'tool/result',data:{...result,message:{role:'user',source:{kind:'tool',callId:result.receipt.operationId},content:[{type:'text',text:JSON.stringify(result)}]}}},
    {seq:7,time:7,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
  ]
  let calls=0
  const createFinalizer=()=>new DshMemoryFinalizer({runtime:{withDatabase:async(fn:any)=>fn(f.db)} as any,autoGlobalizationEnabled:false,
    memoryEvolution:MemoryEvolutionConfig.parse({mode:'off'}),
    sessionQuery:{async readSession(){return {session:{id:f.identity.sessionId},inheritedEventCount:0,events}}},
    llm:{async *stream(request){
      assert.match(JSON.stringify(request.messages),/executionObservations/)
      const reconciliation=JSON.parse((request.messages.at(-1) as any).content[0].text).reconciliation
      const evidence=reconciliation.evidence.find((item:any)=>item.id===result.receipt.evidenceRef)
      assert.ok(evidence)
      calls++
      const body='Cargo parser: the selected source-bound check passed in this run; changed sources require a new check.'
      yield {type:'text-delta',text:JSON.stringify({schemaVersion:4,memoryOperations:[{action:'add',kind:'lesson',title:'Cargo parser verification condition',body,evidenceIds:[evidence.id],claims:[{id:'check',text:body,evidence:[{evidenceId:evidence.id,supportingText:'"verification":"passed"'}]}]}]})}
      yield {type:'finish',reason:{kind:'stop'}}
    }}})
  let finalizer=createFinalizer()
  try{
    await finalizer.start()
    f.db.prepare('INSERT INTO dsh_run_log_boundaries VALUES(?,?,?,1,1,?,?)').run(f.identity.runId,f.identity.workspace,f.identity.sessionId,new Date().toISOString(),new Date().toISOString())
    f.db.prepare("UPDATE ledger_runs SET status='completed' WHERE run_id=?").run(f.identity.runId)
    finalizer.scheduleInTransaction(f.db,{runId:f.identity.runId,workspace:f.identity.workspace,dshSessionId:f.identity.sessionId,sourceEndSeq:7})
    if(failStorage)f.db.exec("CREATE TRIGGER owned_save_failure BEFORE INSERT ON memory_execution_links BEGIN SELECT RAISE(ABORT,'injected memory persistence failure'); END")
    finalizer.kick();await finalizer.whenIdle()
    if(failStorage){
      assert.equal(f.db.prepare('SELECT status FROM dsh_memory_finalizations').get<any>().status,'failed')
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<any>().n,0,'failed adoption transaction has no partial candidate')
      assert.ok(f.db.prepare('SELECT staged_capsule_json FROM dsh_memory_finalizations').get<any>().staged_capsule_json)
      f.db.exec('DROP TRIGGER owned_save_failure')
      await finalizer.dispose();await f.restart();finalizer=createFinalizer();await finalizer.start();await finalizer.whenIdle()
    }
    const status=f.db.prepare('SELECT status,last_error_message FROM dsh_memory_finalizations').get<any>()
    assert.equal(status.status,'completed',JSON.stringify(status))
    finalizer.kick();await finalizer.whenIdle();assert.equal(calls,1)
    return readEntry(f.db,{workspace:f.identity.workspace,entryId:f.db.prepare('SELECT entry_id FROM dsh_memory_finalization_entries WHERE run_id=?').get<any>(f.identity.runId).entry_id})
  }finally{await finalizer.dispose()}
}

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'kioku-owned-')))
  await mkdir(join(root,'.git'));await mkdir(join(root,'src'))
  await writeFile(join(root,'src/check.test.mjs'),"import test from 'node:test';test('actual process',()=>{});\n")
  let db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  const task=await prepareAgentTask(db,{requestId:'owned',cwd:root,task:'Cargo parser\n完了条件:\n- テストが成功する',dshSessionId:'owned-session',completionMode:'enforce',profileHints:{taskType:'research',target:'src',expected:'tests pass',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
  const agent={id:'owned-agent'},identity:ExecutionIdentity={runId:task.run.runId,sessionId:'owned-session',workspace:task.project.workspace,repositoryRoot:root,generation:'generation-1',agent}
  let unavailable=false,plan=false,approvals=0
  const runtime:any={withDatabase:async(fn:any)=>{if(unavailable)throw new Error('storage failed');return fn(db)}}
  const host={runtime,resolve:(execution:any)=>execution.agent===agent?identity:undefined,planActive:()=>plan,confirm:async()=>{approvals++;return false}}
  let service=new OwnedExecutionService(host)
  const execute=(name:string,args:any,id:string)=>service.execute(name,args,{name,arguments:args,callId:id,agent,signal:new AbortController().signal}) as Promise<any>
  const bind=(command:string,cwd='src',sourcePaths=['src/check.test.mjs'])=>bindTaskCriterion(db,{runId:identity.runId,callId:'bind-'+command,criterionId:assessTaskCompletion(db,identity.runId).criteria[0]!.criterionId,method:{kind:'native_command',command,cwd,sourcePaths,assertion:'selected_tests_pass'},approved:true})
  return {root,identity,execute,bind,get db(){return db},get service(){return service},approvals:()=>approvals,setUnavailable:(v:boolean)=>unavailable=v,setPlan:(v:boolean)=>plan=v,
    async restart(){await service.close();db.close();db=openConnection(join(root,'state.sqlite3'));service=new OwnedExecutionService(host)},async cleanup(){await service.close();db.close();await rm(root,{recursive:true,force:true})}}
}

test('edit -> real test -> durable evidence -> candidate memory -> restart -> recall with fresh/stale source state',async()=>{
  const f=await fixture()
  try {
    const edited=await f.execute('kioku_edit',{path:'src/check.test.mjs',oldText:'actual process',newText:'Cargo parser'},'edit')
    assert.equal(edited.applied,true);assert.notEqual(edited.receipt.targets[0].before,edited.receipt.targets[0].after)
    const command='node --test --test-reporter=tap check.test.mjs';f.bind(command)
    const result=await f.execute('kioku_exec',{command:"'node' '--test' '--test-reporter=tap' 'check.test.mjs'",cwd:'src'},'test')
    assert.equal(result.exitCode,0);assert.equal(result.receipt.processStarted,true);assert.equal(result.receipt.verification,'passed');assert.equal(result.receipt.checks[0].outcome,'passed')
    assert.equal(f.approvals(),0)
    const entry=await finalize(f,result,true)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_execution_links').get<any>().n,1)
    assert.throws(()=>linkOwnedMemoryEvidence(f.db,entry,[],[result.receipt.evidenceRef],f.identity),/missing|another run/)
    assert.throws(()=>linkOwnedMemoryEvidence(f.db,entry,ownedRunEvidence(f.db,f.identity.runId,f.identity.sessionId),[result.receipt.evidenceRef],{...f.identity,runId:'another-run'}),/another run/)
    await f.restart()
    const recall=await recallScopedMemory(f.db,{cwd:f.root,query:'Cargo parser',limit:5,maxChars:4000})
    assert.ok(JSON.stringify(recall).includes(entry.id))
    assert.equal(readEntry(f.db,{workspace:f.identity.workspace,entryId:entry.id}).status,'candidate')
    assert.equal(memoryExecutionEvidence(f.db,entry.id,entry.revision)[0]!.checks[0]!.state,'passed')
    const tasks=new CoreTasks({withDatabase:async(fn:any)=>fn(f.db)} as any)
    const next=await tasks.prepare({requestId:'next-owned-request',sessionId:'next-owned-session',turn:2,task:'Implement Cargo parser verification condition tests',cwd:f.root,
      profileHints:{taskType:'build',target:'Cargo parser src/check.test.mjs',expected:'Verify changed Cargo parser tests',constraints:'Preserve source-bound verification'},
      capabilities:['kiokuko-soul','memory-reasoning'].map(name=>({kind:'skill' as const,name})),signal:new AbortController().signal})
    assert.equal(next.admitted,true)
    assert.ok(JSON.stringify(next.memory).includes(entry.id),'a new admitted request retrieves the stored candidate')
    const nextIdentity={runId:next.runId,sessionId:next.sessionId,workspace:next.workspace,repositoryRoot:f.root}
    const status=memoryApplicationStatus(f.db,next.runId)
    recordMemoryApplicationReview(f.db,nextIdentity,'next-adoption',{generation:status.generation,entryId:entry.id,entryRevision:entry.revision,expectedRevision:0,decision:'adopted',
      basis:'The recalled candidate requires fresh source-bound checks; its old run is historical evidence.',paths:['src/check.test.mjs'],invariant:'Changed parser sources require a new check.',counterexample:'Old passed receipts cannot satisfy a new run.',method:'Run the selected Node tests again.',command})
    assert.equal(memoryApplicationStatus(f.db,next.runId).ready,false,'historical passing receipts do not verify the new request')
    await f.execute('kioku_write',{path:'generated.txt',content:'unrelated'},'generated')
    assert.equal(memoryExecutionEvidence(f.db,entry.id,entry.revision)[0]!.checks[0]!.state,'passed')
    await f.execute('kioku_write',{path:'src/check.test.mjs',content:'changed'},'changed')
    assert.equal(memoryExecutionEvidence(f.db,entry.id,entry.revision)[0]!.checks[0]!.state,'stale')
    const replay=await f.execute('kioku_edit',{path:'src/check.test.mjs',oldText:'actual process',newText:'Cargo parser'},'edit')
    assert.equal(replay.replayed,true);assert.equal(await readFile(join(f.root,'src/check.test.mjs'),'utf8'),'changed')
  }finally{await f.cleanup()}
})

test('an actual failing process cannot become passed through JSON or Lisp claims',async()=>{
  const f=await fixture()
  try{
    const command=`node -e 'console.log(JSON.stringify({passed:true}));process.exit(7)'`;f.bind(command,'.')
    const result=await f.execute('kioku_exec',{command},'false-passed')
    assert.equal(result.exitCode,7);assert.equal(result.receipt.verification,'failed')
    assert.equal(assessTaskCompletion(f.db,f.identity.runId).criteria[0]!.state,'unmet')
  }finally{await f.cleanup()}
})

test('asynchronous result collection and storage retry never replay process effects',async()=>{
  const f=await fixture()
  try{
    const command=`node -e 'require("fs").appendFileSync("counter","x")'`
    const started=await f.execute('kioku_exec',{command,background:true},'async')
    let result:any
    for(let i=0;i<100;i++){result=await f.execute('kioku_result',{operationId:started.receipt.operationId},'poll-'+i);if(result.receipt.state!=='started')break;await new Promise(done=>setTimeout(done,10))}
    assert.equal(result.receipt.state,'completed')
    await f.execute('kioku_result',{operationId:started.receipt.operationId},'again')
    await f.restart();await f.execute('kioku_result',{operationId:started.receipt.operationId},'after-restart')
    assert.equal(await readFile(join(f.root,'counter'),'utf8'),'x')
    f.setUnavailable(true)
    const write=await f.execute('kioku_write',{path:'saved.txt',content:'developer result'},'save-failure')
    assert.equal(write.applied,true);assert.equal(write.receipt.persistence,'pending')
    await f.restart()
    f.setUnavailable(false)
    const retry=await f.execute('kioku_result',{operationId:write.receipt.operationId},'retry-save')
    assert.equal(retry.receipt.persistence,'saved');assert.equal(await readFile(join(f.root,'saved.txt'),'utf8'),'developer result')
    await writeFile(join(f.root,'saved.txt'),'later edit')
    const replay=await f.execute('kioku_write',{path:'saved.txt',content:'developer result'},'save-failure')
    assert.equal(replay.replayed,true);assert.equal(await readFile(join(f.root,'saved.txt'),'utf8'),'later edit')
  }finally{await f.cleanup()}
})

test('Plan, generation, cancellation and explicit destructive review remain separate from ordinary writes',async()=>{
  const f=await fixture()
  try{
    f.setPlan(true)
    await assert.rejects(f.execute('kioku_write',{path:'src/check.test.mjs',content:'x'},'plan'),/Plan/)
    assert.ok(await f.execute('kioku_read',{path:'src/check.test.mjs'},'read-plan'))
    f.setPlan(false)
    const denied=await f.execute('kioku_remove',{path:'src/check.test.mjs'},'delete')
    assert.equal(denied.receipt.state,'unknown');assert.equal(f.approvals(),1)
    assert.ok((await readFile(join(f.root,'src/check.test.mjs'),'utf8')).includes('actual process'))
    assert.equal(implementationRequested([{role:'user',source:{kind:'user'},content:'PLEASE IMPLEMENT THIS PLAN:'}]),true)
    assert.equal(implementationRequested([{role:'user',source:{kind:'plugin'},content:'Implement this plan'}]),false)
    assert.equal(implementationRequested([{role:'user',content:'> Implement this plan'}]),false)
    assert.equal(implementationRequested([{role:'user',content:'Example:\n```text\nImplement this plan\n```'}]),false)
    assert.equal(implementationRequested([{role:'user',content:'Example:\n```text\nImplement this plan'}]),false)
  }finally{await f.cleanup()}
})

test('whole output is parsed before preview and incomplete/zero/ignored Cargo coverage is distinct',()=>{
  const trailer='\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  assert.equal(parseTestSummary('diagnostic\n'.repeat(10000)+trailer,true)?.tests,1)
  assert.equal(parseTestSummary('running 1 test\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s')?.skipped,1)
  assert.equal(parseTestSummary('running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'),undefined)
  assert.equal(parseTestSummary('running 2 tests\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'),undefined)
})

test('actual Cargo harness records selected tests, filtered coverage and ignored tests',{
  skip:process.env.KIOKUKO_REQUIRE_CARGO_RUNTIME!=='1'?'requires explicit Cargo runtime acceptance':false,
},async()=>{
  const f=await fixture()
  try{
    await mkdir(join(f.root,'rust/src'),{recursive:true})
    await writeFile(join(f.root,'rust/Cargo.toml'),'[package]\nname="owned_receipt_fixture"\nversion="0.1.0"\nedition="2021"\n')
    await writeFile(join(f.root,'rust/src/lib.rs'),'#[test] fn selected() { assert_eq!(2+2,4); }\n#[test] #[ignore] fn ignored() {}\n')
    const sources=['rust/Cargo.toml','rust/src/lib.rs'],selected='cargo test --offline selected'
    f.bind(selected,'rust',sources)
    const passed=await f.execute('kioku_exec',{command:selected,cwd:'rust'},'cargo-selected')
    assert.equal(passed.exitCode,0,passed.output);assert.equal(passed.receipt.verification,'passed');assert.equal(passed.receipt.summary.tests,1);assert.equal(passed.receipt.summary.filtered,1)
    const all='cargo test --offline';f.bind(all,'rust',sources)
    const ignored=await f.execute('kioku_exec',{command:all,cwd:'rust'},'cargo-ignored')
    assert.equal(ignored.exitCode,0,ignored.output);assert.equal(ignored.receipt.verification,'failed');assert.equal(ignored.receipt.summary.skipped,1)
  }finally{await f.cleanup()}
})

test('actual timeout and background cancellation persist terminal flags without replaying effects',async()=>{
  const f=await fixture()
  try{
    const command="node -e 'setInterval(()=>{},1000)'"
    f.bind(command,'.')
    const timeout=await f.execute('kioku_exec',{command,timeoutMs:100},'timeout')
    assert.equal(timeout.receipt.timedOut,true)
    assert.equal(timeout.receipt.verification,'failed')
    assert.equal(timeout.receipt.outputComplete,false)
    const started=await f.execute('kioku_exec',{command:"node -e 'require(\"fs\").appendFileSync(\"cancel-count\",\"x\");setInterval(()=>{},1000)'",background:true},'cancel-job')
    for(let n=0;n<100;n++){
      try{if(await readFile(join(f.root,'cancel-count'),'utf8')==='x')break}catch{/* wait for the actual child effect */}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(await readFile(join(f.root,'cancel-count'),'utf8'),'x')
    let final=await f.execute('kioku_result',{operationId:started.receipt.operationId,cancel:true},'cancel')
    for(let n=0;final.receipt.state==='started'&&n<100;n++){
      await new Promise(resolve=>setTimeout(resolve,10))
      final=await f.execute('kioku_result',{operationId:started.receipt.operationId},'collect-cancel')
    }
    assert.equal(final.receipt.state,'completed')
    assert.equal(final.receipt.cancelled,true)
    assert.equal(final.receipt.verification,'failed')
    await f.restart()
    const replay=await f.execute('kioku_result',{operationId:started.receipt.operationId},'after-restart')
    assert.equal(replay.receipt.cancelled,true)
    assert.equal(await readFile(join(f.root,'cancel-count'),'utf8'),'x')
  }finally{await f.cleanup()}
})

test('a passing test that changes registered configuration records both versions and cannot verify the old source',async()=>{
  const f=await fixture()
  try{
    await writeFile(join(f.root,'src/settings.json'),'{}')
    await writeFile(join(f.root,'src/check.test.mjs'),"import test from 'node:test';import{appendFileSync}from'node:fs';test('configuration mutation',()=>appendFileSync(new URL('./settings.json',import.meta.url),'\\n'));\n")
    const command='node --test --test-reporter=tap check.test.mjs'
    f.bind(command,'src',['src/check.test.mjs','src/settings.json'])
    const result=await f.execute('kioku_exec',{command,cwd:'src'},'changing-check')
    assert.equal(result.exitCode,0);assert.equal(result.receipt.summary.pass,1)
    assert.equal(result.receipt.verification,'unknown')
    assert.equal(result.receipt.checks[0].outcome,'stale')
    assert.notEqual(result.receipt.checks[0].sourceDigest,result.receipt.checks[0].postSourceDigest)
    const changed=result.receipt.targets.find((target:any)=>target.path===join(f.root,'src/settings.json'))
    assert.ok(changed);assert.notEqual(changed.before,changed.after)
  }finally{await f.cleanup()}
})
