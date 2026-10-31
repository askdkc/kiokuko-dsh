import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { ManagedOperationJournal } from '../../../../src/dsh/managed-operation-journal.js'
import { workingLispTask } from '../../helpers/lisp-task.js'

test('real SBCL returning 42 retains native process operation and a complete zero-operation evaluation', {
  skip:process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires SBCL' : false,timeout:90000,
},async () => {
  const base=await realpath(await mkdtemp(join(tmpdir(),'managed-lisp-'))),root=join(base,'work')
  await mkdir(root)
  const db=new NodeSqliteAdapter(join(base,'db'),new DatabaseSync(join(base,'db')))
  const owner={sessionId:'journal-session',agentId:'journal-agent',root}
  workingLispTask(db,owner)
  const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),
    config:LispConfig.parse({enabled:true,executionMode:'development',startupTimeoutMs:60000}),
    toolCall:async()=>{throw new Error('native branch should be selected')},
  })
  try {
    await manager.start();await manager.enable(owner)
    const result=await manager.execute(owner,'lisp_eval',{operationId:'external-then-42',code:`(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" "require('fs').writeFileSync('effect.txt','once')")) 42`},undefined,{
      assertCurrent(){},async run(input){const result=await promisify(execFile)(input.program,input.argv,{cwd:root,timeout:input.timeoutMs});return {code:0,stdout:result.stdout,stderr:result.stderr,receipt:{route:'native',processStopped:true}}},
    }) as any
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.json,42)
    assert.equal(await readFile(join(root,'effect.txt'),'utf8'),'once')
    const rows=db.prepare('SELECT operation_json FROM dsh_managed_operations').all<{operation_json:string}>()
    assert.equal(rows.length,1)
    const operation=JSON.parse(rows[0]!.operation_json)
    assert.equal(operation.state,'completed');assert.equal(operation.outcome,'succeeded');assert.equal(operation.route,'native')
    assert.equal(new ManagedOperationJournal(db).snapshot(operation.scopeId).complete,true)
    const pure=await manager.execute(owner,'lisp_eval',{operationId:'pure-42',code:'42'}) as any
    assert.equal(pure.ok,true,JSON.stringify(pure))
    const scopes=db.prepare('SELECT scope_id FROM dsh_managed_scopes ORDER BY created_at DESC').all<{scope_id:string}>()
    const pureSnapshot=new ManagedOperationJournal(db).snapshot(scopes[0]!.scope_id)
    assert.equal(pureSnapshot.complete,true);assert.equal(pureSnapshot.operations.length,0)
  }finally{await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})

test('a human abandonment is the only way out of RECONCILIATION_REQUIRED and then Lisp becomes usable again',async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'managed-abandon-'))),root=join(base,'work')
  await mkdir(root)
  const db=new NodeSqliteAdapter(join(base,'db'),new DatabaseSync(join(base,'db')))
  const owner={sessionId:'abandon-session',agentId:'abandon-agent',root}
  workingLispTask(db,owner)
  const manager=new LispManager({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),
    config:LispConfig.parse({enabled:true,executionMode:'development',startupTimeoutMs:60000}),toolCall:async()=>{throw new Error('no native calls expected')}})
  try{
    await manager.start();await manager.enable(owner)
    const journal=new ManagedOperationJournal(db)
    const scope=journal.createScope({sessionId:owner.sessionId,parentId:'job-that-vanished',runtimeIdentity:'sbcl:current'})
    const operation=journal.prepare(scope.scopeId,{route:'native',kind:'process',request:{program:'orphan'}})
    journal.claim(operation.operationId);journal.transition(operation.operationId,{state:'unknown',cause:'timeout'});journal.seal(scope.scopeId)
    const blocked=await manager.recover(owner) as any
    assert.equal(blocked.code,'RECONCILIATION_REQUIRED')
    assert.equal(blocked.managedOperations[0].id,operation.operationId)
    // Abandoning without inspected evidence must be refused.
    await assert.rejects(manager.abandonManaged(owner,operation.operationId,''),/照合した内容を evidence として指定してください/u)
    const abandoned=await manager.abandonManaged(owner,operation.operationId,'Inspected the listed job: no live process, no queued work, target file untouched.') as any
    assert.equal(abandoned.ok,true)
    assert.equal(abandoned.operation.state,'abandoned')
    assert.equal(journal.readOperation(operation.operationId).state,'abandoned')
    // The blocking condition is gone: recovery now starts a fresh worker.
    const recovered=await manager.recover(owner) as any
    assert.notEqual(recovered.code,'RECONCILIATION_REQUIRED')
    assert.equal((await manager.status(owner) as any).managedReconciliationRequired,false)
    // A later effect is permitted again.
    const usable=await manager.execute(owner,'lisp_eval',{operationId:'after-human-abandonment',code:'(+ 41 1)'}) as any
    assert.equal(usable.ok,true,JSON.stringify(usable))
  }finally{await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})

test('session admission after manager restart recovers orphan native dispatch before permitting any further effect',async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'managed-restart-'))),root=join(base,'work'),path=join(base,'db')
  await mkdir(root)
  let db=new NodeSqliteAdapter(path,new DatabaseSync(path))
  const owner={sessionId:'restart-session',agentId:'restart-agent',root}
  workingLispTask(db,owner)
  const options=()=>({store:new LispStore(async fn=>fn(db)),dataRoot:join(base,'runtime'),config:LispConfig.parse({enabled:true,executionMode:'development'})})
  let manager=new LispManager(options())
  try{
    await manager.start()
    const journal=new ManagedOperationJournal(db),scope=journal.createScope({sessionId:owner.sessionId,parentId:'orphaned-eval',runtimeIdentity:'sbcl:crashed-worker'})
    const operation=journal.prepare(scope.scopeId,{route:'native',kind:'process',request:{program:'unknown-process'}})
    assert.equal(journal.claim(operation.operationId),true)
    await new LispStore(async fn=>fn(db)).enable(owner)
    await manager.dispose();db.close()
    db=new NodeSqliteAdapter(path,new DatabaseSync(path));manager=new LispManager(options());await manager.start()
    assert.equal(new ManagedOperationJournal(db).readOperation(operation.operationId).state,'dispatching','host startup alone cannot recover an unclaimed session')
    const status=await manager.prepare(owner) as any
    assert.equal(new ManagedOperationJournal(db).readOperation(operation.operationId).state,'unknown')
    assert.equal(status.state,'RECONCILIATION_REQUIRED')
    assert.equal(status.managedOperations[0].id,operation.operationId)
    const recovered=await manager.recover(owner) as any
    assert.equal(recovered.code,'RECONCILIATION_REQUIRED')
    assert.equal((await manager.diagnostics(owner,operation.operationId) as any).state,'unknown')
    // An old unknown must not disappear from recovery decisions when newer
    // unresolved records push it outside the bounded diagnostic page.
    const reopenedJournal=new ManagedOperationJournal(db)
    const newer=reopenedJournal.createScope({sessionId:owner.sessionId,parentId:'newer-pending',runtimeIdentity:'sbcl:newer-worker'})
    for(let index=0;index<101;index++) reopenedJournal.prepare(newer.scopeId,{route:'native',kind:'process',request:{index}})
    const pagedStatus=await manager.status(owner) as any
    assert.equal(pagedStatus.managedOperations.length,100)
    assert.equal(pagedStatus.managedOperations.some((item:any)=>item.id===operation.operationId),false)
    assert.equal(pagedStatus.managedUnknownOperations[0].id,operation.operationId,'compact status retains the exact old unknown beyond the ordinary diagnostic page')
    assert.equal(pagedStatus.managedOperationCount,102)
    assert.equal(pagedStatus.managedOperationsTruncated,true)
    assert.equal(pagedStatus.state,'RECONCILIATION_REQUIRED')
    assert.equal(pagedStatus.managedReconciliationRequired,true)
    const pagedRecovery=await manager.recover(owner) as any
    assert.equal(pagedRecovery.code,'RECONCILIATION_REQUIRED')
    assert.equal(pagedRecovery.managedOperationCount,102)
    assert.equal(pagedRecovery.managedOperationsTruncated,true)
    const next=new ManagedOperationJournal(db).createScope({sessionId:owner.sessionId,parentId:'new-eval',runtimeIdentity:'sbcl:new-worker'})
    const {runManagedOperation}=await import('../../../../src/dsh/managed-operation-runner.js')
    let dispatched=0
    await assert.rejects(runManagedOperation({database:async fn=>fn(db),scopeId:next.scopeId},
      {route:'native',kind:'process',request:{program:'replacement'}},async()=>{dispatched++;return {}}),/reconciliation/)
    assert.equal(dispatched,0)
    new ManagedOperationJournal(db).seal(next.scopeId)
    assert.equal(new ManagedOperationJournal(db).snapshot(next.scopeId).complete,false)
  }finally{await manager.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
