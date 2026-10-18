import test from 'node:test'
import assert from 'node:assert/strict'
const {commandDiagnostic,admissionDiagnostic,processDiagnostic,observeProcess,requireCommandSuccess,requireAdmissionRounds}=await import(process.env.DIAGNOSTICS_MODULE ?? new URL('./verification-diagnostics.mjs', import.meta.url).href)
const secret='DUMMY_PRIVATE_VALUE_9841'
const mixed=`Authorization: Bearer ${secret}\n{"password":"${secret}"} https://user:${secret}@fixture.invalid/?token=${secret}\n-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\nunlabelled ${secret}`
const clean=x=>assert.ok(!JSON.stringify(x).includes(secret),'secret or raw text must not be recorded')
test('safe diagnostic: command preserves failure location, supplied code and safe reason; success and absent code stay distinct',()=>{
 const x=commandDiagnostic({point:'skill-workflow-enable',command:'enable',result:{kind:'error',code:'COMPILE_FAILED',text:'sandbox-exec: sandbox_apply: Operation not permitted\n'+mixed}})
 assert.equal(x.point,'skill-workflow-enable');assert.equal(x.kind,'error');assert.equal(x.code,'COMPILE_FAILED');assert.ok(x.reason.categories.includes('sandbox_denied'));clean(x)
 assert.equal(commandDiagnostic({point:'skill-enable',result:{kind:'success'}}).kind,'success')
 assert.equal(commandDiagnostic({point:'skill-enable',result:{kind:'error',text:mixed}}).code,null)
 const unknown=commandDiagnostic({point:secret,result:{kind:secret,error:{code:secret,text:mixed}}});assert.equal(unknown.code,null);assert.equal(unknown.codeProvided,true);clean(unknown)
})
test('safe diagnostic: admission prefers the latest session tool result over the last request and records the observed stop reason',()=>{
 const x=admissionDiagnostic({point:'skill-admission',requests:[{messages:[{role:'tool',content:[{type:'text',text:'stale'}]}]}],expectedRounds:10,pendingResponses:6,status:'idle',events:[
 {type:'tool/result',data:{message:{role:'tool',isError:true,toolCallId:secret,content:[{type:'text',text:JSON.stringify({ok:false,code:'COMPILE_FAILED',message:'sandbox_apply: Operation not permitted',password:secret,arguments:mixed})}]}}},
 {type:'turn/end',data:{reason:{kind:'interrupted',message:mixed}}}]})
 assert.equal(x.observedRounds,1);assert.equal(x.expectedRounds,10);assert.equal(x.pendingResponses,6);assert.equal(x.stopReason,'interrupted');assert.equal(x.lastToolResult.source,'session');assert.equal(x.lastToolResult.isError,true);assert.equal(x.lastToolResult.code,'COMPILE_FAILED');clean(x)
})
test('safe diagnostic: admission supports legacy nested results; missing stop/result is explicitly unknown, not guessed',()=>{
 const x=admissionDiagnostic({point:'skill-admission',requests:[{messages:[{role:'user',content:[{type:'tool-result',isError:false,content:[{type:'text',text:'{"ok":true,"kind":"success"}'}]}]}]}],events:[],expectedRounds:10,status:'idle'})
 assert.equal(x.lastToolResult.source,'request');assert.equal(x.lastToolResult.kind,'success');assert.equal(x.stopReason,'not-recorded')
 const empty=admissionDiagnostic({point:'skill-admission',requests:[],events:[],expectedRounds:10});assert.equal(empty.lastToolResult,null);assert.equal(empty.stopReason,'not-recorded')
})
test('safe diagnostic: process success, exit error and spawn error retain bounded safe metadata without stdout, argv or environment',()=>{
 const success=processDiagnostic({point:'pack-install',success:true,stderr:mixed,elapsedMs:8,timeoutMs:180000,timedOut:false});assert.equal(success.exitCode,0);assert.equal(success.timedOut,false);clean(success)
 const failure=processDiagnostic({point:'pack-install',error:{code:42,signal:null,stderr:'npm error code ENOTCACHED\n'+mixed,stdout:mixed,cmd:mixed},elapsedMs:17,timeoutMs:180000,timedOut:false})
 assert.equal(failure.exitCode,42);assert.equal(failure.signal,null);assert.equal(failure.elapsedMs,17);assert.ok(failure.stderrSummary.codes.includes('ENOTCACHED'));assert.equal(failure.timedOut,false);clean(failure);assert.ok(!('stdout' in failure)&&!('cmd' in failure))
 const spawn=processDiagnostic({point:'pack-install',error:{code:'ENOENT',message:mixed},elapsedMs:0,timedOut:false});assert.equal(spawn.code,'ENOENT');assert.equal(spawn.exitCode,null);clean(spawn)
 assert.equal(processDiagnostic({point:'pack-install',error:{signal:'SIGSEGV'},timedOut:false}).signal,'SIGSEGV')
})
test('safe diagnostic: elapsed deadline or a termination signal alone never invents an observed timeout',()=>{
 const x=processDiagnostic({point:'pack-install',error:{code:1,signal:'SIGTERM',killed:true,stderr:mixed},elapsedMs:190000,timeoutMs:180000,timedOut:false});assert.equal(x.timedOut,false);assert.equal(x.signal,'SIGTERM');clean(x)
})
test('safe diagnostic: formatter omits unknown free text, malformed payloads, deep data and accessors',()=>{
 let reads=0;const result={kind:'error',get text(){reads++;return secret},code:secret}
 const x=commandDiagnostic({point:'skill-enable',result});assert.equal(reads,0);clean(x)
 const y=admissionDiagnostic({point:'skill-admission',requests:[],events:[{type:'tool/result',data:{message:{role:'tool',content:[{type:'text',text:'{broken '+mixed+'x'.repeat(100000)}]}}}],expectedRounds:10});clean(y);assert.ok(JSON.stringify(y).length<4096);assert.equal(y.lastToolResult.reason.truncated,true)
})
test('safe diagnostic: mock subprocess success/error returns are summarized and clear their deadline timer',async()=>{
 const scheduled=[],cleared=[];let now=10
 const options={point:'pack-install',timeoutMs:100,now:()=>now,schedule:fn=>{scheduled.push(fn);return scheduled.length},clear:id=>cleared.push(id)}
 const ok=await observeProcess(async()=>{now=15;return{stdout:mixed,stderr:mixed}},options);assert.equal(ok.ok,true);assert.equal(ok.diagnostic.elapsedMs,5);clean(ok)
 const bad=await observeProcess(async()=>{throw Object.assign(new Error(mixed),{code:23,stderr:'ENOTFOUND '+mixed})},options);assert.equal(bad.ok,false);assert.equal(bad.diagnostic.exitCode,23);clean(bad);assert.equal(cleared.length,2)
})
test('safe diagnostic: mock timeout is observed from the wrapper timer; an unrelated abort remains non-timeout',async()=>{
 let fire,now=0;const cleared=[]
 const pending=observeProcess(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(mixed),{code:'ABORT_ERR',signal:'SIGTERM',killed:true,stderr:mixed})),{once:true})),{point:'pack-install',timeoutMs:100,now:()=>now,schedule:fn=>{fire=fn;return 1},clear:id=>cleared.push(id)})
 assert.equal(typeof fire,'function');now=100;fire();const x=await pending;assert.equal(x.ok,false);assert.equal(x.diagnostic.timedOut,true);assert.equal(x.diagnostic.elapsedMs,100);assert.equal(x.diagnostic.signal,'SIGTERM');clean(x);assert.deepEqual(cleared,[1])
 const y=await observeProcess(async()=>{throw Object.assign(new Error(mixed),{code:'ABORT_ERR',signal:'SIGTERM'})},{point:'pack-install',timeoutMs:100,now:()=>0,schedule:()=>1,clear:()=>{}});assert.equal(y.diagnostic.timedOut,false);clean(y)
})

test('safe diagnostic: the real assertion helpers expose only safe projected failures and do not turn failures into success',()=>{
 assert.throws(()=>requireCommandSuccess({point:'skill-enable',result:{kind:secret,text:mixed}}),error=>{clean(error.message);return JSON.parse(error.message).kind==='unknown'})
 assert.doesNotThrow(()=>requireCommandSuccess({point:'skill-enable',result:{kind:'success'}}))
 assert.throws(()=>requireAdmissionRounds({point:'skill-admission',requests:[],events:[],expectedRounds:10,error:{message:mixed},turnFailed:true}),error=>{clean(error.message);return JSON.parse(error.message).turnFailed===true})
 assert.doesNotThrow(()=>requireAdmissionRounds({point:'skill-admission',requests:[],events:[],expectedRounds:0}))
})
test('safe diagnostic: an unrecognized latest event is never replaced by an older request result or an invented stop reason',()=>{
 const x=admissionDiagnostic({point:'skill-admission',requests:[{messages:[{role:'tool',content:[{type:'text',text:'{"ok":true}'}]}]}],events:[{type:'tool/result',data:{unsupported:secret}},{type:'turn/end',data:{reason:{kind:secret}}}],expectedRounds:10})
 assert.equal(x.lastToolResult.source,'session');assert.equal(x.lastToolResult.format,'unrecognized');assert.equal(x.stopReason,'unclassified');clean(x)
})
test('safe diagnostic: a mock command that ignores abort and resolves after the observed deadline is still a failure',async()=>{
 let fire,resolve,now=0
 const pending=observeProcess(()=>new Promise(r=>{resolve=r}),{point:'pack-install',timeoutMs:100,now:()=>now,schedule:fn=>{fire=fn;return 1},clear:()=>{}})
 now=100;fire();resolve({stdout:mixed});const x=await pending;assert.equal(x.ok,false);assert.equal(x.diagnostic.success,false);assert.equal(x.diagnostic.timedOut,true);clean(x)
})

test('safe diagnostic: admission retains a blocked workflow and its safe reason without recording goals or task content',()=>{
 const x=admissionDiagnostic({point:'skill-admission',requests:[],events:[{type:'tool/result',data:{message:{role:'tool',content:[{type:'text',text:JSON.stringify({state:'blocked',next:'resolve_blocker',goal:secret,blocker:{kind:'runtime',cause:'sandbox_apply: Operation not permitted '+secret}})}]}}}],expectedRounds:10})
 assert.equal(x.lastToolResult.state,'blocked');assert.equal(x.lastToolResult.next,'resolve_blocker');assert.equal(x.lastToolResult.blockerKind,'runtime');assert.ok(x.lastToolResult.reason.categories.includes('sandbox_denied'));clean(x)
})

// Execute only the selected real call-site statements with mocked dependencies.
// No native fixture, socket, sandbox, filesystem setup, or npm command is run.
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import ts from 'typescript'
const sourceRoot=process.env.DIAGNOSTICS_SOURCE_ROOT ?? fileURLToPath(new URL('../',import.meta.url))
const parse=file=>ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true)
const emit=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const skillSource=()=>parse(join(sourceRoot,'tests/dsh/skill-delivery/skill-delivery.test.ts'))
function walk(root,predicate){const found=[];function visit(node){if(predicate(node))found.push(node);ts.forEachChild(node,visit)}visit(root);return found}

test('safe diagnostic: real Skill enable assertion safely records returned errors and thrown errors through the shared projector',async()=>{
 const tree=skillSource();const fn=walk(tree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='enableLisp')[0]
 assert.ok(fn,'Skill enable must use the diagnostic assertion helper')
 const enable=new Function('requireCommandSuccess','AbortController',emit(fn.getText(tree))+';return enableLisp')(requireCommandSuccess,AbortController)
 let calls=0;const f={ctx:{commands:{execute:async(...args)=>{calls++;assert.equal(args[1],'/kioku-lisp enable');return{result:{kind:'error',code:'COMPILE_FAILED',text:'sandbox_apply: Operation not permitted '+mixed}}}}},agent:{}}
 await assert.rejects(enable(f,'enable','skill-workflow-enable'),error=>{clean(error.message);const d=JSON.parse(error.message);return d.kind==='error'&&d.code==='COMPILE_FAILED'&&d.point==='skill-workflow-enable'})
 f.ctx.commands.execute=async()=>{throw Object.assign(new Error(mixed),{code:'EPERM'})}
 await assert.rejects(enable(f,'enable','skill-policy-enable'),error=>{clean(error.message);return JSON.parse(error.message).code==='EPERM'})
 f.ctx.commands.execute=async()=>({result:{kind:'success'}});await enable(f,'enable','skill-enable');assert.equal(calls,1)
})

test('safe diagnostic: real admission assertion captures post-turn session evidence and a safe failure when the turn throws',async()=>{
 const tree=skillSource();const call=walk(tree,node=>ts.isCallExpression(node)&&node.arguments[0]?.text==='Lisp selected during initial admission executes shared functions without switching mode')[0];assert.ok(call)
 const callback=call.arguments.at(-1);const outerTry=callback.body.statements.find(ts.isTryStatement)
 const statements=outerTry.tryBlock.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(tree)==='admission')||ts.isTryStatement(node)&&node.catchClause?.getText(tree).includes('requireAdmissionRounds')||ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(tree)==='requireAdmissionRounds')
 assert.equal(statements.length,3,'admission must capture turn execution and assert its safe diagnostic')
 const run=new Function('requireAdmissionRounds',`return async f=>{${emit(statements.map(n=>n.getText(tree)).join('\n'))}}`)(requireAdmissionRounds)
 const events=[{type:'tool/result',data:{message:{role:'tool',content:[{type:'text',text:JSON.stringify({state:'blocked',next:'resolve_blocker',blocker:{kind:'runtime',cause:'sandbox_apply: Operation not permitted '+mixed}})}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}}]
 const f={turn:async()=>{},model:{requests:Array.from({length:4},()=>({messages:[]}))},responses:Array(6),agent:{status:'idle',session:{snapshotEvents:()=>events}}}
 await assert.rejects(run(f),error=>{clean(error.message);const d=JSON.parse(error.message);return d.observedRounds===4&&d.expectedRounds===12&&d.lastToolResult.state==='blocked'&&d.stopReason==='completed'})
 f.turn=async()=>{throw Object.assign(new Error(mixed),{code:'EPERM'})}
 await assert.rejects(run(f),error=>{clean(error.message);return JSON.parse(error.message).turnFailed===true})
})

test('safe diagnostic: real pack install and catch statements retain exit metadata while emitting no raw child output',async()=>{
 const tree=parse(join(sourceRoot,'scripts/pack-check.mjs'));const main=tree.statements.find(ts.isTryStatement);assert.ok(main)
 const producer=walk(tree,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createAndSmokeTestTarball')[0];assert.ok(producer)
 const statements=[...producer.body.statements];const i=statements.findIndex(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(tree)==='installation'))
 assert.ok(i>=0,'consumer install must use the observed subprocess boundary')
 const code=emit(`let failureDiagnostic;const checkStarted=performance.now();try{${statements.slice(i,i+3).map(n=>n.getText(tree)).join('\n')}}catch(error){${main.catchClause.block.statements.map(n=>n.getText(tree)).join('\n')}};return process.exitCode`)
 const run=new Function('observeProcess','processDiagnostic','exec','process','performance','consumerRoot','cache','tarball','work',`return(async()=>{${code}})()`)
 for(const fail of [false,true]){
  const output=[];const process={env:{PATH:'/fixture'},stderr:{write:text=>output.push(text)}}
  const exec=async(command,args,options)=>{assert.equal(command,'npm');assert.equal(args[0],'install');assert.ok(options.signal instanceof AbortSignal);if(fail)throw Object.assign(new Error(mixed),{code:23,stderr:'ENOTCACHED '+mixed,stdout:mixed});return{stdout:mixed,stderr:mixed}}
  const status=await run(observeProcess,processDiagnostic,exec,process,{now:()=>1},'/fixture','/cache','fixture.tgz','/work')
  assert.equal(status,fail?23:undefined);assert.equal(output.length,1);clean(output);const d=JSON.parse(output[0]);assert.equal(d.point,'pack-install');assert.equal(d.exitCode,fail?23:0);assert.equal(d.timedOut,false)
 }
})

test('safe diagnostic: current unfinished admission never reuses a previous turn result or stop reason',()=>{
 const x=admissionDiagnostic({point:'skill-admission',requests:[{messages:[{role:'tool',content:[{type:'text',text:'{"ok":true}'}]}]}],events:[{type:'tool/result',data:{message:{role:'tool'}}},{type:'turn/end',data:{reason:{kind:'completed'}}},{type:'turn/start',data:{}}],expectedRounds:10})
 assert.equal(x.lastToolResult,null);assert.equal(x.stopReason,'not-recorded')
})

test('safe diagnostic: Node-style AbortError without exit status remains explicitly unreported',async()=>{
 let fire
 const pending=observeProcess(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(mixed),{code:'ABORT_ERR',stderr:mixed})),{once:true})),{point:'pack-install',timeoutMs:100,now:()=>100,schedule:fn=>{fire=fn;return 1},clear:()=>{}})
 fire();const x=await pending;assert.equal(x.diagnostic.timedOut,true);assert.equal(x.diagnostic.terminationRequested,'SIGTERM');assert.equal(x.diagnostic.code,'ABORT_ERR');assert.equal(x.diagnostic.signal,null);assert.equal(x.diagnostic.exitCode,null);assert.equal(x.diagnostic.killed,null);clean(x)
})
