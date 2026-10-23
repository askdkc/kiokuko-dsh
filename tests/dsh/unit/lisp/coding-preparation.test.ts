import assert from 'node:assert/strict'
import test from 'node:test'
import {LispCodingPreparation} from '../../../../src/dsh/lisp/coding-preparation.js'
import {LispCodingCancelled} from '../../../../src/dsh/coding-question.js'
import {codingIntent} from '../../../../src/dsh/coding-workflow/intent.js'
function observe(f:ReturnType<typeof fixture>,name:string,args:any,result:any){f.p.observed(f.agent,name,args,result,f.p.binding(f.agent))}
function fixture(){let root='/one',enabled=false,choices=0,activations=0;const agent={id:'agent',session:{id:'session'}};const input={agent,turn:1,task:'Implement src/parser.ts',taskType:'build' as const,signal:new AbortController().signal};const p=new LispCodingPreparation({identity:a=>({sessionId:(a as typeof agent).session.id,root}),enabled:()=>enabled,choose:async()=>{choices++;return{status:'answered',choice:'yes',answerRef:'human:choice'}},activate:async()=>{activations++;enabled=true}});return{p,agent,input,enabled:(v:boolean)=>{enabled=v},root:(v:string)=>{root=v},counts:()=>({choices,activations})}}
test('early choice is once per request, native reads stay available and ON alone is unverified',async()=>{const f=fixture();await Promise.all([f.p.prepare(f.input),f.p.prepare(f.input)]);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);assert.equal(f.counts().choices,1);assert.equal((f.p.status(f.agent)as any).verified,false);assert.equal(f.p.denial(f.agent,'read',{}),undefined);assert.match(f.p.denial(f.agent,'bash',{})!,/LISP_PROTOTYPE_REQUIRED/u)})
test('only a successful fresh prototype followed by its actual complete saved result unlocks implementation',async()=>{const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);observe(f,'lisp_eval',{prototype:false},{ok:true,operationId:'ordinary'});assert.match(f.p.denial(f.agent,'edit',{})!,/PROTOTYPE/u);observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'fresh'});for(const [args,result]of [[{resultOperationId:'wrong'},{ok:true,state:'SUCCEEDED',nextOffset:null}],[{resultOperationId:'fresh',section:'stdout'},{ok:true,state:'SUCCEEDED',nextOffset:null}],[{resultOperationId:'fresh',section:'result'},{ok:false}],[{resultOperationId:'fresh',section:'result'},{ok:true,state:'FAILED',nextOffset:null}],[{resultOperationId:'fresh',section:'result'},{ok:true,state:'SUCCEEDED',nextOffset:20}]]as any){observe(f,'lisp_inspect',args,result);assert.match(f.p.denial(f.agent,'write',{})!,/PROTOTYPE/u)}observe(f,'lisp_inspect',{resultOperationId:'fresh',section:'result'},{ok:true,state:'SUCCEEDED',offset:0,nextOffset:null});assert.equal(f.p.denial(f.agent,'write',{}),undefined);assert.equal((f.p.status(f.agent)as any).verified,true)})
test('two failures stop automatic prototype retries; explicit OFF releases the routine without claiming success',async()=>{const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);for(let i=0;i<2;i++)observe(f,'lisp_eval',{prototype:true},{ok:false});assert.match(f.p.denial(f.agent,'lisp_eval',{prototype:true})!,/two attempts failed/u);f.p.manual(f.agent,false);f.enabled(false);assert.equal(f.p.denial(f.agent,'bash',{}),undefined);assert.equal((f.p.status(f.agent)as any).verified,false)})
test('research, conversation, quotes, negation and plan-only requests do not activate or gate Lisp',async()=>{for(const task of ['Explain the parser','コードは変更しないで。原因を調査して','実装計画だけ作って','> Implement this','Should we implement it?']){const f=fixture();f.enabled(true);await f.p.prepare({...f.input,task});assert.equal(f.counts().choices,0);assert.equal(f.counts().activations,0);assert.equal(f.p.denial(f.agent,'bash',{}),undefined)}})
test('session/root/agent separation and new requests cannot reuse the previous prototype',async()=>{const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);assert.equal(f.p.choiceFor({...f.agent},f.input.task),undefined);f.root('/other');assert.equal(f.p.choiceFor(f.agent,f.input.task),undefined);assert.equal(f.p.denial(f.agent,'write',{}),undefined);f.root('/one');await f.p.prepare({...f.input,turn:2,task:'Implement src/other.ts'});assert.equal((f.p.status(f.agent)as any).verified,false);assert.equal(f.p.choiceFor(f.agent,f.input.task),undefined)})

test('cancelled choice cannot start effects and a session OFF does not revive the cancelled request',async()=>{
 const agent={id:'pending'},p=new LispCodingPreparation({identity:()=>({sessionId:'pending',root:'/one'}),enabled:()=>false,choose:async()=>({status:'cancelled',reason:'User cancelled'}),activate:async()=>{throw new Error('unanswered must not activate')}})
 await assert.rejects(p.prepare({agent,turn:1,task:'Implement src/parser.ts',taskType:'build',signal:new AbortController().signal}),LispCodingCancelled)
 assert.match(p.denial(agent,'bash',{})!,/LISP_REQUEST_CANCELLED/u);assert.equal(p.denial(agent,'read',{}),undefined);p.manual(agent,false);assert.match(p.denial(agent,'bash',{})!,/LISP_REQUEST_CANCELLED/u);assert.equal((p.status(agent)as any).verified,false)
})
test('successful retries do not consume the failure budget or erase existing evidence',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef)
 observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'one'})
 observe(f,'lisp_eval',{prototype:true},{replay:true,operationId:'one'})
 assert.equal((f.p.status(f.agent)as any).phase,'result_pending');assert.equal((f.p.status(f.agent)as any).failures,0)
 for(const id of ['two','three']){assert.equal(f.p.denial(f.agent,'lisp_eval',{prototype:true}),undefined);observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:id})}
 assert.equal((f.p.status(f.agent)as any).failures,0)
})

test('a new formal Goal choice cannot borrow an earlier task prototype or omit preparation',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'old'});observe(f,'lisp_inspect',{resultOperationId:'old',section:'result'},{ok:true,state:'SUCCEEDED',nextOffset:null});assert.equal((f.p.status(f.agent)as any).verified,true)
 const before=f.p.binding(f.agent);f.p.answered(f.agent,'Implement a different public entry','yes','human:new-scope')
 assert.equal((f.p.status(f.agent)as any).verified,false);assert.notEqual(f.p.binding(f.agent),before);assert.match(f.p.denial(f.agent,'write',{})!,/PROTOTYPE/u)
 const fresh=fixture();fresh.enabled(true);fresh.p.answered(fresh.agent,'Implement an admitted task','yes','human:admitted-choice');assert.match(fresh.p.denial(fresh.agent,'bash',{})!,/PROTOTYPE/u)
})


test('late prototype success, failure and inspection cannot cross a Goal or manual-route change',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);const old=f.p.binding(f.agent)
 f.p.answered(f.agent,'Implement next.ts','yes','human:next')
 for(const result of [{ok:true,operationId:'old'},{ok:false}])f.p.observed(f.agent,'lisp_eval',{prototype:true},result,old)
 assert.equal((f.p.status(f.agent)as any).phase,'prototype_required');assert.equal((f.p.status(f.agent)as any).attempts,0)
 observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'current'})
 f.p.observed(f.agent,'lisp_inspect',{resultOperationId:'current',section:'result'},{ok:true,state:'SUCCEEDED',nextOffset:null},old)
 assert.equal((f.p.status(f.agent)as any).verified,false)
 const beforeManual=f.p.binding(f.agent);f.p.manual(f.agent,true);assert.notEqual(f.p.binding(f.agent),beforeManual)
 f.p.observed(f.agent,'lisp_eval',{prototype:true},{ok:true,operationId:'before-manual'},beforeManual)
 assert.equal((f.p.status(f.agent)as any).phase,'prototype_required');assert.equal((f.p.status(f.agent)as any).attempts,0)
 observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'fresh'})
 observe(f,'lisp_inspect',{resultOperationId:'fresh',section:'result'},{ok:true,state:'SUCCEEDED',nextOffset:null})
 assert.equal((f.p.status(f.agent)as any).verified,true)
})


test('the same recorded manual answer preserves an already reviewed prototype when Goal next reuses it',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef);f.p.manual(f.agent,true,'human-command:one:enable')
 observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'fresh'})
 observe(f,'lisp_inspect',{resultOperationId:'fresh',section:'result'},{ok:true,state:'SUCCEEDED',nextOffset:null})
 const key=f.p.binding(f.agent);f.p.answered(f.agent,f.input.task,'yes','human-command:one:enable')
 assert.equal(f.p.binding(f.agent),key);assert.equal((f.p.status(f.agent)as any).verified,true)
})

test('a positive request-intent decision offers ordinary Lisp for wording the deterministic detector misses',async()=>{
 const f=fixture();f.enabled(true)
 const task='Okay okay, improve this source base. What do you do to make that happen?'
 assert.equal(codingIntent(task),false)
 await f.p.prepare({...f.input,task,requestIntent:{relation:'new',action:'change',changeScope:'implementation',source:'decision-provider',policyVersion:'request-intent-task-state-v3',providerSent:true,evidence:{} as any} as any})
 assert.equal((f.p.status(f.agent)as any).phase,'selected')
 assert.equal(f.p.denial(f.agent,'read',{}),undefined)
 assert.equal(f.p.denial(f.agent,'bash',{}),undefined)
})

test('an unresolved decision keeps the deterministic coding fallback and does not gate conversation',async()=>{
 const unresolved={relation:'unknown',action:'unknown',changeScope:'unknown',source:'unresolved',policyVersion:'request-intent-task-state-v3',providerSent:false,evidence:{} as any} as any
 const f=fixture();f.enabled(true)
 await f.p.prepare({...f.input,task:'Implement src/parser.ts',requestIntent:unresolved})
 assert.equal(f.p.denial(f.agent,'bash',{}),undefined)
 const g=fixture();g.enabled(true)
 await g.p.prepare({...g.input,task:'Explain the parser',requestIntent:unresolved})
 assert.equal(g.p.denial(g.agent,'bash',{}),undefined)
})

test('an explicitly selected manual session skips the early question without requiring a prototype',async()=>{
 const agent={id:'enabled-agent',session:{id:'enabled-session'}}
 let choices=0,activations=0
 const p=new LispCodingPreparation({
  identity:()=>({sessionId:'enabled-session',root:'/one'}),
  enabled:()=>true,
  selected:async()=>true,
  choose:async()=>{choices++;return{status:'answered',choice:'yes',answerRef:'enabled-session:test'}},
  activate:async()=>{activations++},
 })
 await p.prepare({agent,turn:1,task:'Implement src/parser.ts',taskType:'build',signal:new AbortController().signal})
 assert.equal(choices,0);assert.equal(activations,1)
 assert.equal((p.status(agent)as any).phase,'selected')
 assert.equal(p.denial(agent,'bash',{}),undefined)
})


test('an enabled runtime without a manual preference asks for each new task',async()=>{
 const agent={id:'task-agent'},answers:string[]=[]
 const p=new LispCodingPreparation({identity:()=>({sessionId:'session',root:'/one'}),enabled:()=>true,selected:async()=>false,
  choose:async input=>{answers.push(input.task);return {status:'answered',choice:answers.length===1?'yes':'no',answerRef:`human:${answers.length}`}},activate:async()=>{}})
 const signal=new AbortController().signal
 await p.prepare({agent,turn:1,task:'Implement first.ts',taskType:'build',signal})
 assert.equal(p.denial(agent,'write',{}),undefined)
 await p.prepare({agent,turn:2,task:'Implement second.ts',taskType:'build',signal})
 assert.deepEqual(answers,['Implement first.ts','Implement second.ts'])
 assert.equal(p.choiceFor(agent,'Implement second.ts')?.choice,'no')
 assert.equal(p.denial(agent,'write',{}),undefined)
})
