import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {DecisionService} from '../../../src/dsh/decisions/service.js'
import {TypedDecisionsConfig} from '../../../src/dsh/decisions/config.js'
import {nativeSkillFixture} from '../helpers/skill-native.js'
import {nativeToolResults} from '../helpers/native-mock.js'
import {codingPrelude, toolValue} from '../helpers/coding-script.js'
import {isolateSkillHome} from '../helpers/skill-home.js'
isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const packageRoot=process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const extra={lisp:{enabled:true,executionMode:'development',sbclPath:process.env.KIOKUKO_LISP_SBCL,startupTimeoutMs:60000},typedDecisions:{mode:'off'},answerReview:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}}
const result=(q:any,id:string)=>{const r=nativeToolResults(q.messages).find((r:any)=>r.toolCallId===id);assert.ok(r,id);return r}
for(const explicit of [false,true])test(`ordinary implementation offers Lisp before the first model request (${explicit?'adapter':'public'})`,{timeout:120000},async()=>{
 let asked=0
 const f=await nativeSkillFixture({packages,...(packageRoot ? {packageRoot} : {}),explicit,mode:'compiled',extra,nativeAnswer:async q=>{if(q.questions[0].id.startsWith('lisp-early-')){asked++;assert.equal(f.model.requests.length,0);return{answers:[{id:q.questions[0].id,selected:['使わない']}]}}throw new Error('unexpected question') }})
 try{f.responses.push(f.mock.textResponse('Prepared ordinary coding.'));await f.turn('src/parser.ts の関数を実装して。外部公開しないで。');assert.equal(asked,1)
 f.responses.push(f.mock.textResponse('Continuing.'));await f.turn('この作業を続行してください');assert.equal(asked,1)
 f.responses.push(f.mock.textResponse('Research only.'));await f.turn('コードは変更しないで。原因を調査して説明して。');assert.equal(asked,1)
 }finally{await f.close()}
})
test('a configured request-intent decision arms the early Lisp offer for conversational implementation wording',{timeout:120000},async()=>{
 let asked=0,requestIntentBatches=0
 const decisions=new DecisionService(TypedDecisionsConfig.parse({provider:'typesafe'}),()=> ({
  capabilities:{maxQuestions:256,maxChoices:256,maxBytes:262144},
  async evaluate(batch:any){
   if(batch.purpose==='request-intent'){
    requestIntentBatches++
    assert.match((batch.state as any).currentUserMessage,/improve this/u)
    return {provider:'fixture',requestedModel:'fixture',policyVersion:'request-intent-task-state-v3',
     answers:batch.questions.map((q:any)=>q.id==='request-relation'?{id:q.id,status:'selected',choiceId:'new'}
      :q.id==='request-action'?{id:q.id,status:'selected',choiceId:'change'}
      :q.id==='request-change-scope'?{id:q.id,status:'selected',choiceId:'implementation'}
      :{id:q.id,status:'abstained',reason:'insufficient'})}
   }
   return {provider:'fixture',requestedModel:'fixture',policyVersion:'fixture',answers:batch.questions.map((q:any)=>({id:q.id,status:'abstained',reason:'insufficient'}))}
  }
 }) as any)
 const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),explicit:true,mode:'compiled',decisions,extra:{...extra,typedDecisions:{provider:'typesafe'}},nativeAnswer:async q=>{if(q.questions[0].id.startsWith('lisp-early-')){asked++;assert.equal(f.model.requests.length,0);return{answers:[{id:q.questions[0].id,selected:['使わない']}]}}throw new Error('unexpected question')}})
 try{f.responses.push(f.mock.textResponse('Prepared ordinary coding.'));await f.turn('Okay okay, improve this source base. AI Memory and coding skills are efficient and handle what user intention should be. What do you do to make that happen with this source bases?');assert.equal(asked,1);assert.equal(requestIntentBatches,1)}finally{await f.close()}
})
test('manual ON requires a real prototype and its saved result before native implementation; OFF preserves ordinary tools',{timeout:120000},async()=>{
 let asked=0;const f=await nativeSkillFixture({packages,...(packageRoot ? {packageRoot} : {}),mode:'compiled',extra,nativeAnswer:async q=>{asked++;return{answers:[{id:q.questions[0].id,selected:['使わない']}]}}}),fibers:any[]=[]
 const command=async(action:string)=>{const r=(await f.ctx.commands.execute(f.agent,`/kioku-lisp ${action}`,[],new AbortController().signal)).result;assert.equal(r.kind,'success',r.text);return r}
 const js='require("fs").writeFileSync("implemented.txt","42")',shell=`${process.execPath} -e '${js}'`
 try{
 for(const name of ['dsh-subprocess-local','dsh-bash-local','dsh-shell-env','dsh-tool-bash']){const p=await import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href);fibers.push(await f.ctx.plugin(p.default??p,name==='dsh-bash-local'?{cwd:f.dir}:name==='dsh-shell-env'?{dshHome:f.dir}:{}))}
 await command('enable')
 let saved:string=''
 f.responses.push(f.mock.toolCallResponse('premature','bash',{command:shell,description:'Implement requested fixture'}),(q:any)=>{assert.match(JSON.stringify(result(q,'premature')),/LISP_PROTOTYPE_REQUIRED/u);return f.mock.toolCallResponse('prototype','lisp_eval',{operationId:'prototype-case',prototype:true,code:'(progn (assert (= (+ 40 2) 42)) (assert (/= (+ 40 1) 42)) (+ 40 2))'})},(q:any)=>{const r=result(q,'prototype');assert.equal(r.isError,false,JSON.stringify(r));const body=r.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');saved=JSON.parse(body).operationId;assert.ok(saved);return f.mock.toolCallResponse('still-premature','bash',{command:shell,description:'Must inspect first'})},(q:any)=>{assert.match(JSON.stringify(result(q,'still-premature')),/LISP_PROTOTYPE_REQUIRED/u);return f.mock.toolCallResponse('inspect-prototype','lisp_inspect',{operationId:'read-prototype',resultOperationId:saved,section:'result'})},(q:any)=>{assert.equal(result(q,'inspect-prototype').isError,false);return f.mock.toolCallResponse('implementation','bash',{command:shell,description:'Implement after observed prototype'})},(q:any)=>{assert.equal(result(q,'implementation').isError,false,JSON.stringify(result(q,'implementation')));return f.mock.textResponse('Prototype inspected and implementation ran; final tests remain separate.')})
 await f.turn('implemented.txt を作成して、42 を保存して。');assert.equal(await readFile(join(f.dir,'implemented.txt'),'utf8'),'42');assert.equal(asked,0)
 const status=JSON.parse((await command('status --json')).text);assert.equal(status.codingPreparation.verified,true)
 await command('disable');f.responses.push((q:any)=>{assert.ok(!q.tools.some((t:any)=>t.name==='lisp_eval'));return f.mock.textResponse('Lisp disabled.')});await f.turn('設定状態を説明して。');assert.equal(asked,0)
 }finally{for(const fiber of fibers.reverse())await fiber.dispose();await f.close()}
})


test('failed prototypes stay unverified, stop after two attempts, and explicit OFF restores native coding',{timeout:120000},async()=>{
 const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),mode:'compiled',extra,nativeAnswer:async()=>{throw new Error('manual ON must not ask again')}})
 try{
 const enabled=(await f.ctx.commands.execute(f.agent,'/kioku-lisp enable',[],new AbortController().signal)).result;assert.equal(enabled.kind,'success',enabled.text)
 f.responses.push(f.mock.toolCallResponse('failed-one','lisp_eval',{operationId:'failed-one',prototype:true,code:'(error "PROTOTYPE_FAILURE_ONE")'}),(q:any)=>{assert.match(JSON.stringify(result(q,'failed-one')),/PROTOTYPE_FAILURE_ONE/u);return f.mock.toolCallResponse('failed-two','lisp_eval',{operationId:'failed-two',prototype:true,code:'(error "PROTOTYPE_FAILURE_TWO")'})},(q:any)=>{assert.match(JSON.stringify(result(q,'failed-two')),/PROTOTYPE_FAILURE_TWO/u);return f.mock.toolCallResponse('budget','lisp_eval',{operationId:'must-not-execute',prototype:true,code:'42'})},(q:any)=>{assert.match(JSON.stringify(result(q,'budget')),/two attempts failed/u);return f.mock.textResponse('The prototype failed; automatic retries stopped. No implementation or verification succeeded.')})
 await f.turn('src/parser.ts の関数を修正して。')
 const status=JSON.parse((await f.ctx.commands.execute(f.agent,'/kioku-lisp status --json',[],new AbortController().signal)).result.text);assert.equal(status.codingPreparation.phase,'failed');assert.equal(status.codingPreparation.verified,false);assert.equal(status.codingPreparation.attempts,2)
 const off=(await f.ctx.commands.execute(f.agent,'/kioku-lisp disable',[],new AbortController().signal)).result;assert.equal(off.kind,'success',off.text)
 f.responses.push((q:any)=>{assert.ok(!q.tools.some((t:any)=>t.name==='lisp_eval'));return f.mock.textResponse('Explicit OFF is retained for this request.')});await f.turn('この作業を続行してください')
 }finally{await f.close()}
})

test('manual ON survives same-session reload and a new coding request starts unverified without another question',{timeout:120000},async()=>{
 let questions=0
 const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),mode:'compiled',extra,nativeAnswer:async()=>{questions++;throw new Error('manual ON must remain selected after reload')}})
 try{
 const enabled=(await f.ctx.commands.execute(f.agent,'/kioku-lisp enable',[],new AbortController().signal)).result;assert.equal(enabled.kind,'success',enabled.text)
 await f.reload('compiled')
 f.responses.push((q:any)=>{assert.ok(q.tools.some((t:any)=>t.name==='lisp_eval'));assert.match(JSON.stringify(q),/prototype_required/u);return f.mock.textResponse('The prototype has not run; implementation remains pending.')})
 await f.turn('src/new.ts に関数を実装して。')
 const status=JSON.parse((await f.ctx.commands.execute(f.agent,'/kioku-lisp status --json',[],new AbortController().signal)).result.text)
 assert.equal(questions,0);assert.equal(status.codingPreparation.verified,false);assert.equal(status.codingPreparation.phase,'prototype_required');assert.equal(status.codingPreparation.attempts,0)
 assert.match((await f.ctx.commands.execute(f.agent,'/kioku-lisp status',[],new AbortController().signal)).result.text,/試作待ち（未検証）/u)
 }finally{await f.close()}
})

for (const reload of [false, true]) test(`manual ON supplies a formal Goal choice without an early matching request (${reload ? 'reload' : 'current'})`, {timeout:120000}, async () => {
 let questions = 0
 const f = await nativeSkillFixture({packages,...(packageRoot ? {packageRoot} : {}),mode:'compiled',extra,nativeAnswer:async q=>{
   if (q.questions[0].id.startsWith('coding-lisp-') || q.questions[0].id.startsWith('lisp-early-')) questions++
   return {answers:[{id:q.questions[0].id,selected:['通常実行']}]}
 }})
 try {
   const enabled = (await f.ctx.commands.execute(f.agent,'/kioku-lisp enable',[],new AbortController().signal)).result
   assert.equal(enabled.kind,'success',enabled.text)
   if (reload) await f.reload('compiled')
   assert.equal(await f.agent.ctx.get('kiokukoLispCoding').manualSelected(f.agent), true)
   f.responses.push(...codingPrelude(f.mock,'manual'), (request:any) => {
     const workflow = toolValue(request,'manual-propose')
     assert.equal(workflow.choice.state,'yes')
     assert.match(workflow.choice.answerRef,/^manual-session:/u)
     assert.equal(workflow.assessment.verified,false)
     return f.mock.textResponse('Goal prepared; the prototype and verification remain pending.')
   })
   // Structured interpretation admits the implementation; the opaque text has
   // no lexical early-preparation choice for the formal workflow to reuse.
   await f.turn('A/B/C をまとめて入れて。通常実行で。')
   assert.equal(questions,0)
   const status = JSON.parse((await f.ctx.commands.execute(f.agent,'/kioku-lisp status --json',[],new AbortController().signal)).result.text)
   assert.equal(status.codingPreparation.phase,'prototype_required')
   assert.equal(status.codingPreparation.verified,false)
 } finally {await f.close()}
})
