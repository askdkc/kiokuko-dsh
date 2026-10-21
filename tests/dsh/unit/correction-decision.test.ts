import type {CorrectionBackend} from '../../../src/memory/correction-classification.js'
import {canonicalContentHash} from '../../../src/serialization/validate.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {resolveProjectWorkspace} from '../../../src/memory/workspaces.js'
import {recordEntry,updateCandidateEntry} from '../../../src/memory/entries.js'
import {readTaskCorrections,observeCorrectionInput,currentCorrectionSources} from '../../../src/dsh/correction-context.js'
import {checkCorrectionDecision,literalVersionGate} from '../../../src/dsh/correction-decision.js'
import {prepareAgentTask} from '../../../src/dsh/task-intake.js'
import {currentContextMemory} from '../../../src/dsh/request-memory.js'
import {KIOKUKO_DSH_SOURCE_KIND} from '../../../src/dsh/plugin-source.js'
import {mountMemoryApplication} from '../../../src/dsh/memory-application.js'
import {mountTaskCompletion} from '../../../src/dsh/task-completion-host.js'
import {observeProcessResult} from '../../../src/dsh/execution-result.js'

// Scripted transport/gate fixture, not evidence of semantic quality.
const backend:CorrectionBackend={configurationDigest:canonicalContentHash('correction-gate-fixture'),async evaluate(){return {status:'completed',attested:true,result:{provider:'fixture',requestedModel:'gate-fixture',policyVersion:'fixture-v1',answers:[{id:'correction-rule',status:'selected',choiceId:'capability_compatibility'}]}}}}
test('retrieval failure, no match, missing delivery, source tampering and version-only decisions remain distinct',async()=>{
  const root=realpathSync(await mkdtemp(join(tmpdir(),'correction-stages-')))
  await mkdir(join(root,'.git'));await writeFile(join(root,'package.json'),'{"name":"stage-fixture","private":true}')
  const db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  try {
    const project=(await resolveProjectWorkspace(db,root))!
    const profile={taskType:'build' as const,target:'Rust',expected:'native acceptance',constraints:null},signal=new AbortController().signal
    const noCorrection=await readTaskCorrections(db,{project,runId:'fixture',task:'Rust compiler compatibility',profile,signal,backend,correctionMode:'auto'})
    assert.equal(noCorrection.corrections.retrieval,'no_correction')
    recordEntry(db,{workspace:project.workspace,kind:'lesson',title:'Rust compatibility',body:'Do not reject Rust only because compiler versions differ. Validate actual compiler capabilities.',scope:{visibility:'project'},provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    const selected=await readTaskCorrections(db,{project,runId:'fixture',task:'Rust compiler compatibility',profile,signal,backend,correctionMode:'auto'})
    assert.equal(selected.corrections.retrieval,'retrieved');assert.equal(selected.corrections.delivery,'not_delivered')
    const decision={kind:'compatibility' as const,target:'check.mjs',basis:'version_only' as const,requiredVersion:'1.85.0',observedVersion:'1.99.1'}
    assert.equal(checkCorrectionDecision(db,undefined,decision).reason,'not_requested')
    assert.equal(checkCorrectionDecision(db,selected.corrections,decision).state,'handoff_missing')
    const allowed=currentContextMemory(db,project.workspace,selected.context!.items,undefined,selected.context!)
    const messages=[...allowed].map(([name,text])=>({role:'user',content:[{type:'text',text}],source:{kind:KIOKUKO_DSH_SOURCE_KIND,sections:[{name,text}]}}))
    const delivered=observeCorrectionInput(selected.corrections,allowed,messages)
    assert.equal(delivered.delivery,'delivered');assert.ok(delivered.inputDigest)
    assert.equal(checkCorrectionDecision(db,delivered,decision).state,'contradiction')
    assert.equal(checkCorrectionDecision(db,delivered,{...decision,basis:'capability'}).verification,'unverified')
    assert.equal(checkCorrectionDecision(db,delivered,{...decision,basis:'reproducibility'}).state,'unverified')
    const missing=observeCorrectionInput(delivered,allowed,[])
    assert.equal(missing.delivery,'not_delivered');assert.equal(missing.inputDigest,undefined)
    const altered={...delivered,sources:delivered.sources.map(source=>({...source,sourceDigest:'0'.repeat(64)}))}
    assert.equal(currentCorrectionSources(db,altered),false);assert.equal(checkCorrectionDecision(db,altered,decision).state,'stale')
    const broken=await readTaskCorrections({prepare(){throw new Error('synthetic observer unavailable')}} as any,{project,runId:'fixture',task:'Rust',profile,signal,backend,correctionMode:'auto'})
    assert.equal(broken.corrections.retrieval,'unavailable')
    const aborted=new AbortController();aborted.abort()
    await assert.rejects(readTaskCorrections(db,{project,runId:'fixture',task:'Rust',profile,signal:aborted.signal}))
  } finally {db.close();await rm(root,{recursive:true,force:true})}
})

test('literal write detector leaves CI pins, lower bounds, test fixtures, prose and reads alone',()=>{
  const root='/fixture',content='assert.match(compiler.stdout, /^rustc 1\\.85\\.0 /)'
  assert.equal(literalVersionGate('kioku_write',{path:'scripts/build.mjs',content},root)?.basis,'version_only')
  for(const [name,args]of [
    ['kioku_write',{path:'tests/version.test.mjs',content}],['kioku_write',{path:'README.md',content}],
    ['kioku_write',{path:'scripts/build.mjs',content:'rustup toolchain install 1.85.0'}],
    ['kioku_write',{path:'scripts/build.mjs',content:'assert.ok(compiler.version >= minimum)'}],
    ['Read',{path:'scripts/build.mjs',content}],['kioku_write',{path:'../outside.mjs',content}],
  ] as const)assert.equal(literalVersionGate(name,args,root),undefined)
})

test('public decision check rejects version-only incomplete claims only after actual source-bound verification',async()=>{
  const root=realpathSync(await mkdtemp(join(tmpdir(),'correction-completion-')))
  await mkdir(join(root,'.git'));await writeFile(join(root,'package.json'),'{"name":"completion-fixture","private":true}')
  await writeFile(join(root,'check.test.mjs'),'import test from "node:test"; import assert from "node:assert/strict"; test("native capability",()=>assert.equal(2+2,4))\n')
  const db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  const disposers:(()=>void)[]=[]
  try {
    const project=(await resolveProjectWorkspace(db,root))!
    recordEntry(db,{workspace:project.workspace,kind:'lesson',title:'Rust compatibility',body:'Do not reject compiler compatibility only because versions differ; verify compiler capabilities.',scope:{visibility:'project'},provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    const prepared=await prepareAgentTask(db,{requestId:'completion',cwd:root,dshSessionId:'session',task:'Inspect Rust compatibility.\n完了条件:\n- 対象テストが成功する',profileHints:{taskType:'research',target:'check.test.mjs',expected:'Verify capability',constraints:null},completionMode:'enforce',capabilities:[],skillDiscoveryMode:'off'})
    const selected=await readTaskCorrections(db,{project,runId:prepared.run.runId,task:'Rust compiler compatibility',profile:prepared.intake.profile,signal:new AbortController().signal,backend,correctionMode:'auto'})
    const allowed=currentContextMemory(db,project.workspace,selected.context!.items,undefined,selected.context!)
    let receipt=observeCorrectionInput(selected.corrections,allowed,[...allowed].map(([name,text])=>({role:'user',content:[{type:'text',text}],source:{kind:KIOKUKO_DSH_SOURCE_KIND,sections:[{name,text}]}})))
    const agent={id:'agent'},runtime={withDatabase:async(fn:any)=>fn(db)} as any,tools:any[]=[],listeners=new Map<string,Function[]>()
    const ctx={tools:{register(tool:any){tools.push(tool);return ()=>{}}},on(name:string,fn:Function,options?:{prepend:boolean}){const list=listeners.get(name)??[];options?.prepend?list.unshift(fn):list.push(fn);listeners.set(name,list);return ()=>{}}}
    const identity={runId:prepared.run.runId,workspace:project.workspace,sessionId:'session',repositoryRoot:root}
    let questions=0
    disposers.push(mountMemoryApplication(ctx,{runtime,resolve:execution=>execution.agent===agent?{...identity,corrections:receipt}:undefined,refresh:async()=>{},questions:{async ask(request){questions++;return {answers:[{id:request.questions[0].id,selected:['見直す']}]}}}}))
    disposers.push(mountTaskCompletion(ctx,{runtime,resolve:execution=>execution.agent===agent?{...identity,agent}:undefined,approve:async()=>true}))
    let seq=0
    const call=(name:string,args:any)=>tools.find(tool=>tool.name===name).execute(args,{name,arguments:args,agent,callId:`call-${++seq}`,signal:new AbortController().signal})
    const claim={kind:'completion',target:'check.test.mjs',complete:false,basis:'version_only'}
    assert.equal((await call('correction_check',{decision:claim})).state,'unverified')
    const status=await call('task_completion',{action:'status'})
    const command='node --test --test-reporter=tap check.test.mjs'
    for(const criterion of status.criteria)await call('task_completion',{action:'bind',criterionId:criterion.criterionId,method:{kind:'native_command',command,cwd:'.',sourcePaths:['check.test.mjs'],assertion:'selected_tests_pass'}})
    const execution={name:'Bash',arguments:{command,cwd:root},agent,callId:'actual-test',signal:new AbortController().signal}
    const handlers=listeners.get('tools/pre-execute')!
    const dispatch=(index:number):any=>handlers[index]?handlers[index]!(execution,()=>dispatch(index+1)):undefined
    await dispatch(0)
    const childEnvironment={...process.env};delete childEnvironment.NODE_TEST_CONTEXT
    const ran=spawnSync(process.execPath,['--test','--test-reporter=tap','check.test.mjs'],{cwd:root,encoding:'utf8',env:childEnvironment});assert.equal(ran.status,0)
    const actual=observeProcessResult({isError:false,value:{exitCode:0,signal:null,timedOut:false,aborted:false,processStarted:true,processStopped:true,outputComplete:true},content:[{type:'text',text:ran.stdout}]})
    for(const listener of listeners.get('tools/result')??[])await listener(execution,actual)
    const verified=await call('task_completion',{action:'status'})
    assert.equal(verified.verified,true,JSON.stringify({verified,executions:db.prepare('SELECT * FROM dsh_completion_executions').all()}))
    const denied=await call('correction_check',{decision:claim})
    assert.equal(denied.reason,'verified_work_marked_incomplete_for_version');assert.equal(denied.allowed,false);assert.equal(denied.verification,'host_observed');assert.equal(questions,1)
    assert.equal((await call('correction_check',{decision:claim})).allowed,false);assert.equal(questions,1)
    const complete=await call('correction_check',{decision:{...claim,complete:true,basis:'observed_checks'}})
    assert.equal(complete.state,'consistent');assert.equal(complete.verification,'host_observed')
    await writeFile(join(root,'check.test.mjs'),'changed after verification')
    assert.equal((await call('correction_check',{decision:claim})).state,'unverified','stale proof cannot establish false incompletion')
    receipt={...receipt,runId:'another-task'}
    await assert.rejects(call('correction_check',{decision:claim}),/another native task/)
  } finally {for(const dispose of disposers.reverse())dispose();db.close();await rm(root,{recursive:true,force:true})}
})

test('native confirmation binds one operation and optional observer failures do not hold other work',async()=>{
  const root=realpathSync(await mkdtemp(join(tmpdir(),'correction-confirmation-')))
  await mkdir(join(root,'.git'));await writeFile(join(root,'package.json'),'{"name":"confirmation-fixture","private":true}')
  const db=openConnection(join(root,'state.sqlite3'));migrateDatabase(db)
  try {
    const project=(await resolveProjectWorkspace(db,root))!
    const entry=recordEntry(db,{workspace:project.workspace,kind:'lesson',title:'Rust compatibility',body:'Do not reject compiler compatibility only because versions differ; verify compiler capabilities.',scope:{visibility:'project'},provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    const prepared=await prepareAgentTask(db,{requestId:'confirmation',cwd:root,dshSessionId:'session',task:'Inspect Rust compatibility',profileHints:{taskType:'research',target:'check.mjs',expected:'Verify capability',constraints:null},capabilities:[],skillDiscoveryMode:'off'})
    const selected=await readTaskCorrections(db,{project,runId:prepared.run.runId,task:'Rust compiler compatibility',profile:prepared.intake.profile,signal:new AbortController().signal,backend,correctionMode:'auto'})
    const allowed=currentContextMemory(db,project.workspace,selected.context!.items,undefined,selected.context!)
    const receipt=observeCorrectionInput(selected.corrections,allowed,[...allowed].map(([name,text])=>({role:'user',content:[{type:'text',text}],source:{kind:KIOKUKO_DSH_SOURCE_KIND,sections:[{name,text}]}})))
    const agent={id:'agent'},identity={runId:prepared.run.runId,workspace:project.workspace,sessionId:'session',repositoryRoot:root,corrections:receipt}
    let offline=false,questions=0,answer='この操作だけ許可',wrongId=false,onAsk:()=>Promise<void>=async()=>{}
    const runtime={withDatabase:async(fn:any)=>{if(offline)throw new Error('synthetic observer outage');return fn(db)}} as any
    const tools:any[]=[],guards:Function[]=[]
    const dispose=mountMemoryApplication({tools:{register(tool){tools.push(tool);return ()=>{}}},on(name,fn){if(name==='tools/pre-execute')guards.push(fn);return ()=>{}}},{runtime,resolve:execution=>execution.agent===agent?identity:undefined,refresh:async()=>{},questions:{async ask(request){questions++;await onAsk();return {answers:[{id:wrongId?'unrelated':request.questions[0].id,selected:[answer]}]}}}})
    const execution=(target:string)=>({name:'kioku_write',arguments:{path:target,content:'assert.match(compiler.stdout, /^rustc 1\\.85\\.0 /)'},agent,callId:`write-${target}`,signal:new AbortController().signal})
    const dispatch=(call:any,next:()=>Promise<unknown>)=>guards[0]!(call,next)
    let continued=0
    const next=async()=>{continued++;return 'native-authority-remains-responsible'}
    assert.equal(await dispatch(execution('approved.mjs'),next),'native-authority-remains-responsible')
    assert.equal(await dispatch(execution('approved.mjs'),next),'native-authority-remains-responsible')
    assert.equal(questions,2,'an approval is consumed by exactly one invocation')
    assert.equal(continued,2)
    await assert.rejects(dispatch(execution('native-denied.mjs'),async()=>{throw new Error('existing native permission denied')}),/existing native permission denied/)
    wrongId=true
    await assert.rejects(dispatch(execution('wrong-id.mjs'),next),/Correction conflict/)
    wrongId=false
    const changed=execution('changed-args.mjs')
    onAsk=async()=>{changed.arguments.content+=' changed'}
    await assert.rejects(dispatch(changed,next),/operation changed/)
    onAsk=async()=>{await writeFile(join(root,'changed-target.mjs'),'changed while awaiting confirmation')}
    await assert.rejects(dispatch(execution('changed-target.mjs'),next),/target or verification changed/)
    onAsk=async()=>{}
    offline=true
    assert.equal(await dispatch(execution('observer-offline.mjs'),next),'native-authority-remains-responsible')
    const tool=tools.find(tool=>tool.name==='correction_check'),args={decision:{kind:'compatibility',target:'observer-offline.mjs',basis:'version_only',requiredVersion:'1.85.0',observedVersion:'1.99.1'}}
    const unavailable=await tool.execute(args,{...execution('observer-offline.mjs'),name:'correction_check',arguments:args})
    assert.equal(unavailable.state,'unavailable');assert.equal(unavailable.allowed,true);assert.equal(unavailable.verification,'unverified');assert.equal(unavailable.recorded,false)
    offline=false
    onAsk=async()=>{updateCandidateEntry(db,{...entry,entryId:entry.id,expectedRevision:entry.revision,body:'changed correction',createdBy:'fixture'})}
    await assert.rejects(dispatch(execution('changed-source.mjs'),next),/source changed/)
    assert.equal(continued,3,'conflicts hold only their own operation')
    dispose()
  } finally {db.close();await rm(root,{recursive:true,force:true})}
})
