import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { ManagedOperationJournal } from '../../../src/dsh/managed-operation-journal.js'
import { runManagedOperation, ManagedDispatchDenied, currentManagedOperation, observeManagedResult } from '../../../src/dsh/managed-operation-runner.js'

function fixture(t: any) {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  db.exec(readFileSync(new URL('../../../migrations/047_managed_operation_journal.sql', import.meta.url), 'utf8'))
  t.after(() => db.close())
  const journal = new ManagedOperationJournal(db)
  const scope = journal.createScope({sessionId:'s',parentId:'host-evaluation',runtimeIdentity:'test-runtime'})
  return {journal, db, scope: {scopeId:scope.scopeId,database:async <T>(fn: (db: NodeSqliteAdapter)=>T)=>fn(db)}}
}
const input = {route:'native' as const,kind:'process' as const,request:{program:'echo',argv:['secret-argv'],stdin:'secret-stdin',env:{TOKEN:'secret-env'}}}

test('dispatch is durable before effect, nested owned boundary is one operation, final 42 cannot erase it', async t => {
  const {journal,scope,db} = fixture(t)
  const evaluate = async () => {
    await runManagedOperation(scope,input,async () => {
      const active = currentManagedOperation()!
      assert.equal(journal.readOperation(active.operationId).state,'dispatching')
      return runManagedOperation(scope,{...input,route:'owned'},async () => ({code:0,stdout:'secret-output',receipt:{route:'native',processStopped:true}}))
    })
    return 42
  }
  assert.equal(await evaluate(),42)
  journal.seal(scope.scopeId)
  const snapshot = journal.snapshot(scope.scopeId)
  assert.equal(snapshot.operations.length,1)
  assert.equal(snapshot.operations[0]!.outcome,'succeeded')
  assert.equal(snapshot.complete,true)
  assert.doesNotMatch(JSON.stringify(snapshot),/secret-(argv|stdin|env|output)/)
})

test('denial is terminal, timeout without stop proof remains unresolved and is not retried', async t => {
  const {journal,scope} = fixture(t)
  let effects = 0
  await assert.rejects(runManagedOperation(scope,input,async () => {throw new ManagedDispatchDenied('No permission')}))
  await assert.rejects(runManagedOperation(scope,input,async () => {effects++;throw new Error('timeout; child still running')}))
  journal.seal(scope.scopeId)
  const snapshot = journal.snapshot(scope.scopeId)
  assert.deepEqual(snapshot.operations.map(op=>op.state),['denied','unknown'])
  assert.equal(snapshot.complete,false)
  assert.equal(effects,1)
})

test('journal admission storage failure prevents dispatch', async t => {
  const {scope,db} = fixture(t)
  db.exec('DROP TABLE dsh_managed_operations')
  let effects = 0
  await assert.rejects(runManagedOperation(scope,input,async () => {effects++;return {}}))
  assert.equal(effects,0)
})

test('late owned completion reconciles only its linked original after collection seal', async t => {
  const {journal,scope} = fixture(t)
  let active!: NonNullable<ReturnType<typeof currentManagedOperation>>
  await runManagedOperation(scope,{...input,route:'owned'},async () => {
    active=currentManagedOperation()!
    journal.attachOriginalRef(active.operationId,'owned-operation')
    return {receipt:{operationId:'owned-operation',state:'started'}}
  })
  journal.seal(scope.scopeId)
  const before=journal.snapshot(scope.scopeId)
  assert.equal(before.complete,false)
  await observeManagedResult(active,{code:0,receipt:{operationId:'owned-operation',state:'completed',processStopped:true}})
  assert.equal(journal.snapshot(scope.scopeId).complete,true)
  assert.equal(before.complete,false)
})

test('owned child has one canonical original and mirrors late completion to its evaluation bridge parent',async t=>{
  const {journal,scope}=fixture(t)
  let dispatches=0
  let child!:NonNullable<ReturnType<typeof currentManagedOperation>>
  let childScopeId=''
  await runManagedOperation(scope,{...input,route:'owned'},async()=>{
    const parent=currentManagedOperation()!
    childScopeId=journal.createScope({sessionId:'s',parentId:parent.operationId,runtimeIdentity:'owned-test'}).scopeId
    await runManagedOperation({...scope,scopeId:childScopeId,nested:true,parentOperation:parent},
      {...input,route:'owned',originalRef:'canonical-owned-id'},async()=>{
        child=currentManagedOperation()!;dispatches++
        return {receipt:{operationId:'canonical-owned-id',state:'started'}}
      })
    return 'canonical-owned-id'
  })
  journal.seal(scope.scopeId);journal.seal(childScopeId)
  assert.equal(journal.snapshot(scope.scopeId).complete,false)
  await observeManagedResult(child,{code:0,receipt:{operationId:'canonical-owned-id',state:'completed',processStopped:true}})
  assert.equal(journal.snapshot(scope.scopeId).complete,true)
  assert.equal(journal.snapshot(childScopeId).complete,true)
  assert.equal(dispatches,1)
  assert.equal(journal.lookupOriginalOperation('canonical-owned-id')!.operationId,child.operationId)
  assert.equal(journal.snapshot(scope.scopeId).operations[0]!.originalRef,undefined,'parent is an explicit bridge reference, not a second owned original')
})

test('confirmed prelaunch cancellation is not misreported as a stopped previously-running process',async t=>{
  const {journal,scope}=fixture(t)
  await runManagedOperation(scope,{...input,route:'owned'},async()=>({receipt:{state:'completed',cancelled:true,processStarted:false,processStopped:true}}))
  assert.equal(journal.snapshot(scope.scopeId).operations[0]!.state,'cancelled-before-dispatch')
})
