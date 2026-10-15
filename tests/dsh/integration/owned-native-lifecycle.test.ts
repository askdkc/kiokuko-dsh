import { approvedOwnedMemory } from '../helpers/approved-owned-memory.js'
import {codingPrelude,interpretedPreparation,toolValue} from '../helpers/coding-script.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {nativeSkillFixture} from '../helpers/skill-native.js'
import {nativeToolResults} from '../helpers/native-mock.js'
import {isolateSkillHome} from '../helpers/skill-home.js'
import {openConnection} from '../../../src/db/connection.js'
import {readEntry} from '../../../src/memory/entries.js'
import {memoryExecutionEvidence} from '../../../src/dsh/owned-evidence.js'

isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT
if(process.env.KIOKUKO_REQUIRE_DSH_NATIVE==='1'&&!packages)throw new Error('Native runtime is required')

test('isolated native profile: repair -> real test -> receipt -> candidate -> reload -> recall -> fresh application',{
  skip:packages?false:'requires pinned native DSH',timeout:120000,
},async()=>{
  const f=await nativeSkillFixture({packages:packages!,...(process.env.KIOKUKO_OWNED_PACKAGE_ROOT?{packageRoot:process.env.KIOKUKO_OWNED_PACKAGE_ROOT}:{}),explicit:false,mode:'compiled',extra:{
    lisp:{enabled:false},typedDecisions:{mode:'off'},memoryReuse:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},
    memoryIndexReasoning:{mode:'off'},answerReview:{mode:'off'},semanticCompaction:{mode:'off'},modelAutoMode:{mode:'off'},toolExposure:{mode:'full'},
  }})
  let db:ReturnType<typeof openConnection>|undefined
  let summaries=0, observed:any, freshObserved:any
  const foreground=f.model.stream.bind(f.model)
  f.model.stream=async function*(request:any){
    if(request.purpose==='compaction'){
      const text=JSON.stringify(request.messages)
      if(text.includes('executionObservations')){
        const payload=JSON.parse(request.messages.at(-1).content[0].text)
        const evidence=payload.reconciliation.evidence.find((item:any)=>item.id.startsWith('owned:')&&item.text.includes('"verification":"passed"'))
        assert.ok(evidence,'finalizer sees an observed, passing receipt')
        summaries++
        const body='Native parser: source changes require a fresh selected test; previous receipts are historical.'
        yield* f.mock.textResponse(JSON.stringify({schemaVersion:4,memoryOperations:[{action:'add',kind:'lesson',title:'Native parser verification',body,evidenceIds:[evidence.id],claims:[{id:'native-check',text:body,evidence:[{evidenceId:evidence.id,supportingText:'"verification":"passed"'}]}]}]}))
      }else yield* f.mock.textResponse(JSON.stringify({schemaVersion:1,memories:[]}))
      return
    }
    yield* foreground(request)
  }
  const result=(request:any,id:string)=>{
    const message=nativeToolResults(request.messages).find((value:any)=>value.toolCallId===id)
    assert.ok(message,`native result ${id} exists`);assert.ok(!message.isError,JSON.stringify(message))
    return JSON.parse(message.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(''))
  }
  const command='node --test --test-reporter=tap src/parser.test.mjs'
  try{
    await mkdir(join(f.dir,'src'))
    await writeFile(join(f.dir,'src/parser.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('Native parser',()=>assert.equal(1+1,3));\n")
    f.responses.push(
      ...codingPrelude(f.mock,'repair-goal'),
      f.mock.toolCallResponse('repair','kioku_edit',{path:'src/parser.test.mjs',oldText:'1+1,3',newText:'1+1,2'}),
      (request:any)=>{assert.equal(result(request,'repair').applied,true);return f.mock.toolCallResponse('criteria','task_completion',{action:'status'})},
      (request:any)=>{const status=result(request,'criteria');assert.ok(status.criteria.length);return f.mock.toolCallResponse('bind','task_completion',{action:'bind',criterionId:status.criteria[0].criterionId,method:{kind:'native_command',command,cwd:'.',sourcePaths:['src/parser.test.mjs'],assertion:'selected_tests_pass'}})},
      (request:any)=>f.mock.toolCallResponse('bind-final','task_completion',{action:'bind',criterionId:`coding:${toolValue(request,'repair-goal-propose').workflowId}:user-entry`,method:{kind:'native_command',command,cwd:'.',sourcePaths:['src/parser.test.mjs'],assertion:'selected_tests_pass'}}),
      f.mock.toolCallResponse('verify','kioku_exec',{command}),
      f.mock.toolCallResponse('verify-final','kioku_exec',{command}),
      (request:any)=>{assert.equal(result(request,'verify').receipt.verification,'passed');observed=result(request,'verify-final');return f.mock.textResponse('修正と実プロセスのテストが成功しました。')},
    )
    await f.turn('Implement the Native parser correction in src/parser.test.mjs. 通常実行で。\n完了条件:\n- selected tests pass')
    db=openConnection(join(f.dir,'kiokuko-dsh.sqlite3'))
    const identity={runId:observed.receipt.runId,sessionId:observed.receipt.sessionId,workspace:db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<any>(observed.receipt.runId)!.workspace}
    assert.equal(db.prepare('SELECT count(*) n FROM entries').get<any>()!.n,0,'completed native work cannot save before human review')
    const entry=await approvedOwnedMemory({root:f.dir,get db(){return db!},identity},observed)
    assert.equal(entry.status,'candidate');assert.equal(summaries,0,'retired auxiliary finalization is never invoked')
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_execution_links').get<any>()!.n,1)
    const old=memoryExecutionEvidence(db,entry.id,entry.revision)[0]!
    assert.equal(old.currentTaskVerification,false)
    await f.reload('compiled')
    f.responses.push(
      interpretedPreparation(f.mock,'prepare-verification','new','verify','debug'),
      f.mock.toolCallResponse('saved-reference','memory_context',{cwd:f.dir,query:'Parser verification condition'}),
      (request:any)=>{const context=result(request,'saved-reference');assert.equal(context.replay.length,1);assert.equal(context.replay[0].source.taskId,old.runId);return f.mock.toolCallResponse('fresh-bind-status','task_completion',{action:'status'})},
      (request:any)=>f.mock.toolCallResponse('fresh-bind-first','task_completion',{action:'bind',criterionId:result(request,'fresh-bind-status').criteria[0].criterionId,method:{kind:'native_command',command,cwd:'.',sourcePaths:['src/parser.test.mjs'],assertion:'selected_tests_pass'}}),
      f.mock.toolCallResponse('fresh','kioku_exec',{command}),
      (request:any)=>{freshObserved=result(request,'fresh');assert.equal(freshObserved.exitCode,0);assert.equal(freshObserved.receipt.verification,'passed');assert.notEqual(freshObserved.receipt.runId,old.runId);assert.ok(freshObserved.receipt.summary);return f.mock.textResponse('承認済みの参照を読み、現在のソースを新しい実プロセスで検証しました。')},
    )
    await f.turn('Verify Native parser verification in src/parser.test.mjs again. 通常実行で。\n完了条件:\n- selected tests pass')
    assert.equal(await readFile(join(f.dir,'src/parser.test.mjs'),'utf8'),"import test from 'node:test';import assert from 'node:assert/strict';test('Native parser',()=>assert.equal(1+1,2));\n")
    assert.ok(freshObserved.receipt.processStarted);assert.ok(freshObserved.receipt.processStopped)
    assert.ok(memoryExecutionEvidence(db,entry.id,entry.revision).every(item=>item.runId===old.runId),'fresh execution does not silently rewrite or adopt the approved historical source')

  }finally{db?.close();await f.close()}
})
