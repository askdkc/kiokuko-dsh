import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, createRun } from '../integration/evolution/fixture.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { MemoryIndexReasoningConfig } from '../../../src/memory/index-reasoning/contracts.js'
import { IndexReasoningService } from '../../../src/memory/index-reasoning/service.js'
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'

const workspace = 'project:test'
const envelope = { provider: 'fixture', model: 'fixed', contextWindow: 131072 }
const requiredReview = { recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' }
// These retired entry points cannot save even for a trusted native conversation.
// Positive native questions, revision-specific approval, decline and keyword
// retrieval are exercised by integration/replay-memory-review.test.ts.
for (const mode of ['active','observe','off'] as const)test(`${mode} conversation admission does not dispatch or persist memory bookkeeping`,async()=>{
 const {db,runtime}=fixture();let calls=0,identityChecks=0
 for(const [index,body] of ['Widget uses SQLite.','SQLite uses a write lock.'].entries())recordEntry(db,{workspace,kind:'fact',title:`Historical source ${index}`,body,scope:{visibility:'project'},createdBy:'fixture'})
 const service=new IndexReasoningService(runtime,MemoryIndexReasoningConfig.parse({mode}),{async *stream(){calls++;throw new Error('unapproved indexing')}})
 try{
  const writes=db.prepare('SELECT total_changes() AS n').get()?.n
  await service.start();await service.admitConversation(workspace,'conversation',envelope,()=>{identityChecks++;return true})
  await service.whenIdle()
  assert.equal(calls,0);assert.equal(identityChecks,0,'retired admission must not create an execution prerequisite')
  for(const table of ['memory_index_settings','memory_index_jobs','memory_index_facts','ledger_runs','dsh_memory_finalizations'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,0,table)
  assert.deepEqual(await service.indexCommand('conversation','status --json'),requiredReview)
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n,writes)
 }finally{await service.dispose();db.close()}
})
test('missing memory storage never blocks native conversation or ledger admission',async()=>{
 let reads=0,checks=0
 const service=new IndexReasoningService({withDatabase:async()=>{reads++;throw new Error('memory unavailable')}},MemoryIndexReasoningConfig.parse({}))
 try{
  await service.start();await service.admitIndex(workspace,'conversation',envelope)
  await service.admitConversation(workspace,'conversation',envelope,()=>{checks++;return false})
  assert.deepEqual(await service.indexCommand('conversation','mode active'),requiredReview)
  await service.whenIdle();assert.equal(reads,0);assert.equal(checks,0)
 }finally{await service.dispose()}
})
test('legacy commands cannot authorize writes through stale, ambiguous or cross-workspace bindings',async()=>{
 const {db,runtime}=fixture(),service=new IndexReasoningService(runtime,MemoryIndexReasoningConfig.parse({mode:'off'}))
 try{
  createRun(db,'ledger','project:other')
  const writes=db.prepare('SELECT total_changes() AS n').get()?.n
  for(const session of ['conversation','ambiguous','session-ledger']){
   await service.admitConversation(workspace,session,envelope,()=>true)
   await service.admitConversation('project:other',session,envelope,()=>false)
   for(const command of ['status','mode active','mode observe','retry old','backfill'])assert.deepEqual(await service.indexCommand(session,command),requiredReview)
  }
  await service.dispose();assert.deepEqual(await service.indexCommand('retired','status'),requiredReview)
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n,writes)
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_jobs').get()?.n,0)
 }finally{await service.dispose();db.close()}
})
test('memory finalizer startup never forwards conversation indexing or creates a memory job',async()=>{
 const {db,runtime}=fixture(),finalizer=new DshMemoryFinalizer({runtime,memoryIndexReasoning:MemoryIndexReasoningConfig.parse({mode:'active'}),autoGlobalizationEnabled:true})
 try{
  const writes=db.prepare('SELECT total_changes() AS n').get()?.n
  await finalizer.start();await finalizer.admitConversationIndex(workspace,'conversation',envelope,()=>true)
  await finalizer.admitIndex(workspace,'conversation',envelope);finalizer.kick();await finalizer.whenIdle()
  assert.deepEqual(await finalizer.indexCommand('conversation','status --json'),requiredReview)
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n,writes)
  assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n,0)
 }finally{await finalizer.dispose();db.close()}
})
