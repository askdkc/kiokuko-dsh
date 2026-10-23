import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase} from '../../../src/db/migrate.js'
import {ManagedOperationJournal,canonicalJournalRequest} from '../../../src/dsh/managed-operation-journal.js'
import type {SqliteDatabase} from '../../../src/db/adapter.js'
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'managed-journal-')),path=join(root,'db.sqlite');let db=openConnection(path);migrateDatabase(db)
 return {get db(){return db},get journal(){return new ManagedOperationJournal(db)},reopen(){db.close();db=openConnection(path)},close(){db.close();rmSync(root,{recursive:true,force:true})}}
}
const input={sessionId:'session',parentId:'eval',runtimeIdentity:'sbcl-test'}
const request={program:'echo',argv:['SECRET'],cwd:'/work',timeout:100,stdin:'PRIVATE',env:{KEY:'HIDDEN'}}
function prepared(j:ManagedOperationJournal){const scope=j.createScope(input);return {scope,op:j.prepare(scope.scopeId,{route:'native',kind:'process',request})}}
test('host IDs, typed canonical request, keyed private digest and no raw secrets',()=>{
 const f=fixture();try{const j=f.journal,{scope,op}=prepared(j)
 assert.match(op.operationId,/^[0-9a-f-]{36}$/);assert.notEqual(scope.scopeId,op.operationId)
 assert.equal(canonicalJournalRequest({a:1,b:2}),canonicalJournalRequest({b:2,a:1}))
 for(const value of [{}, {x:undefined},{x:null},{x:''},{x:[]},{x:0}]) for(const other of [{x:'0'},{x:false}]) assert.notEqual(canonicalJournalRequest(value),canonicalJournalRequest(other))
 assert.equal(j.claim(op.operationId,request),true);assert.equal(j.claim(op.operationId,request),false)
 assert.throws(()=>j.claim(op.operationId,{...request,stdin:''}),/mismatch/)
 const rows=f.db.prepare('SELECT operation_json FROM dsh_managed_operations').all()
 assert(!JSON.stringify(rows).includes('SECRET'));assert(!JSON.stringify(rows).includes('PRIVATE'));assert(!JSON.stringify(rows).includes('HIDDEN'))
 }finally{f.close()}
})
test('durable claim survives restart; unknown never authorizes replay or success',()=>{
 const f=fixture();try{let j=f.journal;const {scope,op}=prepared(j);assert(j.claim(op.operationId));f.reopen();j=f.journal
 assert.equal(j.claim(op.operationId),false);j.recover(scope.scopeId);assert.equal(j.readOperation(op.operationId).state,'unknown')
 assert.throws(()=>j.transition(op.operationId,{state:'completed',outcome:'succeeded'}),/reconciliation/)
 j.seal(scope.scopeId);const before=j.snapshot(scope.scopeId);assert.equal(before.complete,false)
 j.reconcile(op.operationId,{state:'completed',outcome:'failed',receiptRef:'host-observed-receipt'})
 const after=j.snapshot(scope.scopeId);assert.equal(after.complete,true);assert.equal(after.operations[0]!.outcome,'failed')
 assert.equal(j.readSnapshot(before.snapshotId).complete,false);assert.equal(j.readSnapshot(before.snapshotId).operations[0]!.state,'unknown')
 assert(Object.isFrozen(after.operations[0]));assert.throws(()=>j.transition(op.operationId,{state:'completed',outcome:'succeeded'}))
 }finally{f.close()}
})
test('sealed zero is complete, open/failed collectors are not; seal prevents new dispatch',()=>{
 const f=fixture();try{const j=f.journal,scope=j.createScope(input);assert.equal(j.snapshot(scope.scopeId).complete,false)
 j.seal(scope.scopeId);assert.equal(j.snapshot(scope.scopeId).complete,true)
 assert.throws(()=>j.prepare(scope.scopeId,{route:'native',kind:'process',request}),/sealed/)
 const b=prepared(j);j.seal(b.scope.scopeId);assert.equal(j.claim(b.op.operationId),false);assert.equal(j.snapshot(b.scope.scopeId).complete,false)
 const c=j.createScope(input);j.markIncomplete(c.scopeId);j.seal(c.scopeId);assert.equal(j.snapshot(c.scopeId).complete,false)
 }finally{f.close()}
})
test('timeout does not assert termination and cannot be converted to denial',()=>{
 const f=fixture();try{const j=f.journal,{scope,op}=prepared(j);j.claim(op.operationId);j.transition(op.operationId,{state:'running'})
 assert.throws(()=>j.transition(op.operationId,{state:'denied'}));j.transition(op.operationId,{state:'unknown',cause:'timeout'});j.seal(scope.scopeId)
 assert.equal(j.snapshot(scope.scopeId).unresolved,1);assert.equal(j.claim(op.operationId),false)
 }finally{f.close()}
})
test('mixed routes and reversed completion retain sequence; original refs are unique',()=>{
 const f=fixture();try{const j=f.journal,{scope,op}=prepared(j),b=j.prepare(scope.scopeId,{route:'owned',kind:'file',request:{path:'a'}})
 j.claim(op.operationId);j.claim(b.operationId);j.attachOriginalRef(b.operationId,'owned-id')
 assert.throws(()=>j.attachOriginalRef(op.operationId,'owned-id'));assert.equal(j.lookupOriginalOperation('owned-id')!.operationId,b.operationId)
 j.transition(b.operationId,{state:'completed',outcome:'succeeded',receiptRef:'receipt'});j.transition(op.operationId,{state:'completed',outcome:'failed'});j.seal(scope.scopeId)
 const snap=j.snapshotForOriginal('owned-id');assert.equal(snap.complete,true);assert.deepEqual(snap.operations.map(x=>x.route),['native','owned'])
 }finally{f.close()}
})
test('capacity blocks admission and retained snapshots protect originals from expiry',()=>{
 const f=fixture();try{const j=new ManagedOperationJournal(f.db,{maxOperationsPerScope:1,maxRequestBytes:10000,retentionMs:1}),{scope,op}=prepared(j)
 assert.throws(()=>j.prepare(scope.scopeId,{route:'owned',kind:'file',request}),/capacity/)
 j.transition(op.operationId,{state:'cancelled-before-dispatch'});j.seal(scope.scopeId);const snap=j.snapshot(scope.scopeId);j.retainSnapshot(snap.snapshotId)
 assert.equal(j.prune(Date.now()+10000),0);assert.equal(j.readOperation(op.operationId).state,'cancelled-before-dispatch')
 const second=j.createScope(input);j.seal(second.scopeId);assert.equal(j.prune(Date.now()+10000),1)
 }finally{f.close()}
})
test('injected persistence faults before prepare/claim and result save cannot duplicate execution',()=>{
 for(const fragment of ['INSERT INTO dsh_managed_operations','UPDATE dsh_managed_operations']){
 const f=fixture();try{
  let enabled=false;const db:SqliteDatabase={filePath:f.db.filePath,exec:s=>f.db.exec(s),close:()=>{},prepare:s=>{if(enabled&&s.startsWith(fragment))throw new Error('injected persistence fault');return f.db.prepare(s)}}
  const j=new ManagedOperationJournal(db),scope=j.createScope(input);let dispatches=0
  if(fragment.startsWith('INSERT')){enabled=true;assert.throws(()=>{const op=j.prepare(scope.scopeId,{route:'native',kind:'process',request});if(j.claim(op.operationId))dispatches++});assert.equal(dispatches,0)}
  else {const op=j.prepare(scope.scopeId,{route:'native',kind:'process',request});enabled=true;assert.throws(()=>{if(j.claim(op.operationId))dispatches++});assert.equal(dispatches,0)
   enabled=false;if(j.claim(op.operationId))dispatches++;enabled=true;assert.throws(()=>j.transition(op.operationId,{state:'completed',outcome:'succeeded'}));enabled=false
   assert.equal(dispatches,1);assert.equal(j.claim(op.operationId),false);j.recover(scope.scopeId);assert.equal(j.readOperation(op.operationId).state,'unknown')}
 }finally{f.close()}}
})
test('independent connections cannot reclaim and seal linearizes admission',()=>{
 const f=fixture(),other=openConnection(f.db.filePath);try{
  const a=f.journal,b=new ManagedOperationJournal(other),{scope,op}=prepared(a)
  assert.equal(a.claim(op.operationId),true);assert.equal(b.claim(op.operationId),false)
  const second=a.prepare(scope.scopeId,{route:'owned',kind:'file',request:{file:'x'}})
  b.seal(scope.scopeId);assert.equal(a.claim(second.operationId),false)
  assert.throws(()=>a.prepare(scope.scopeId,{route:'native',kind:'process',request}),/sealed/)
  assert.equal(b.snapshot(scope.scopeId).operations.length,2)
 }finally{other.close();f.close()}
})
test('CAS append failure rolls back claim and never authorizes dispatch',()=>{
 const f=fixture();try{
  let enabled=false
  const proxy:SqliteDatabase={filePath:f.db.filePath,close:()=>{},exec:s=>f.db.exec(s),prepare:s=>{if(enabled&&s.startsWith('INSERT INTO dsh_managed_transitions'))throw new Error('append fault');return f.db.prepare(s)}}
  const j=new ManagedOperationJournal(proxy),{op}=prepared(j);enabled=true
  assert.throws(()=>j.claim(op.operationId),/append fault/);assert.equal(j.readOperation(op.operationId).state,'prepared')
  enabled=false;assert.equal(j.claim(op.operationId),true)
 }finally{f.close()}
})
test('host identity cannot be overwritten by forged transition fields or invalid outcomes',()=>{
 const f=fixture();try{const j=f.journal,{op}=prepared(j);j.claim(op.operationId)
 assert.throws(()=>j.transition(op.operationId,{state:'completed',outcome:'succeeded',operationId:'forged'} as never))
 assert.throws(()=>j.transition(op.operationId,{state:'completed'}))
 assert.throws(()=>j.transition(op.operationId,{state:'unknown',outcome:'succeeded'}))
 assert.equal(j.readOperation(op.operationId).state,'dispatching')
 }finally{f.close()}
})
test('snapshot failure leaves durable operation evidence and never issues invented success',()=>{
 const f=fixture();try{
 const base=f.journal,{scope,op}=prepared(base);base.claim(op.operationId);base.transition(op.operationId,{state:'completed',outcome:'succeeded'});base.seal(scope.scopeId)
 const proxy:SqliteDatabase={filePath:f.db.filePath,close:()=>{},exec:s=>f.db.exec(s),prepare:s=>{if(s.startsWith('INSERT INTO dsh_managed_snapshots'))throw new Error('snapshot fault');return f.db.prepare(s)}}
 assert.throws(()=>new ManagedOperationJournal(proxy).snapshot(scope.scopeId),/snapshot fault/)
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dsh_managed_snapshots').get()!.n,0)
 assert.equal(base.readOperation(op.operationId).state,'completed')
 }finally{f.close()}
})
test('host can bind authority at reservation without rewriting evaluation scope or prior snapshot',()=>{
 const f=fixture();try{const j=f.journal,{scope,op}=prepared(j);j.claim(op.operationId);const old=j.snapshot(scope.scopeId)
 const binding={taskId:'task',unitId:'unit',workerGeneration:'worker-4',protocolBindGeneration:3,leaseAuthorityGeneration:8,leaseRevision:20}
 j.bindOperation(op.operationId,{binding,runtimeIdentity:'protocol-runtime'})
 assert.deepEqual(j.readOperation(op.operationId).binding,binding);assert.equal(j.readScope(scope.scopeId).binding,undefined)
 assert.equal(j.readSnapshot(old.snapshotId).operations[0]!.binding,undefined)
 assert.throws(()=>j.bindOperation(op.operationId,{binding:{...binding,leaseAuthorityGeneration:9},runtimeIdentity:'protocol-runtime'}))
 j.transition(op.operationId,{state:'completed',outcome:'succeeded'})
 assert.throws(()=>j.bindOperation(op.operationId,{binding,runtimeIdentity:'protocol-runtime'}))
 }finally{f.close()}
})
test('failed oversized admission cannot later masquerade as pure zero execution',()=>{
 const f=fixture();try{const j=new ManagedOperationJournal(f.db,{maxRequestBytes:20}),scope=j.createScope(input)
 assert.throws(()=>j.prepare(scope.scopeId,{route:'native',kind:'process',request}),/capacity/)
 j.seal(scope.scopeId);const snapshot=j.snapshot(scope.scopeId);assert.equal(snapshot.operations.length,0);assert.equal(snapshot.collectorComplete,false);assert.equal(snapshot.complete,false)
 }finally{f.close()}
})
test('direct sole-operation scope can bind protocol; mixed scope cannot be relabelled',()=>{
 const f=fixture();try{const j=f.journal,{scope,op}=prepared(j);j.claim(op.operationId)
 const binding={taskId:'task',unitId:'unit',workerGeneration:'worker',protocolBindGeneration:1,leaseAuthorityGeneration:2,leaseRevision:3}
 j.bindOperation(op.operationId,{binding,runtimeIdentity:'protocol',bindScope:true});assert.deepEqual(j.readScope(scope.scopeId).binding,binding)
 const second=prepared(j);j.claim(second.op.operationId);j.prepare(second.scope.scopeId,{route:'owned',kind:'file',request:{path:'a'}})
 assert.throws(()=>j.bindOperation(second.op.operationId,{binding,runtimeIdentity:'protocol',bindScope:true}))
 }finally{f.close()}
})
test('uncertain claim commit cannot authorize execution or be reclaimed after restart',()=>{
 const f=fixture();try{
  let failCommit=false
  const proxy:SqliteDatabase={filePath:f.db.filePath,close:()=>{},prepare:s=>f.db.prepare(s),exec:s=>{
   f.db.exec(s);if(s==='COMMIT'&&failCommit){failCommit=false;throw new Error('connection lost after commit')}
  }}
  const j=new ManagedOperationJournal(proxy),{scope,op}=prepared(j);failCommit=true;let dispatched=0
  assert.throws(()=>{if(j.claim(op.operationId))dispatched++},/uncertain/)
  assert.equal(dispatched,0);f.reopen();const after=f.journal;assert.equal(after.claim(op.operationId),false)
  after.recover(scope.scopeId);assert.equal(after.readOperation(op.operationId).state,'unknown')
 }finally{f.close()}
})
test('retained child proof preserves linked parent audit through expiry',()=>{
 const f=fixture();try{const j=new ManagedOperationJournal(f.db,{retentionMs:1}),parent=prepared(j)
 j.claim(parent.op.operationId);j.transition(parent.op.operationId,{state:'completed',outcome:'succeeded'});j.seal(parent.scope.scopeId)
 const child=j.createScope({...input,parentId:parent.op.operationId}),op=j.prepare(child.scopeId,{route:'owned',kind:'process',request})
 j.claim(op.operationId);j.transition(op.operationId,{state:'completed',outcome:'succeeded'});j.seal(child.scopeId)
 j.retainSnapshot(j.snapshot(child.scopeId).snapshotId)
 assert.equal(j.prune(Date.now()+10000),0);assert.equal(j.readOperation(parent.op.operationId).state,'completed')
 }finally{f.close()}
})
