/** Real native registry + private confirmation receipt + native finite checker.
 * Semantic inference is deliberately always insufficient. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {rememberLispImplementation} from '../../../src/dsh/lisp-tool-identity.js'
import {pathToFileURL} from 'node:url'
import {DecisionService} from '../../../src/dsh/decisions/service.js'
import {TypedDecisionsConfig} from '../../../src/dsh/decisions/config.js'
import {assessRequestIntent} from '../../../src/dsh/decisions/intent-assessment.js'
import {createRequestIntentContext,requestIntentMessageRefs,requestIntentReferenceIds,unresolvedRequestIntent} from '../../../src/dsh/decisions/request-intent.js'
import {OnDemandIntake,TASK_PREPARE_TOOL} from '../../../src/dsh/on-demand-intake.js'
import {mountNativeTools,executeNativeTool} from '../helpers/native-tools.js'
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const load=(name:string)=>import(pathToFileURL(join(packages,'@deepseek-ai',name,'lib/index.js')).href)
const [cordis,tools]=await Promise.all([load('cordis'),load('dsh-tools')])
const signal=()=>new AbortController().signal
for(const scenario of ['confirm','empty','cancel','foreign-answer','changed-answer','changed-candidate','extra-source','restart','contradicted','native-deny','changed-scope','late-answer','unselected-assistant-proposal','selected-proposal','correction','correction-cancel','correction-empty','correction-foreign','correction-stale','during-question','ordinary-bash','new-request-after-cancel'] as const)test(`native user confirmation: ${scenario}`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pending-effect-')),path=join(dir,'README.md');await writeFile(path,'unchanged')
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const ctx=new cordis.Context(),fibers:any[]=[]
 ctx.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},getSectionOrder:()=>0})
 await mountNativeTools(ctx,tools,packages,fibers)
 const original={id:'original',role:'user',source:{kind:'user'},content:[{type:'text',text:'README.md を短い紹介文に修正してください。公開は禁止。'}]}
 let turn=1,messages:any[]=[original],context=createRequestIntentContext({task:original.content[0]!.text,messageRefs:requestIntentMessageRefs(messages,original.content[0]!.text)})!
 const events:any[]=[{type:'turn/start',seq:1,time:1,data:{turn}}]
 const session={id:'confirm-session',snapshotEvents:()=>events}
 const continuations:any[]=[]
 let queued:any,asks=0,admissions=0,effects=0,ready=false,calls=0
 const agent:any={id:'confirm-agent',session,followup:(m:any)=>{queued=m}}
 const service=new DecisionService(TypedDecisionsConfig.parse({provider:'typesafe'}),()=>({capabilities:{maxQuestions:64,maxChoices:255,maxBytes:262144},async evaluate(batch){return {provider:'typesafe',requestedModel:'fixture',policyVersion:'fixture',answers:batch.questions.map(q=>scenario==='contradicted'&&turn===2?{id:q.id,status:'selected' as const,choiceId:'contradicted'}:{id:q.id,status:'abstained' as const,reason:'insufficient' as const})}}}))
 const assessments:any[]=[]
 const options:ConstructorParameters<typeof OnDemandIntake>[0]={prepareNativeCoding:async(_input,_task,_context,from)=>{continuations.push(from)},validate:async()=>{},existing:async()=>false,classify:async()=>({deferInference:true}),requestContext:async()=>context,
  interpret:async()=>({context,decision:unresolvedRequestIntent(context,'fixture')}),
  assess:async(input:any,source:any,candidate:any,_attempt?:number,userConfirmed?:boolean)=>{const result=await assessRequestIntent(service,`turn-${turn}`,source,candidate,input.signal,{userConfirmed:userConfirmed===true});assessments.push({userConfirmed,result});return result},
  prepare:async()=>{admissions++;ready=true;return true},ready:()=>ready,
  questions:{async ask(request:any){asks++;assert.match(request.questions[0].question,/README.md/);assert.match(request.questions[0].question,/公開は禁止/)
   if(scenario.startsWith('correction')){
    if(asks===1)return {answers:[{id:request.questions[0].id,selected:['対象または操作を訂正する']}]}
    assert.equal(request.questions[0].options,undefined,'correction asks for concrete text, not another approval')
    if(scenario==='correction-cancel')throw Object.assign(Error('cancel'),{code:'ASK_CANCELLED'})
    if(scenario==='correction-stale')context=createRequestIntentContext({task:'Other request',messageRefs:[{id:'other-user',digest:'d'.repeat(64)}]})!
    return {answers:[{id:scenario==='correction-foreign'?'wrong-question':request.questions[0].id,selected:[],custom:scenario==='correction-empty'?'':'README.md の冒頭だけを短くしてください。公開は禁止。'}]}
   }
   if(scenario==='late-answer')context=createRequestIntentContext({task:'Edit another target',messageRefs:[{id:'replacement',digest:'b'.repeat(64)}]})!
   if(scenario==='during-question'){assert.equal((await execute('bash')).isError,true);assert.equal(await readFile(path,'utf8'),'unchanged')}
   if(scenario==='cancel'||scenario==='new-request-after-cancel')throw Object.assign(Error('cancel'),{code:'ASK_CANCELLED'})
   return {answers:[{id:scenario==='foreign-answer'?'foreign':request.questions[0].id,selected:scenario==='empty'?[]:[request.questions[0].options[0].label]}]}}}
 }
 let intake=new OnDemandIntake(options);intake.mount(ctx,ctx.tools)
 const bash=ctx.tools.register({name:'bash',parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:async()=>{await writeFile(path,'bash changed');return true}})
 const read=ctx.tools.register({name:'read',parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:()=>readFile(path,'utf8')})
 const lispStatusExecute=()=>({state:'available'}),lispEffectExecute=async()=>{await writeFile(path,'lisp changed');return true}
 rememberLispImplementation(lispStatusExecute);rememberLispImplementation(lispEffectExecute)
 const lispStatus=ctx.tools.register({name:'lisp_status',parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:lispStatusExecute})
 const lispEffect=ctx.tools.register({name:'lisp_eval',parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:lispEffectExecute})
 t.after(()=>{bash();read();lispStatus();lispEffect()})
 const release=ctx.tools.register({name:'effect_probe',parameters:{type:'object'},output:{schema:{},render:()=>[]},execute:()=>++effects})
 t.after(async()=>{await intake.dispose();release();for(const fiber of fibers.reverse())await fiber.dispose()})
 const execute=(name:string,args:any={})=>executeNativeTool(ctx,packages,{callId:`call-${++calls}`,name,arguments:args,agent,signal:signal()})
 const submit=()=>({requestIntent:{relation:'new',action:scenario==='changed-candidate'&&turn===2?'verify':'change',changeScope:'document',evidenceRefs:requestIntentReferenceIds(context).filter(ref=>scenario==='selected-proposal'||!ref.startsWith('proposal:'))}})
 await intake.capture({agent,turn,step:0,messages,signal:signal()})
 if(scenario==='ordinary-bash'){assert.equal((await execute('bash')).isError,false);assert.equal(await readFile(path,'utf8'),'bash changed');assert.equal(asks,0);assert.equal(admissions,0);return}
 const first=await execute(TASK_PREPARE_TOOL,submit());assert.equal((first.value as any).prepared,false);assert.equal(admissions,0);assert.equal(asks,scenario.startsWith('correction')?2:1)
 assert.equal((await execute('bash')).isError,true,'pending/queued/cancelled clarification must fence native Bash')
 assert.equal((await execute('lisp_eval')).isError,true,'effect-capable Lisp follows the same pending gate')
 assert.equal((await execute('read')).isError,false);assert.equal((await execute('lisp_status')).isError,false)
 assert.equal(await readFile(path,'utf8'),'unchanged')
 if(scenario==='new-request-after-cancel'){
  events.push({type:'turn/end',seq:2,time:2,data:{turn,reason:{kind:'completed'}}});intake.finish(session,turn);turn=2;events.push({type:'turn/start',seq:3,time:3,data:{turn}})
  messages=[{...original,id:'new-human',content:[{type:'text',text:'Run an unrelated bounded command.'}]}];context=createRequestIntentContext({task:messages[0].content[0].text,messageRefs:requestIntentMessageRefs(messages,messages[0].content[0].text)})!
  await intake.capture({agent,turn,step:0,messages,signal:signal()});assert.equal((await execute('bash')).isError,false);assert.equal(await readFile(path,'utf8'),'bash changed');assert.equal(admissions,0);return
 }
 if(scenario.startsWith('correction')){
  if(scenario!=='correction'){assert.equal(queued,undefined);assert.equal(effects,0);return}
  assert.equal((first.value as any).status,'clarification_answer_queued');assert.match(queued.content[0].text,/README.md の冒頭だけ/)
  events.push({type:'turn/end',seq:2,time:2,data:{turn,reason:{kind:'completed'}}});intake.finish(session,turn)
  turn=2;events.push({type:'turn/start',seq:3,time:3,data:{turn}});messages=[queued]
  const task=queued.content[0].text;context=createRequestIntentContext({task,messageRefs:requestIntentMessageRefs(messages,task)})!
  await intake.capture({agent,turn,step:0,messages,signal:signal()})
  assert.equal(continuations.at(-1),undefined,'a correction is not an affirmative receipt')
  assert.match(context.task,/README.md の冒頭だけ/);assert.equal(admissions,0);assert.equal(effects,0);return
 }
 if(['empty','cancel','foreign-answer','late-answer'].includes(scenario)){assert.equal(queued,undefined);assert.equal((await execute('effect_probe')).isError,true);assert.equal(effects,0);return}
 assert.equal((first.value as any).status,'clarification_answer_queued');assert.ok(queued)
 events.push({type:'turn/end',seq:2,time:2,data:{turn,reason:{kind:'completed'}}});intake.finish(session,turn)
 if(scenario==='restart'){await intake.dispose();intake=new OnDemandIntake(options);intake.mount(ctx,ctx.tools)}
 if(scenario==='changed-answer')queued.content[0].text+='\nInstead edit secrets.txt.'
 messages=[queued]
 if(scenario==='extra-source')messages.push({id:'new-target',role:'user',source:{kind:'user'},content:[{type:'text',text:'Also modify secrets.txt.'}]})
 turn=2;events.push({type:'turn/start',seq:3,time:3,data:{turn}})
 const task=messages.map(m=>m.content[0].text).join('\n');context=createRequestIntentContext({task,messageRefs:requestIntentMessageRefs(messages,task)})!
 if(scenario==='unselected-assistant-proposal'||scenario==='selected-proposal')context={...context,proposals:[{id:'assistant-summary',revision:null,digest:'c'.repeat(64),text:'Offline scripted verification finished.'}]}
 if(scenario==='changed-scope')context={...context,activeGoal:{runId:'new-scope',target:'other.md',outOfScope:[],constraints:[]}}
 await intake.capture({agent,turn,step:0,messages,signal:signal()})
 if(scenario==='native-deny')t.after(ctx.tools.guard((e:any)=>e.name==='effect_probe'?'native denied':undefined))
 const second=await execute(TASK_PREPARE_TOOL,submit())
 const allowed=scenario==='confirm'||scenario==='native-deny'||scenario==='unselected-assistant-proposal'||scenario==='during-question'
 assert.equal((second.value as any).prepared,allowed,JSON.stringify(second.value));assert.equal(admissions,allowed?1:0)
 if(allowed){assert.deepEqual(continuations.at(-1),{turn:1,task:original.content[0]!.text});assert.equal(asks,1);assert.equal(assessments.at(-1).result.outcome,'user_confirmed');assert.equal(assessments.at(-1).result.semantic,'insufficient')}
 if(allowed){assert.equal((await execute('bash')).isError,false);assert.equal(await readFile(path,'utf8'),'bash changed');assert.equal((await execute('lisp_eval')).isError,false);assert.equal(await readFile(path,'utf8'),'lisp changed');assert.equal(asks,1,'no per-tool repeat clarification after preparation')}
 else {assert.equal((await execute('bash')).isError,true);assert.equal(await readFile(path,'utf8'),'unchanged')}
 assert.equal((await execute('effect_probe')).isError,!(allowed&&scenario!=='native-deny'));assert.equal(effects,allowed&&scenario!=='native-deny'?1:0)
})
