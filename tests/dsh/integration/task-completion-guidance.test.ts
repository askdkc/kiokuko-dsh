import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {realpathSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {prepareAgentTask} from '../../../src/dsh/task-intake.js'
import {mountTaskCompletion} from '../../../src/dsh/task-completion-host.js'
import {initializeCodingWorkflow} from '../../../src/dsh/coding-workflow/store.js'
import {proposeCodingWorkflow} from '../../../src/dsh/coding-workflow/service.js'
import {CODING_MINIMUM_DEFINITION_EXAMPLE} from '../../../src/dsh/coding-workflow/contracts.js'
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const available=existsSync(join(packages,'@deepseek-ai/dsh-tools/lib/index.js'))
if(!available&&process.env.KIOKUKO_REQUIRE_DSH_NATIVE==='1')throw Error('Native completion guidance requires installed DSH')

test('KDSH-COMPLETION-INPUT-GUIDANCE-001: actual native errors name missing fields and conditions without accepting invalid proof',{skip:!available},async()=>{
  const load=(name:string)=>import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href)
  const [cordis,tools]=await Promise.all([load('cordis'),load('dsh-tools')])
  const root=realpathSync(await mkdtemp(join(tmpdir(),'completion-guidance-')))
  await mkdir(join(root,'src'));await writeFile(join(root,'src/check.mjs'),'source')
  const db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  const prepared=await prepareAgentTask(db,{requestId:'completion-guidance',dshSessionId:'session',cwd:root,task:'Implement src/check.mjs',
    profileHints:{taskType:'build',target:'src/check.mjs',expected:'observable output',constraints:null},capabilities:[],skillDiscoveryMode:'off',completionMode:'enforce'})
  const identity={runId:prepared.run.runId,sessionId:'session',repositoryRoot:root}
  initializeCodingWorkflow(db,{...identity,requestId:'completion-guidance',task:'Implement src/check.mjs'})
  const definition=structuredClone(CODING_MINIMUM_DEFINITION_EXAMPLE);definition.criteria[0]!.evidence='output'
  proposeCodingWorkflow(db,identity,'propose',1,definition)
  const agent={id:'agent',session:{id:'session'}},ctx=new cordis.Context();ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},getSectionOrder:()=>0});const fiber=ctx.plugin(tools.default);await fiber
  let approvals=0,sequence=0
  const dispose=mountTaskCompletion({tools:ctx.tools,on:ctx.on.bind(ctx)},{runtime:{withDatabase:async(fn:any)=>fn(db)} as any,
    resolve:execution=>execution.agent===agent?{...identity,agent}:undefined,approve:async()=>{approvals++;return true}})
  const call=(args:unknown)=>ctx.tools.execute({name:'task_completion',callId:`guidance-${++sequence}`,arguments:args,agent,signal:new AbortController().signal})
  const diagnostics=(result:any)=>{assert.equal(result.isError,true);assert.equal(result.value,undefined,'native failure never carries a successful value');const message=result.content.map((part:any)=>part.text??'').join('');assert.match(message,/TASK_COMPLETION_INPUT_INVALID/u);assert.doesNotMatch(message,/DO_NOT_ECHO/u);const recovery=JSON.parse(message.slice(message.indexOf('\nRecovery: ')+11));assert.equal(recovery.code,'TASK_COMPLETION_INPUT_INVALID');assert.equal(recovery.verified,false);return recovery}
  try{
    const status=await call({action:'status'});assert.equal(status.isError,false)
    const criterionId=status.value.criteria[0].criterionId
    const method={kind:'native_command',command:'node src/check.mjs',cwd:'.',assertion:'output_matches',expectedOutput:'42'}
    const missing=diagnostics(await call({action:'bind',criterionId,method:{...method,command:'node src/check.mjs --private=DO_NOT_ECHO'}}))
    assert.ok(missing.issues.some((issue:any)=>issue.field==='method.sourcePaths'))
    assert.equal(approvals,0,'missing required input must not prompt approval')
    assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_completion_bindings').get()!.n,0)
    const wrong=diagnostics(await call({action:'bind',criterionId,method:{...method,sourcePaths:['src/check.mjs'],assertion:'selected_tests_pass'}}))
    assert.ok(wrong.issues.some((issue:any)=>issue.field==='method.assertion'&&issue.expected==='output_matches'))
    const mode=diagnostics(await call({action:'bind',criterionId,method:{kind:'enno_verifier',verifierId:'not-approved',assertion:'output_matches'}}))
    assert.ok(mode.issues.length>0)
    const wrongMode=diagnostics(await call({action:'bind',criterionId:status.value.criteria[1].criterionId,method:{kind:'enno_verifier',verifierId:'not-approved',assertion:'selected_tests_pass'}}))
    assert.ok(wrongMode.issues.some((issue:any)=>issue.field==='method.kind'&&issue.expected==='native_command'))
    const bound=await call({action:'bind',criterionId,method:{...method,sourcePaths:['src/check.mjs']}})
    assert.equal(bound.isError,false);assert.equal(bound.value.approved,true)
    const after=await call({action:'status'});assert.equal(after.value.verified,false,'binding alone never verifies the criterion')
    assert.equal(after.value.criteria[0].state,'unknown')
    assert.ok(after.value.bindingGuide.native_command.requiredFields.includes('sourcePaths'))
    assert.equal(after.value.bindingGuide.criteria[0].requiredAssertion,'output_matches')
    assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_completion_executions').get()!.n,0)
  }finally{dispose();await fiber.dispose();db.close();await rm(root,{recursive:true,force:true})}
})
