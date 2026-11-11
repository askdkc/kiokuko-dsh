import { approvedOwnedMemory } from '../helpers/approved-owned-memory.js'
import { bindHistoricalMemory } from '../helpers/historical-memory.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises'
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
import {ExecutionJournal} from '../../../src/dsh/execution-journal.js'
import {DshMemoryFinalizer,type DshLogEvent} from '../../../src/dsh/session-memory-finalizer.js'
import {MemoryEvolutionConfig} from '../../../src/memory/evolution/contracts.js'
import {CoreTasks} from '../../../src/dsh/core/tasks.js'
import {memoryApplicationStatus,recordMemoryApplicationReview} from '../../../src/memory/application.js'

const ownedPackageRoot=process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const OwnedExecutionService:typeof SourceOwnedExecutionService=ownedPackageRoot?(await import(pathToFileURL(join(ownedPackageRoot,'dist/dsh/owned-execution.js')).href)).OwnedExecutionService:SourceOwnedExecutionService

test('seven real Node commands preserve TAP identity through owned receipts and reopened SQLite', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'src/pass.test.mjs'), "import test from 'node:test';test('first passing case',()=>{});\n")
    await writeFile(join(f.root, 'src/pass-two.test.mjs'), "import test from 'node:test';test('second passing case',()=>{});\n")
    await writeFile(join(f.root, 'src/fail.test.mjs'), "import test from 'node:test';test('failing case',()=>{throw new Error('expected failure')});\n")
    const pass = 'node --test --test-reporter=tap pass.test.mjs', fail = 'node --test --test-reporter=tap fail.test.mjs'
    const sourcePaths = ['src/pass.test.mjs', 'src/pass-two.test.mjs', 'src/fail.test.mjs']
    const cases = [
      { name: 'single pass', command: pass, code: 0, tests: 1, passes: 1, fails: 0, verification: 'passed', state: 'satisfied' },
      { name: 'single failure', command: fail, code: 1, tests: 1, passes: 0, fails: 1, verification: 'failed', state: 'unmet' },
      { name: 'failure then pass', command: `${fail}; ${pass}`, code: 0, tests: null, verification: 'unknown', state: 'unknown' },
      { name: 'failure or pass', command: `${fail} || ${pass}`, code: 0, tests: null, verification: 'unknown', state: 'unknown' },
      { name: 'failure and pass', command: `${fail} && ${pass}`, code: 1, tests: 1, passes: 0, fails: 1, verification: 'failed', state: 'unmet' },
      { name: 'pass and pass', command: `${pass} && ${pass}`, code: 0, tests: null, verification: 'unknown', state: 'unknown' },
      { name: 'multiple files in one process', command: 'node --test --test-reporter=tap pass.test.mjs pass-two.test.mjs', code: 0, tests: 2, passes: 2, fails: 0, verification: 'passed', state: 'satisfied' },
    ] as const
    for (const [index, c] of cases.entries()) {
      f.bind(c.command, 'src', sourcePaths)
      const result = await f.execute('kioku_exec', { command: c.command, cwd: 'src' }, `seven-node-${index}`)
      assert.equal(result.exitCode, c.code, c.name)
      assert.equal(result.receipt.state, 'completed', c.name)
      assert.equal(result.receipt.processStopped, true, c.name)
      assert.equal(result.receipt.outputComplete, true, c.name)
      const check = (receipt: typeof result.receipt) => {
        if (c.tests === null) assert.equal(receipt.summary, undefined, c.name)
        else assert.deepEqual(receipt.summary, {tests:c.tests, pass:c.passes, fail:c.fails, cancelled:0, skipped:0, todo:0}, c.name)
        assert.equal(receipt.verification, c.verification, c.name)
      }
      check(result.receipt)
      assert.equal(assessTaskCompletion(f.db, f.identity.runId).criteria[0]!.state, c.state, c.name)
      await f.restart()
      const row = f.db.prepare('SELECT state,receipt_json FROM dsh_owned_operations WHERE operation_id=?')
        .get<{state:string;receipt_json:string}>(result.receipt.operationId)!
      assert.equal(row.state, 'completed', c.name)
      check(JSON.parse(row.receipt_json))
      assert.equal(assessTaskCompletion(f.db, f.identity.runId).criteria[0]!.state, c.state, c.name)
    }
  } finally { await f.cleanup() }
})

const finalize=approvedOwnedMemory

async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'kioku-owned-')))
  await mkdir(join(root,'.git'));await mkdir(join(root,'src'))
  await writeFile(join(root,'src/check.test.mjs'),"import test from 'node:test';test('actual process',()=>{});\n")
  let db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  const task=await prepareAgentTask(db,{requestId:'owned',cwd:root,task:'Parser\n完了条件:\n- テストが成功する',dshSessionId:'owned-session',completionMode:'enforce',profileHints:{taskType:'research',target:'src',expected:'tests pass',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
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
    const edited=await f.execute('kioku_edit',{path:'src/check.test.mjs',oldText:'actual process',newText:'Parser'},'edit')
    assert.equal(edited.applied,true);assert.notEqual(edited.receipt.targets[0].before,edited.receipt.targets[0].after)
    const command="'node' '--test' '--test-reporter=tap' 'check.test.mjs'";f.bind(command)
    const result=await f.execute('kioku_exec',{command:"'node' '--test' '--test-reporter=tap' 'check.test.mjs'",cwd:'src'},'test')
    assert.equal(result.exitCode,0);assert.equal(result.receipt.processStarted,true);assert.equal(result.receipt.verification,'passed');assert.equal(result.receipt.checks[0].outcome,'passed')
    assert.equal(f.approvals(),0)
    const entry=await finalize(f,result,true)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_execution_links').get<any>().n,1)
    assert.throws(()=>linkOwnedMemoryEvidence(f.db,entry,[],[result.receipt.evidenceRef],f.identity),/missing|another run/)
    assert.throws(()=>linkOwnedMemoryEvidence(f.db,entry,ownedRunEvidence(f.db,f.identity.runId,f.identity.sessionId),[result.receipt.evidenceRef],{...f.identity,runId:'another-run'}),/another run/)
    await f.restart()
    const recall=await recallScopedMemory(f.db,{cwd:f.root,query:'Parser',limit:5,maxChars:4000})
    assert.ok(JSON.stringify(recall).includes(entry.id))
    assert.equal(readEntry(f.db,{workspace:f.identity.workspace,entryId:entry.id}).status,'candidate')
    assert.equal(memoryExecutionEvidence(f.db,entry.id,entry.revision)[0]!.checks[0]!.state,'passed')
    const tasks=new CoreTasks({withDatabase:async(fn:any)=>fn(f.db)} as any)
    const next=await tasks.prepare({requestId:'next-owned-request',sessionId:'next-owned-session',turn:2,task:'Implement Parser verification condition tests',cwd:f.root,
      profileHints:{taskType:'build',target:'Parser src/check.test.mjs',expected:'Verify changed Parser tests',constraints:'Preserve source-bound verification'},
      capabilities:['kiokuko-soul','memory-reasoning'].map(name=>({kind:'skill' as const,name})),signal:new AbortController().signal})
    assert.equal(next.admitted,true)
    assert.equal(next.memory,null,'native preparation has no memory prerequisite')
    const context=await bindHistoricalMemory(f.db,next,(await resolveProjectWorkspace(f.db,f.root))!,f.root)
    assert.ok(JSON.stringify(context).includes(entry.id),'explicit historical retrieval retains the approved memory')
    const nextIdentity={runId:next.runId,sessionId:next.sessionId,workspace:next.workspace,repositoryRoot:f.root}
    const status=memoryApplicationStatus(f.db,next.runId)
    recordMemoryApplicationReview(f.db,nextIdentity,'next-adoption',{generation:status.generation,entryId:entry.id,entryRevision:entry.revision,expectedRevision:0,decision:'adopted',
      basis:'The recalled candidate requires fresh source-bound checks; its old run is historical evidence.',paths:['src/check.test.mjs'],invariant:'Changed parser sources require a new check.',counterexample:'Old passed receipts cannot satisfy a new run.',method:'Run the selected Node tests again.',command})
    assert.equal(memoryApplicationStatus(f.db,next.runId).ready,false,'historical passing receipts do not verify the new request')
    await assert.rejects(f.execute('kioku_write',{path:'generated.txt',content:'unrelated'},'generated'), /not Working/)
    await writeFile(join(f.root,'generated.txt'),'unrelated')
    assert.equal(memoryExecutionEvidence(f.db,entry.id,entry.revision)[0]!.checks[0]!.state,'passed')
    await writeFile(join(f.root,'src/check.test.mjs'),'changed')
    assert.equal(memoryExecutionEvidence(f.db,entry.id,entry.revision)[0]!.checks[0]!.state,'stale')
    const replay=await f.execute('kioku_result',{operationId:edited.receipt.operationId},'edit-result')
    assert.equal(replay.receipt.operationId,edited.receipt.operationId);assert.equal(await readFile(join(f.root,'src/check.test.mjs'),'utf8'),'changed')
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
    const command=`node -e 'require("fs").appendFileSync("counter","x");console.log("ordinary stdout");console.error("ordinary stderr")'`
    f.bind(command,'.')
    const started=await f.execute('kioku_exec',{command,background:true},'async')
    let result:any
    for(let i=0;i<100;i++){result=await f.execute('kioku_result',{operationId:started.receipt.operationId},'poll-'+i);if(result.receipt.state!=='started')break;await new Promise(done=>setTimeout(done,10))}
    assert.equal(result.receipt.state,'completed')
    assert.equal(result.exitCode,0);assert.match(result.output,/ordinary stdout/);assert.match(result.output,/ordinary stderr/)
    assert.equal(result.receipt.summary,undefined)
    assert.equal(result.receipt.verification,'unknown','unrecognized successful output cannot prove selected tests passed')
    assert.equal(assessTaskCompletion(f.db,f.identity.runId).criteria[0]!.state,'unknown')
    await f.execute('kioku_result',{operationId:started.receipt.operationId},'again')
    // Seed an older serialized receipt; reading it must not reinterpret its
    // optional metadata as new verification or repeat the original process.
    const journal=new ExecutionJournal(join(f.root,'.kioku','execution-journal'))
    const stored=await journal.read(started.receipt.operationId)
    assert.ok(stored)
    const legacySummary={tests:1,pass:1,fail:0,cancelled:0,skipped:0,todo:0,filtered:2,measured:0}
    stored.receipt.summary=legacySummary
    await journal.save(stored)
    f.db.prepare('UPDATE dsh_owned_operations SET receipt_json=? WHERE operation_id=?').run(JSON.stringify(stored.receipt),started.receipt.operationId)
    await f.restart()
    const restored=await f.execute('kioku_result',{operationId:started.receipt.operationId},'after-restart')
    assert.deepEqual(restored.receipt.summary,legacySummary);assert.equal(restored.receipt.verification,'unknown')
    const saved=JSON.parse(f.db.prepare('SELECT receipt_json FROM dsh_owned_operations WHERE operation_id=?').get<{receipt_json:string}>(started.receipt.operationId)!.receipt_json)
    assert.deepEqual(saved.summary,legacySummary)
    assert.equal(await readFile(join(f.root,'counter'),'utf8'),'x')
    f.setUnavailable(true)
    await assert.rejects(f.execute('kioku_write',{path:'unverified.txt',content:'must not execute'},'unavailable-authority'), /storage failed/)
    await assert.rejects(readFile(join(f.root,'unverified.txt')), {code:'ENOENT'})
    f.setUnavailable(false)
    f.db.exec("CREATE TRIGGER owned_receipt_failure BEFORE INSERT ON dsh_owned_operations BEGIN SELECT RAISE(ABORT,'injected receipt persistence failure'); END")
    const write=await f.execute('kioku_write',{path:'saved.txt',content:'developer result'},'save-failure')
    assert.equal(write.applied,true);assert.equal(write.receipt.persistence,'pending')
    f.db.exec('DROP TRIGGER owned_receipt_failure')
    await f.restart()
    f.setUnavailable(false)
    const retry=await f.execute('kioku_result',{operationId:write.receipt.operationId},'retry-save')
    assert.equal(retry.receipt.persistence,'saved');assert.equal(await readFile(join(f.root,'saved.txt'),'utf8'),'developer result')
    await writeFile(join(f.root,'saved.txt'),'later edit')
    const replay=await f.execute('kioku_write',{path:'saved.txt',content:'developer result'},'save-failure')
    assert.equal(replay.replayed,true);assert.equal(await readFile(join(f.root,'saved.txt'),'utf8'),'later edit')
  }finally{await f.cleanup()}
})

test('project-local deletion, replacement and declared command targets need no approval',async()=>{
  const f=await fixture()
  try{
    for(const name of ['source.txt','project.sqlite3']){
      await writeFile(join(f.root,name),'original')
      const replaced=await f.execute('kioku_write',{path:name,content:'replacement'},'replace-'+name)
      assert.equal(replaced.applied,true)
      assert.equal(await readFile(join(f.root,name),'utf8'),'replacement')
      const removed=await f.execute('kioku_remove',{path:name},'remove-'+name)
      assert.equal(removed.applied,true)
      await assert.rejects(readFile(join(f.root,name)),{code:'ENOENT'})
    }
    for(const declared of [false,true]){
      await writeFile(join(f.root,'src/remove.txt'),'source')
      const result=await f.execute('kioku_exec',{command:'rm -- remove.txt',cwd:'src',...(declared?{destructiveTargets:['remove.txt']}:{})},'rm-'+declared)
      assert.equal(result.exitCode,0,JSON.stringify(result))
      await assert.rejects(readFile(join(f.root,'src/remove.txt')),{code:'ENOENT'})
    }
    assert.equal(f.approvals(),0)
  }finally{await f.cleanup()}
})

test('external files, sibling-prefix paths and symlink escapes retain approval without effects',async()=>{
  const f=await fixture(),outside=f.root+'-outside'
  await mkdir(outside)
  try{
    await writeFile(join(outside,'keep.txt'),'keep')
    await symlink(outside,join(f.root,'escape'))
    const paths=[join(outside,'keep.txt'),'escape/keep.txt','escape/missing/new.txt']
    for(const [index,path] of paths.entries()){
      const result=await f.execute('kioku_write',{path,content:'forbidden'},'external-'+index)
      assert.notEqual(result.applied,true)
      assert.match(result.receipt.error,/not approved/i)
    }
    for(const [index,args] of [
      {command:`rm -- '${join(outside,'keep.txt')}'`},
      {command:'rm -- escape/keep.txt'},
      {command:'true',destructiveTargets:['escape/missing/new.txt']},
      {command:'true',cwd:outside,destructiveTargets:['keep.txt']},
    ].entries()){
      const result=await f.execute('kioku_exec',args,'external-command-'+index)
      assert.notEqual(result.receipt.processStarted,true)
    }
    assert.equal(f.approvals(),7)
    assert.equal(await readFile(join(outside,'keep.txt'),'utf8'),'keep')
    await assert.rejects(readFile(join(outside,'missing/new.txt')),{code:'ENOENT'})
  }finally{await f.cleanup();await rm(outside,{recursive:true,force:true})}
})

test('Plan, generation and cancellation remain separate from project-local writes',async()=>{
  const f=await fixture()
  try{
    f.setPlan(true)
    await assert.rejects(f.execute('kioku_write',{path:'src/check.test.mjs',content:'x'},'plan'),/Plan/)
    assert.ok(await f.execute('kioku_read',{path:'src/check.test.mjs'},'read-plan'))
    f.setPlan(false)
    const removed=await f.execute('kioku_remove',{path:'src/check.test.mjs'},'delete')
    assert.equal(removed.applied,true);assert.equal(f.approvals(),0)
    await assert.rejects(readFile(join(f.root,'src/check.test.mjs')),{code:'ENOENT'})
    assert.equal(implementationRequested([{role:'user',source:{kind:'user'},content:'PLEASE IMPLEMENT THIS PLAN:'}]),true)
    assert.equal(implementationRequested([{role:'user',source:{kind:'plugin'},content:'Implement this plan'}]),false)
    assert.equal(implementationRequested([{role:'user',content:'> Implement this plan'}]),false)
    assert.equal(implementationRequested([{role:'user',content:'Example:\n```text\nImplement this plan\n```'}]),false)
    assert.equal(implementationRequested([{role:'user',content:'Example:\n```text\nImplement this plan'}]),false)
  }finally{await f.cleanup()}
})

test('whole Node TAP output is parsed before the public preview',()=>{
  const trailer='\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  const output='diagnostic\n'.repeat(10000)+trailer
  assert.equal(parseTestSummary(output,true)?.tests,1)
  assert.equal(parseTestSummary(output),undefined,'only complete host output may bypass the preview size limit')
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

test('restart reconciles a durable final owned receipt after managed result persistence failed without reexecution',async()=>{
  const f=await fixture()
  try{
    f.db.exec("CREATE TRIGGER managed_result_failure BEFORE UPDATE ON dsh_managed_operations WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected managed result persistence failure'); END")
    await assert.rejects(f.execute('kioku_exec',{command:"node -e \"require('fs').appendFileSync('journal-counter','x')\""},'crash-window'),/injected managed/)
    const row=f.db.prepare("SELECT receipt_json FROM dsh_owned_operations WHERE state='completed'").get<{receipt_json:string}>()!
    const receipt=JSON.parse(row.receipt_json)
    assert.equal(receipt.processStopped,true)
    f.db.exec('DROP TRIGGER managed_result_failure')
    await f.restart()
    const result=await f.execute('kioku_result',{operationId:receipt.operationId},'recover-managed-result')
    assert.equal(result.receipt.processStopped,true)
    assert.equal(await readFile(join(f.root,'journal-counter'),'utf8'),'x')
    const operation=f.db.prepare("SELECT state FROM dsh_managed_operations WHERE json_extract(operation_json,'$.originalRef')=?").get<{state:string}>(receipt.operationId)!
    assert.equal(operation.state,'completed')
    await f.execute('kioku_exec',{command:"node -e \"require('fs').appendFileSync('journal-counter','x')\""},'crash-window')
    assert.equal(await readFile(join(f.root,'journal-counter'),'utf8'),'x')
  }finally{await f.cleanup()}
})
