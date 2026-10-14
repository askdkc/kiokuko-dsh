import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { DshTaskWorkflow, TASK_WORKFLOW_SERVICE } from '../../../src/dsh/task-state-host.js'
import { createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds, bindMainModelRequestIntent } from '../../../src/dsh/decisions/request-intent.js'
import { captureTaskLease, authorizeTaskLease, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import { OwnedExecutionService } from '../../../src/dsh/owned-execution.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { openConnection } from '../../../src/db/connection.js'

const signal=()=>new AbortController().signal
const request=(type:string)=>type==='writing'?'Write a short summary in PLAN.md. Target: PLAN.md. Expected: a concise summary. Preserve factual accuracy.':'Inspect PLAN.md and report its contents. Target: PLAN.md. Expected: a concise explanation. Do not modify files.'
function continuation(task:TaskSnapshot, text:string, action='research') {
  const context=createRequestIntentContext({task:text,messageRefs:requestIntentMessageRefs([],text),activeTask:task})!
  const decision=bindMainModelRequestIntent({relation:'same_scope_continuation',action,...(action==='change'?{changeScope:'document'}:{}),evidenceRefs:requestIntentReferenceIds(context)},context)!
  assert.ok(context);assert.ok(decision)
  return {requestIntent:decision,requestIntentContext:context}
}
for(const type of ['research','writing'] as const)test(`Core cold ${type} admission reuses explicit task across ToDo, start, Pending and native owner transfer`,async()=>{
  const root=realpathSync(await mkdtemp(join(tmpdir(),'existing-task-core-')))
  const options={repositoryRoot:root,databasePath:join(root,'state.sqlite3'),autoRegisterRepository:true,
    embeddingConfig:{mode:'off' as const,provider:'openai-compatible' as const,allowRemote:false,vectorBackend:'auto' as const,timeoutMs:1000,batchSize:1}}
  let runtime=new DshCoreRuntime(options);await runtime.start()
  const agent:any={id:'parent',session:{id:'parent-session',header:{cwd:root}},status:'idle',async whenIdle(){}}
  const agents=new Map([[agent.id,agent]]),sessions=new Map([[agent.session.id,agent.session]])
  const capabilities=[{kind:'skill' as const,name:'kiokuko-soul'}]
  const serviceOptions=()=>({runtime,agents,sessions,skills:{async snapshot(){return{complete:true,skills:[{name:'kiokuko-soul'}]}}},tools:{schemas:()=>[]},emit(){}})
  let service=new DshTaskWorkflow(serviceOptions())
  const ask=async(question:any)=>question.id==='taskType'?type:question.id==='target'?'PLAN.md':question.id==='expected'?'A concise explanation':'No unrelated changes'
  const prepare=async(snapshot:TaskSnapshot, owner=agent)=>new CoreTasks(runtime,{ask}).prepare({requestId:`continue-${snapshot.revision}`,sessionId:owner.session.id,turn:snapshot.revision,
    task:request(type),cwd:root,capabilities,signal:signal(),agent:owner,...continuation(snapshot,request(type),type==='writing'?'change':'research')})
  const counts=()=>runtime.withDatabase(db=>({runs:db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n,coding:db.prepare('SELECT count(*) n FROM dsh_coding_workflows').get()!.n}))
  try {
    const created=await service.operate(agent,{operation:'create',taskType:type,request:request(type)},signal())
    const todo=await prepare(created);assert.equal(todo.runId,created.taskId);assert.equal(todo.admitted,false)
    await runtime.close();service.dispose();runtime=new DshCoreRuntime(options);await runtime.start();service=new DshTaskWorkflow(serviceOptions())
    const started=await service.operate(agent,{operation:'start'},signal())
    const admitted=await prepare(started);assert.equal(admitted.runId,created.taskId);assert.equal(admitted.admitted,true)
    assert.equal(admitted.profile.taskType,type);assert.ok(admitted.authority)
    const oldLease=await runtime.withDatabase(db=>captureTaskLease(db,started))
    const target:any={id:'target',session:{id:'target-session',header:{cwd:root,parentSession:agent.session.id}},status:'idle',async whenIdle(){}}
    agents.set(target.id,target);sessions.set(target.session.id,target.session)
    const moved=await service.handoff(agent,target,started,signal())
    assert.equal(moved.taskId,created.taskId);assert.equal(moved.sourceSessionId,agent.session.id)
    const rebound=await prepare(moved,target);assert.equal(rebound.admitted,true);assert.equal(rebound.sessionId,target.session.id);assert.equal(rebound.runId,created.taskId)
    await assert.rejects(runtime.withDatabase(db=>authorizeTaskLease(db,oldLease)),/owner|stale/)
    const waiting=await service.operate(target,{operation:'wait',expected:moved},signal())
    let pending=waiting
    for(let i=0;i<50&&pending.pendingStop;i++){await new Promise(resolve=>setImmediate(resolve));pending=(await service.snapshot(target)).task!}
    assert.equal(pending.state,'Pending')
    const blocked=await prepare(pending,target);assert.equal(blocked.runId,created.taskId);assert.equal(blocked.admitted,false)
    const owned=new OwnedExecutionService({runtime,resolve:()=>({...blocked,repositoryRoot:root,generation:'test',agent:target})})
    try{await assert.rejects(owned.execute('kioku_write',{path:'denied.txt',content:'no'},{name:'kioku_write',callId:'denied',agent:target,signal:signal()}),/not Working|authorizes inspection/)}finally{await owned.close()}
    assert.deepEqual(await counts(),{runs:1,coding:0})
  }finally{service.dispose();await runtime.close();await rm(root,{recursive:true,force:true})}
})

const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const available=existsSync(join(packages,'@deepseek-ai/dsh-tools/lib/index.js'))
for(const host of ['core','adapter'] as const)for(const type of ['research','writing'] as const)test(`native ${host} ${type} explicit create/start admits the same task with cold host state`,{skip:!available,timeout:30000},async()=>withIsolatedSkillHome(async()=>{
  const f=await nativeSkillFixture({packages,explicit:host==='adapter',extra:{lisp:{enabled:false},typedDecisions:{mode:'off'},answerReview:{mode:'off'},memoryReuse:{mode:'off'},
    memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},semanticCompaction:{mode:'off'},modelAutoMode:{mode:'off'},toolExposure:{mode:'full'}}})
  try{
    await writeFile(join(f.dir,'PLAN.md'),'EXISTING_TASK_SOURCE')
    const service=f.ctx.get(TASK_WORKFLOW_SERVICE,false) as DshTaskWorkflow
    assert.ok(service,'public task workflow service is mounted')
    const created=await service.operate(f.agent,{operation:'create',taskType:type,request:request(type)},signal())
    await service.operate(f.agent,{operation:'start'},signal())
    if(host==='core')await f.reload('compiled');else await f.reloadHost('compiled')
    const reloaded=f.ctx.get(TASK_WORKFLOW_SERVICE,false) as DshTaskWorkflow
    assert.equal((await reloaded.snapshot(f.agent)).task!.taskId,created.taskId)
    let admitted=false
    f.responses.push(interpretedPreparation(f.mock,'same-task','same_scope_continuation',type==='writing'?'change':'research',type),
      (req:any)=>{
        assert.equal(toolValue(req,'same-task').prepared,true)
        const db=openConnection(join(f.dir,host==='adapter'?'state.sqlite3':'kiokuko-dsh.sqlite3'))
        try{
          assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n,1)
          assert.equal(db.prepare('SELECT run_id FROM dsh_execution_owners WHERE dsh_session_id=?').get<any>(f.agent.session.id)!.run_id,created.taskId)
          assert.equal(db.prepare('SELECT count(*) n FROM dsh_coding_workflows').get()!.n,0)
        }finally{db.close()}
        admitted=true;return f.mock.toolCallResponse('read-current','kioku_read',{path:'PLAN.md'})
      },(req:any)=>{assert.match(JSON.stringify(toolValue(req,'read-current')),/EXISTING_TASK_SOURCE/);return f.mock.textResponse('The original task remains selected.')})
    await f.turn(request(type))
    assert.equal(admitted,true)
  }finally{await f.close()}
}))
