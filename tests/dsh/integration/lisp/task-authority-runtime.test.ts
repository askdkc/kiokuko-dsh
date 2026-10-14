import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { authorizeTaskLease, recordTaskEvidence, transitionTask, type TaskLease } from '../../../../src/dsh/task-state.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { digest, LISP_TOOLS, LispConfig, type LispTool } from '../../../../src/dsh/lisp/contracts.js'

test('all 18 Lisp entry points use effect authority without blocking saved reads or pure real SBCL computation', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires the existing local SBCL runtime' : false, timeout: 180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-task-table-'))), root = join(base, 'workspace')
  await mkdir(root); await writeFile(join(root, 'value.txt'), 'before')
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:')); migrateDatabase(db)
  const store = new LispStore(async action => action(db)), owner = { sessionId: 'session', agentId: 'agent', root }
  let verifications = 0, questions = 0
  const manager = new LispManager({ store, dataRoot: join(base, 'runtime'),
    config: LispConfig.parse({ enabled: true, executionMode: 'development', startupTimeoutMs: 60000 }),
    ciCall: async () => { verifications++; return {} },
    questions: { ask: async request => { questions++; return { answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.intent!.approve!] }] } } } })
  const seen = new Set<LispTool>()
  const run = async (name: LispTool, args: Record<string, unknown> = {}, who = owner) => {
    seen.add(name)
    return await manager.execute(who, name, { ...(['lisp_status', 'lisp_hot_status'].includes(name) ? {} : { operationId: randomUUID() }), ...args }) as any
  }
  const success = (value: any) => { assert.notEqual(value.ok, false, JSON.stringify(value)); return value }
  try {
    await manager.start(); await manager.enableTask(owner)
    success(await run('lisp_eval', { code: '(+ 20 22)' }))
    const definition = success(await run('lisp_define', { name: 'identity', description: 'Return the input', source: '(lambda (input) input)', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' } }))
    const called = success(await run('lisp_call', { toolRef: definition.toolRef, input: 42 })); assert.equal(called.value, 42)
    const observed = success(await run('lisp_observe', { paths: ['value.txt'] }))
    const proposed = [{ operation: 'write', path: 'value.txt', content: 'after' }], resultRef = randomUUID()
    // Saved candidate payload is a host fixture; stage/apply still use the real journal and filesystem snapshots.
    await store.reserve(owner, resultRef, 'task_result', digest(proposed), 'host', { sourceRefs: [observed.resultRef] })
    await store.transition(owner, resultRef, ['RUNNING'], 'SUCCEEDED', { value: proposed })
    const staged = success(await run('lisp_stage', { resultRef, baseRef: observed.resultRef }))
    success(await run('lisp_compare', { leftRef: staged.candidateRef, rightRef: staged.candidateRef }))
    success(await run('lisp_describe', { toolRef: definition.toolRef }))
    success(await run('lisp_inspect', { resultOperationId: resultRef }))
    success(await run('lisp_status')); success(await run('lisp_hot_status')); success(await run('lisp_cancel'))
    const contract = { name: 'increment', description: 'Increment a number', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] }
    const mutations: Array<[LispTool, Record<string, unknown>]> = [
      ['lisp_verify', { candidateRef: staged.candidateRef, target: 'test' }],
      ['lisp_apply', { candidateRef: staged.candidateRef }],
      ['lisp_hot_contract', contract],
      ['lisp_hot_install', { name: contract.name, contractRef: randomUUID(), expectedRevision: 0, source: '(lambda (input) (+ input 1))' }],
      ['lisp_hot_deactivate', { name: contract.name, expectedRevision: 0 }],
    ]
    for (const [name, args] of mutations) {
      const result = await run(name, args)
      assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`)
      assert.match(JSON.stringify(result), /TASK_REQUIRED/, name)
    }
    const resetOwner = { ...owner, sessionId: 'persistent-session' }
    await store.enable(resetOwner); manager.enabled.set(resetOwner.sessionId, root)
    assert.equal((await run('lisp_reset', {}, resetOwner)).code, 'TASK_REQUIRED')
    assert.equal(verifications, 0); assert.equal(questions, 0)

    const working = workingLispTask(db, owner)
    const approved = success(await run('lisp_hot_contract', contract))
    success(await run('lisp_hot_install', { name: contract.name, contractRef: approved.contractRef, expectedRevision: 0, source: '(lambda (input) (+ input 1))' }))
    recordTaskEvidence(db, working, { ref: 'stopped', kind: 'stopped', generation: working.generation, verified: true })
    transitionTask(db, working, { operation: 'wait', operationId: 'wait', expectedRevision: working.revision, reason: 'Host has stopped all effects', evidence: ['stopped'] })
    const hot = success(await run('lisp_hot_call', { name: contract.name, input: 41 })); assert.equal(hot.value, 42)
    success(await run('lisp_status')); success(await run('lisp_hot_status')); success(await run('lisp_cancel'))
    assert.deepEqual([...seen].sort(), [...LISP_TOOLS].sort(), 'Every public Lisp tool has an executed boundary case')
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})

test('real Lisp start-job keeps the original task lease across detached execution and rejects a late success after resume', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires the existing local SBCL runtime' : false, timeout: 120000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-job-authority-'))), root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  const owner = { sessionId: 'session', agentId: 'agent', root }, task = workingLispTask(db, owner)
  const store = new LispStore(async action => action(db))
  let inherited: TaskLease | undefined, calls = 0
  const manager = new LispManager({ store, dataRoot: join(base, 'runtime'),
    config: LispConfig.parse({ enabled: true, executionMode: 'development', startupTimeoutMs: 60000 }),
    toolCall: async (_owner, name, args, signal, _callId, lease) => {
      if (name === 'kioku_result') return { receipt: { state: 'cancelled', processStopped: true, operationId: 'background-job' } }
      assert.equal(name, 'kioku_exec'); assert.equal(args.background, true)
      assert.ok(signal, 'background admission has its own host cancellation signal'); assert.equal(signal.aborted,false)
      assert.ok(lease); inherited = lease; calls++
      recordTaskEvidence(db, task, { ref: 'stopped', kind: 'stopped', generation: task.generation, verified: true })
      const pending = transitionTask(db, task, { operation: 'wait', operationId: 'wait', expectedRevision: task.revision, reason: 'Observed job stop', evidence: ['stopped'] })
      transitionTask(db, pending, { operation: 'resume', operationId: 'resume', expectedRevision: pending.revision, explicit: true, reason: 'New explicit execution generation' })
      assert.throws(() => authorizeTaskLease(db, lease), /stale or stopped/)
      return { receipt: { state: 'started', operationId: 'background-job' } }
    } })
  try {
    await manager.start(); await manager.enable(owner)
    const result = await manager.execute(owner, 'lisp_eval', { operationId: 'job-eval', code: '(kioku.process:start-job "node" (list "--version"))' }) as any
    assert.equal(calls, 1, JSON.stringify(result)); assert.equal(inherited!.taskId, task.taskId)
    assert.equal(inherited!.generation, task.generation)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(JSON.stringify(result), /TASK_STATE_CONFLICT|stale or stopped/)
    assert.notEqual((await store.get(owner, 'job-eval'))!.state, 'SUCCEEDED')
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})

test('real Lisp job-status retains an unknown owned job for reconciliation', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires the existing local SBCL runtime' : false, timeout:120000,
},async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-unknown-job-'))),root=join(base,'workspace');await mkdir(root)
  const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:'))
  const owner={sessionId:'unknown-session',agentId:'agent',root};workingLispTask(db,owner)
  let terminal=false
  const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),
    config:LispConfig.parse({enabled:true,executionMode:'development',startupTimeoutMs:60000}),
    toolCall:async(_owner,name)=>({receipt:{operationId:'unknown-job',state:name==='kioku_exec'?'started':terminal?'completed':'unknown',processStopped:terminal}})})
  try{
    await manager.start();await manager.enable(owner)
    const start=await manager.execute(owner,'lisp_eval',{operationId:'start',code:'(kioku.process:start-job "node" (list "--version"))'}) as any
    assert.equal(start.ok,true,JSON.stringify(start))
    const status=await manager.execute(owner,'lisp_eval',{operationId:'poll',code:'(kioku.process:job-status "unknown-job")'}) as any
    assert.equal(status.ok,true,JSON.stringify(status))
    assert.ok((await manager.status(owner) as any).jobs.some((job:any)=>job.operationId==='unknown-job'),'unknown is retained until observed stop or reconciliation')
    assert.equal(manager.taskJobsIdle(owner),false,'an unresolved owned job cannot authorize task completion')
  }finally{terminal=true;await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})

test('real Lisp tracks initial unknown and unconfirmed-completed receipts from both owned entry points', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires the existing local SBCL runtime' : false,timeout:120000,
},async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-initial-job-'))),root=join(base,'workspace');await mkdir(root)
  const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:'))
  const owner={sessionId:'initial-session',agentId:'agent',root};workingLispTask(db,owner)
  let calls=0,terminal=false
  const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),
    config:LispConfig.parse({enabled:true,executionMode:'development',startupTimeoutMs:60000}),
    toolCall:async(_owner,name,args)=>name==='kioku_exec'?{receipt:{operationId:`initial-${++calls}`,state:calls===1?'unknown':'completed',processStopped:false}}:{receipt:{operationId:args.operationId,state:terminal?'completed':'unknown',processStopped:terminal}}})
  try{
    await manager.start();await manager.enable(owner)
    const start=await manager.execute(owner,'lisp_eval',{operationId:'start',code:'(kioku.process:start-job "node" (list "--version"))'}) as any
    assert.equal(start.ok,true,JSON.stringify(start))
    const code=`(kioku.tools:call-tool "kioku_exec" (kioku.data:parse-json ${JSON.stringify(JSON.stringify({command:'node --version',background:true}))}))`
    const bridge=await manager.execute(owner,'lisp_eval',{operationId:'bridge',code}) as any
    assert.equal(bridge.ok,true,JSON.stringify(bridge))
    const foreground=await manager.execute(owner,'lisp_eval',{operationId:'foreground',code:'(kioku.process:run "node" (list "--version"))'}) as any
    assert.equal(foreground.ok,true,JSON.stringify(foreground))
    const jobs=(await manager.status(owner) as any).jobs.map((job:any)=>job.operationId)
    assert.ok(jobs.includes('initial-1'),'initial unknown receipt must remain tracked')
    assert.ok(jobs.includes('initial-2'),'completed without stop proof must remain tracked')
    assert.ok(jobs.includes('initial-3'),'foreground orchestration completion without stop proof must remain tracked')
    assert.equal(manager.taskJobsIdle(owner),false)
  }finally{terminal=true;await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})

function controlled<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve} }
test('real Lisp cancel cannot report success while an owned admission is unresolved', {
 skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires actual SBCL':false,timeout:120000,
},async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-admitting-'))),root=join(base,'workspace');await mkdir(root)
 const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:')),owner={sessionId:'admitting',agentId:'agent',root};workingLispTask(db,owner)
 const entered=controlled<void>(),release=controlled<void>();let admissionSignal:AbortSignal|undefined,cancels=0
 const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),config:LispConfig.parse({enabled:true,executionMode:'development',startupTimeoutMs:60000}),
 toolCall:async(_owner,name,args,signal)=>{if(name==='kioku_exec'){admissionSignal=signal;entered.resolve();await release.promise;return {receipt:{operationId:'late-job',state:'started'}}}cancels++;return {receipt:{operationId:args.operationId,state:'completed',processStopped:true}}}})
 let evaluation:Promise<unknown>|undefined
 try{
  await manager.start();await manager.enable(owner)
  evaluation=manager.execute(owner,'lisp_eval',{operationId:'admitting-eval',code:'(kioku.process:start-job "node" (list "--version"))'})
  await entered.promise
  const cancelled=await manager.execute(owner,'lisp_cancel',{}) as any
  assert.equal(cancelled.code,'STOP_UNCONFIRMED','unresolved host admission cannot be reported as stopped')
  assert.equal(admissionSignal?.aborted,true,'cancel must also reach the host before its first receipt')
  assert.equal(manager.taskJobsIdle(owner),false)
 }finally{release.resolve();await evaluation;await manager.dispose();assert.ok(cancels>=1,'late receipt is reconciled instead of lost');db.close();await rm(base,{recursive:true,force:true})}
})
test('ephemeral development Lisp cancels owned run and CI jobs before releasing its task state', {
 skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1'?'requires actual SBCL':false,timeout:120000,
},async()=>{
 const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-task-owned-'))),root=join(base,'workspace');await mkdir(root)
 const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:')),owner={sessionId:'task-owned',agentId:'agent',root};workingLispTask(db,owner)
 const cancelled:string[]=[]
 const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),config:LispConfig.parse({enabled:true,executionMode:'development',startupTimeoutMs:60000}),
 toolCall:async(_owner,name,args)=>{if(name==='kioku_exec')return {receipt:{operationId:'task-job',state:'started'}};cancelled.push(String(args.operationId));return {receipt:{operationId:args.operationId,state:'completed',processStopped:true}}},
 ciCall:async()=>({code:1,state:'FAILED',receipt:{operationId:'ci-job',state:'completed',processStopped:false}})})
 try{
  await manager.start();await manager.enableTask(owner)
  const run=await manager.execute(owner,'lisp_eval',{operationId:'task-run',code:'(kioku.process:start-job "node" (list "--version"))'}) as any
  assert.equal(run.ok,true,JSON.stringify(run));assert.ok(cancelled.includes('task-job'),'ephemeral cleanup confirms the owned job before dropping its state')
  const ci=await manager.execute(owner,'lisp_eval',{operationId:'task-ci',code:'(kioku.ci:verify :test)'}) as any
  assert.equal(ci.ok,true,JSON.stringify(ci));assert.ok(cancelled.includes('ci-job'),'CI receipt shares the same owned stop boundary')
  assert.equal(manager.taskJobsIdle(owner),true)
 }finally{await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
