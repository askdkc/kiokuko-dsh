import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {nativeSkillFixture} from '../helpers/skill-native.js'
import {nativeToolResults} from '../helpers/native-mock.js'
import {codingPrelude,toolValue} from '../helpers/coding-script.js'
import {isolateSkillHome} from '../helpers/skill-home.js'
import {openConnection} from '../../../src/db/connection.js'
import {recordEntry} from '../../../src/memory/entries.js'
import {correctionDecisionFixture} from '../helpers/correction-decisions.js'
isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const packageRoot=process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const extra={lisp:{enabled:false},answerReview:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}}
for(const explicit of [false,true])for(const dropInput of [false,true])test(`native correction handoff and scoped version-gate rejection (${explicit?'adapter':'public'}, drop=${dropInput})`,{timeout:90000},async()=>{
  let confirmations=0
  const body='Do not reject Rust compiler compatibility only because a version differs. Verify actual compiler capabilities and native acceptance.'
  const semantic=await correctionDecisionFixture(body)
  const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),explicit,mode:'compiled',extra:{...extra,typedDecisions:semantic.configuration},nativeAnswer:async request=>{
    const q=request.questions[0]
    if(q.id.startsWith('correction-')){confirmations++;assert.match(q.detail,/scripts\/check.mjs/);return {answers:[{id:q.id,selected:['見直す']}]}}
    return {answers:[{id:q.id,selected:['使わない']}]}
  }})
  const db=openConnection(join(f.dir,explicit?'state.sqlite3':'kiokuko-dsh.sqlite3'))
  const releaseDrop=dropInput?(f.ctx.on as any)('agent/pre-step',async(_:unknown,next:()=>Promise<any>)=>{
    const result=await next()
    return result?.kind==='enter'?{...result,messages:result.messages.filter((message:any)=>!message.source?.sections?.some((s:any)=>s.name.startsWith('memory:memory:')))}:result
  },{prepend:true}):()=>{}
  try {
    await mkdir(join(f.dir,'scripts'))
    const workspace=db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{workspace:string}>()!.workspace
    const memory=recordEntry(db,{workspace,kind:'lesson',title:'Rust compiler compatibility',body,scope:{visibility:'project'},provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    f.responses.push(f.mock.textResponse('Different compiler versions can be checked against the actual required capabilities.'))
    await f.turn('Explain Rust compiler compatibility. Do not change files.')
    assert.equal(confirmations,0,'ordinary explanation must not ask a correction question')
    const bad='import assert from "node:assert/strict"; assert.match(compiler.stdout, /^rustc 1\\.85\\.0 /)\n'
    const result=(request:any,id:string)=>nativeToolResults(request.messages).find((value:any)=>value.toolCallId===id)
    f.responses.push(...codingPrelude(f.mock,'correction'),(request:any)=>{
      const projected=JSON.stringify(request.messages.filter((m:any)=>m.source?.sections?.some((s:any)=>s.name===`memory:memory:${memory.id}`)))
      if(dropInput)assert.equal(projected,'[]','fault injection removes the actual input fragment')
      else assert.match(projected,/compiler capabilities/,'the actual native request must contain the correction')
      return f.mock.toolCallResponse('wrong-version-write','kioku_write',{path:'scripts/check.mjs',content:bad})
    },(request:any)=>{
      assert.equal(result(request,'wrong-version-write')?.isError,true)
      return f.mock.toolCallResponse('same-wrong-write','kioku_write',{path:'scripts/check.mjs',content:bad})
    },(request:any)=>{
      assert.equal(result(request,'same-wrong-write')?.isError,true)
      assert.equal(confirmations,1,'repeating the same rejected decision must not reopen the question')
      return f.mock.toolCallResponse('capability-write','kioku_write',{path:'scripts/check.mjs',content:'export const nativeAcceptance = true\n'})
    },(request:any)=>{
      assert.equal(result(request,'capability-write')?.isError,false)
      assert.ok(request.tools.some((tool:any)=>tool.name==='correction_check'),'the check must be exposed to the actual model')
      return f.mock.toolCallResponse('self-report','correction_check',{decision:{kind:'compatibility',target:'scripts/check.mjs',basis:'capability',requiredVersion:'1.85.0',observedVersion:'1.99.1'}})
    },(request:any)=>{
      const checked=toolValue(request,'self-report')
      assert.equal(checked.delivery,dropInput?'not_delivered':'delivered');assert.equal(checked.verification,'unverified','model self-report is not application evidence')
      return f.mock.textResponse('The capability-based implementation is written; final verification remains pending.')
    })
    await f.turn('Fix Rust compiler compatibility in scripts/check.mjs. 通常実行で。')
    assert.equal(await readFile(join(f.dir,'scripts/check.mjs'),'utf8'),'export const nativeAcceptance = true\n')
    assert.equal(confirmations,1)
    const events=db.prepare("SELECT payload_json FROM ledger_events WHERE event_type='correction.recorded'").all<{payload_json:string}>().map(row=>JSON.parse(row.payload_json))
    assert.ok(events.some(e=>e.delivery===(dropInput?'not_delivered':'delivered')&&e.sources.some((s:any)=>s.entryId===memory.id&&s.revision===memory.revision)))
    if(!dropInput)assert.ok(events.some(e=>e.inputDigest))
    assert.ok(events.some(e=>e.state===(dropInput?'handoff_missing':'contradiction')&&e.allowed===false))
    assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
    assert.equal(semantic.calls(),1,'unchanged correction is classified once across the conversation and execution turns')
  } finally {releaseDrop();db.close();await f.close();await semantic.close()}
})

for(const explicit of [false,true])for(const state of ['shadow','reference','uncertain','unavailable'] as const)test(`native ${state} never invokes special correction handling (${explicit?'adapter':'public'})`,{timeout:90000},async()=>{
  const body=state==='reference'?'Record compiler version 1.99 as an environment fact.':'A synthetic compiler compatibility correction.'
  const semantic=await correctionDecisionFixture(body,{choice:state==='shadow'?'capability_compatibility':state,mode:state==='shadow'?'shadow':'auto'})
  let confirmations=0
  const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),explicit,mode:'compiled',extra:{...extra,typedDecisions:semantic.configuration},nativeAnswer:async request=>{
    const q=request.questions[0];if(q.id.startsWith('correction-'))confirmations++
    return {answers:[{id:q.id,selected:['使わない']}]}
  }})
  const db=openConnection(join(f.dir,explicit?'state.sqlite3':'kiokuko-dsh.sqlite3'))
  try{
    await mkdir(join(f.dir,'scripts'))
    const workspace=db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{workspace:string}>()!.workspace
    recordEntry(db,{workspace,kind:'lesson',title:'Rust compiler compatibility',body,scope:{visibility:'project'},provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    const content='assert.match(compiler.stdout, /^rustc 1\\.85\\.0 /)\n'
    f.responses.push(...codingPrelude(f.mock,'non-special'),f.mock.toolCallResponse('write','kioku_write',{path:'scripts/check.mjs',content}),
      (request:any)=>{assert.equal(nativeToolResults(request.messages).find((x:any)=>x.toolCallId==='write')?.isError,false);return f.mock.toolCallResponse('check','correction_check',{decision:{kind:'compatibility',target:'scripts/check.mjs',basis:'version_only',requiredVersion:'1.85.0',observedVersion:'1.99.1'}})},
      (request:any)=>{const checked=toolValue(request,'check');assert.equal(checked.state,'unverified');assert.equal(checked.verification,'unverified');return f.mock.textResponse('No special correction rule was activated.')})
    await f.turn('Fix Rust compiler compatibility in scripts/check.mjs. 通常実行で。')
    assert.equal(confirmations,0);assert.equal(await readFile(join(f.dir,'scripts/check.mjs'),'utf8'),content);assert.equal(semantic.calls(),1)
    const observed=JSON.parse(String(db.prepare('SELECT result_json FROM correction_classifications LIMIT 1').get()?.result_json))
    assert.equal(observed.state,{shadow:'classified',reference:'classified',uncertain:'abstained',unavailable:'unavailable'}[state])
  }finally{db.close();await f.close();await semantic.close()}
})
