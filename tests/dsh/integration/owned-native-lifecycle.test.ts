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
  let summaries=0
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
    await mkdir(join(f.dir,'.git'));await mkdir(join(f.dir,'src'))
    await writeFile(join(f.dir,'src/parser.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('Native parser',()=>assert.equal(1+1,3));\n")
    f.responses.push(
      f.mock.toolCallResponse('repair','kioku_edit',{path:'src/parser.test.mjs',oldText:'1+1,3',newText:'1+1,2'}),
      (request:any)=>{assert.equal(result(request,'repair').applied,true);return f.mock.toolCallResponse('criteria','task_completion',{action:'status'})},
      (request:any)=>{const status=result(request,'criteria');assert.ok(status.criteria.length);return f.mock.toolCallResponse('bind','task_completion',{action:'bind',criterionId:status.criteria[0].criterionId,method:{kind:'native_command',command,cwd:'.',sourcePaths:['src/parser.test.mjs'],assertion:'selected_tests_pass'}})},
      f.mock.toolCallResponse('verify','kioku_exec',{command}),
      (request:any)=>{assert.equal(result(request,'verify').receipt.verification,'passed');return f.mock.textResponse('修正と実プロセスのテストが成功しました。')},
    )
    await f.turn('Implement the Native parser correction in src/parser.test.mjs. 通常実行で。\n完了条件:\n- selected tests pass')
    db=openConnection(join(f.dir,'kiokuko-dsh.sqlite3'))
    for(let n=0;n<200;n++){
      if(db.prepare("SELECT 1 FROM dsh_memory_finalizations WHERE status='completed'").get())break
      await new Promise(resolve=>setTimeout(resolve,25))
    }
    assert.equal(db.prepare('SELECT status,last_error_message FROM dsh_memory_finalizations').get<any>()?.status,'completed')
    const row=db.prepare('SELECT id,workspace FROM entries').get<any>()!
    const entry=readEntry(db,{workspace:row.workspace,entryId:row.id})
    assert.ok(entry);assert.equal(entry.status,'candidate');assert.equal(summaries,1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_execution_links').get<any>()!.n,1)
    const old=memoryExecutionEvidence(db,entry.id,entry.revision)[0]!
    assert.equal(old.currentTaskVerification,false)
    await f.reload('compiled')
    f.responses.push(
      f.mock.toolCallResponse('application','task_memory_review',{action:'status'}),
      (request:any)=>{
        assert.ok(JSON.stringify(request.messages).includes(entry.id),'next request receives the saved candidate')
        const status=result(request,'application');assert.equal(status.ready,false)
        const item=status.items.find((item:any)=>item.entryId===entry.id);assert.ok(item)
        return f.mock.toolCallResponse('adopt','task_memory_review',{action:'review',review:{generation:status.generation,entryId:entry.id,entryRevision:entry.revision,expectedRevision:item.reviewRevision,decision:'adopted',basis:'The parser test currently checks the corrected result; the earlier receipt belongs to a previous run.',paths:['src/parser.test.mjs'],invariant:'Current parser sources require fresh verification.',counterexample:'Old receipt success is insufficient for this request.',method:'Execute the selected Node tests in this run.',command,cwd:'.'}})
      },
      (request:any)=>{assert.equal(result(request,'adopt').ready,false);return f.mock.toolCallResponse('fresh','kioku_exec',{command})},
      (request:any)=>{const fresh=result(request,'fresh');assert.equal(fresh.exitCode,0);assert.ok(fresh.receipt.summary,JSON.stringify(fresh));return f.mock.toolCallResponse('fresh-status','task_memory_review',{action:'status'})},
      (request:any)=>{const status=result(request,'fresh-status');assert.equal(status.ready,true,JSON.stringify({status,executions:db!.prepare("SELECT * FROM task_memory_executions").all()}));assert.equal(status.verification,'client_observed');return f.mock.textResponse('保存済みの条件を現在のソースで再検証しました。')},
    )
    await f.turn('Implement and verify Native parser verification in src/parser.test.mjs again. 通常実行で。')
    assert.equal(await readFile(join(f.dir,'src/parser.test.mjs'),'utf8'),"import test from 'node:test';import assert from 'node:assert/strict';test('Native parser',()=>assert.equal(1+1,2));\n")
    const runs=db.prepare('SELECT DISTINCT run_id FROM task_memory_executions WHERE outcome=\'passed\'').all<any>()
    assert.ok(runs.some(row=>row.run_id!==old.runId),'application observes a new run, not old evidence')
  }finally{db?.close();await f.close()}
})
