import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, createRun, NOW } from './evolution/fixture.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { adoptMemories } from '../../../src/memory/review/adoption.js'
import { explainMemory } from '../../../src/memory/explain.js'
import { ReviewResultV2 } from '../../../src/memory/review/contracts.js'

const text='今回だけPythonを使う。実験は未実施で、前回は失敗した。'
function source() { const role='user_assertion' as const,sourceSeqs=[3]; return {id:'e:3',role,sourceSeqs,text,normalizedSourceHash:canonicalContentHash({role,sourceSeqs,text}),eligibleForNewMemory:true} }
function operation(quote=text) {return ReviewResultV2.parse({schemaVersion:2,proposals:[{action:'add',kind:'decision',title:'実験',body:text,evidenceIds:['e:3'],claims:[{id:'experiment',text,evidence:[{evidenceId:'e:3',supportingText:quote}]}]}]}).proposals[0]!}
function adopt(quote=text,eligible=true) {
 const f=fixture();createRun(f.db,'evidence')
 const result=withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id:'job',range:{workspace:'project:test',sessionId:'session-evidence',runId:'evidence',sourceGeneration:'generation',startSeq:1,endSeq:4},evidence:[{...source(),eligibleForNewMemory:eligible}],existing:[],operations:[operation(quote)],observe:false,now:NOW}))
 return {...f,result}
}
test('cited memory preserves conditions and exposes source identity without proving truth',()=>{
 const f=adopt();try {
  assert.equal(f.result.added,1)
  const e=f.result.entries[0]!,view=explainMemory(f.db,{workspace:e.workspace,entryId:e.id})
  assert.equal(view.body,text);assert.equal(view.evidenceStatus,'source_attached');assert.equal(view.claims[0]!.sources[0]!.supportingText,text)
  assert.equal(view.semanticVerification,'not_proven')
  assert.throws(()=>explainMemory(f.db,{workspace:'other',entryId:e.id}))
 }finally{f.db.close()}
})
test('altered excerpts and context-only evidence hold the operation without saving a body',()=>{
 for(const [quote,eligible] of [['always use Python',true],[text,false]] as const){const f=adopt(quote,eligible);try {
  assert.equal(f.result.held,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_revision_evidence').get()?.n,0)
 }finally{f.db.close()}}
})

import { forgetMemory } from '../../../src/memory/forget.js'
import { searchEntries } from '../../../src/memory/retrieval.js'
test('forget erases excerpts and bodies, fences source replay and supports exact retry',()=>{
 const f=adopt();try {
  const e=f.result.entries[0]!,input={workspace:e.workspace,entryId:e.id,expectedRevision:e.revision,operationId:'forget-1'}
  assert.throws(()=>forgetMemory(f.db,{...input,expectedRevision:2}))
  const result=forgetMemory(f.db,input)
  assert.equal(result.count,1);assert.deepEqual(forgetMemory(f.db,input),result)
  assert.throws(()=>explainMemory(f.db,{workspace:e.workspace,entryId:e.id}))
  assert.equal(searchEntries(f.db,{workspace:e.workspace,query:'Python'}).items.length,0)
  assert.equal(f.db.prepare('SELECT body FROM entry_revisions WHERE entry_id=?').get(e.id)?.body,'[forgotten]')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_revision_evidence').get()?.n,0)
  const replay=withImmediateTransaction(f.db,()=>adoptMemories(f.db,{id:'later-job',range:{workspace:e.workspace,sessionId:'session-evidence',runId:'evidence',sourceGeneration:'generation',startSeq:1,endSeq:4},evidence:[source()],existing:[],operations:[operation()],observe:false,now:NOW}))
  assert.equal(replay.held,1);assert.equal(replay.added,0)
 }finally{f.db.close()}
})

import { readEntry, recordEntry } from '../../../src/memory/entries.js'
import { memorySnapshots } from '../../../src/memory/review/adoption.js'
import { configureIndex, reserveIndexJob, saveIndexFact } from '../../../src/memory/index-reasoning/store.js'
import { IndexReasoningWorker } from '../../../src/memory/index-reasoning/worker.js'
import { MemoryIndexReasoningConfig } from '../../../src/memory/index-reasoning/contracts.js'
import { seed as createEpisode } from './evolution/fixture.js'
import { saveLesson, scheduleEvolution } from '../../../src/memory/evolution/store.js'
import { currentContextMemory, filterRequestMemory } from '../../../src/dsh/request-memory.js'
import { projectMemoryEntry } from '../../../src/context/memory-projection.js'
import { ensureGlobalWorkspace } from '../../../src/memory/workspaces.js'
import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hybridSearch } from '../../../src/memory/hybrid-retrieval.js'

test('restart and a different run/generation cannot replay the source, but independent speech is allowed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memory-forget-restart-')),path=join(dir,'state.sqlite3')
 const first=fixture(path);createRun(first.db,'evidence')
 const root=apply(first.db,'original',[operation()]).entries[0]!
 const receipt=retire(first.db,root);first.db.close()
 const next=fixture(path)
 try{
   createRun(next.db,'different-run')
   assert.deepEqual(forgetMemory(next.db,{workspace:root.workspace,entryId:root.id,expectedRevision:1,operationId:'restart-retry'}),receipt)
   assert.equal(apply(next.db,'backfill',[operation()],[source()],{runId:'different-run',sourceGeneration:'new-generation'}).held,1)
   const backend={id:'stale',search(){return [{entryId:root.id,distance:0}]}}
   assert.equal(hybridSearch(next.db,{workspace:root.workspace,query:'Python',limit:10,includeSuperseded:true},{semantic:{backend,query:{profileId:'fixture',dimensions:2,vector:new Float32Array([1,0]),vectorHash:'hash',backendId:'stale',distanceCeiling:0.9}}}).length,0)
   assert.equal(apply(next.db,'new-speech',[operation()],[source()],{runId:'different-run',sessionId:'independent-session',sourceGeneration:'independent-generation'}).added,1)
   assert.deepEqual(next.db.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{next.db.close();await rm(dir,{recursive:true,force:true})}
})

const range={workspace:'project:test',sessionId:'session-evidence',runId:'evidence',sourceGeneration:'generation',startSeq:1,endSeq:4}
function apply(db: ReturnType<typeof fixture>['db'], id: string, operations: unknown[], evidence=[source()], changes={}) {
  return withImmediateTransaction(db,()=>adoptMemories(db,{id,range:{...range,...changes},evidence,existing:memorySnapshots(db,{...range,...changes},'実験').existing,
    operations:operations as Parameters<typeof adoptMemories>[1]['operations'],observe:false,now:NOW}))
}
function retire(db: ReturnType<typeof fixture>['db'], entry: {id:string;workspace:string;revision:number}) {
  return forgetMemory(db,{workspace:entry.workspace,entryId:entry.id,expectedRevision:entry.revision,operationId:`forget-${entry.id}`})
}
test('multiple claims retain their own original sources when only one claim is corrected',()=>{
  const f=fixture();createRun(f.db,'evidence')
  try {
    const a='今回だけPythonを使う。', b='実験は未実施で、前回は失敗した。'
    const first=apply(f.db,'multi',[{...operation(),body:`${a}\n\n${b}`,claims:[{id:'language',text:a,evidence:[{evidenceId:'e:3',supportingText:a}]},{id:'experiment',text:b,evidence:[{evidenceId:'e:3',supportingText:b}]}]}]).entries[0]!
    const c='実験を実施したが、今回も失敗した。'
    const newer={...source(),id:'e:8',text:c,sourceSeqs:[8],normalizedSourceHash:canonicalContentHash({role:'user_assertion',sourceSeqs:[8],text:c})}
    const update={action:'update',targetEntryId:first.id,expectedRevision:1,expectedContentHash:first.contentHash,kind:first.kind,title:first.title,body:`${a}\n\n${c}`,evidenceIds:['e:8'],
      claims:[{id:'language',text:a,evidence:[],inherits:{revision:1,claimId:'language'}},{id:'experiment',text:c,evidence:[{evidenceId:'e:8',supportingText:c}],supersedes:{revision:1,claimId:'experiment'}}]}
    const changed=apply(f.db,'correct',[update],[newer],{sessionId:'session-new',startSeq:5,endSeq:9})
    assert.equal(changed.updated,1)
    const view=explainMemory(f.db,{workspace:first.workspace,entryId:first.id})
    assert.equal(view.revision,2);assert.equal(view.claims[0]!.sources[0]!.sessionId,'session-evidence')
    assert.equal(view.claims[1]!.sources[0]!.sessionId,'session-new')
    assert.equal(view.claims[1]!.supersedes?.claimId,'experiment')
    assert.equal(view.history[0]!.claims[1]!.text,b)
    assert.equal(explainMemory(f.db,{workspace:first.workspace,entryId:first.id,revision:1}).body,`${a}\n\n${b}`)
    const bad={...update,expectedRevision:2,expectedContentHash:changed.entries[0]!.contentHash,claims:[{id:'changed',text:c,evidence:[{evidenceId:'e:8',supportingText:c}],supersedes:{revision:2,claimId:'missing'}}],body:c}
    assert.equal(apply(f.db,'ambiguous',[bad],[newer]).held,1)
  }finally{f.db.close()}
})
test('invalid IDs, changed hashes and secret excerpts cannot create evidence-backed memories',()=>{
  for(const failure of ['id','hash','secret'] as const){
    const f=fixture();createRun(f.db,'evidence')
    try {
      const e=source(),op=operation()
      if(failure==='hash')e.normalizedSourceHash='a'.repeat(64)
      if(failure==='id')op.evidenceIds=['outside']
      if(failure==='secret'){
        e.text='Authorization: Bearer fixturetokenabcdefghijklmnop';e.normalizedSourceHash=canonicalContentHash({role:e.role,sourceSeqs:e.sourceSeqs,text:e.text})
        if(op.action==='add'){op.body=e.text;op.claims= [{id:'secret',text:e.text,evidence:[{evidenceId:e.id,supportingText:e.text}]}]}
      }
      assert.equal(apply(f.db,failure,[op],[e]).held,1)
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,0)
    }finally{f.db.close()}
  }
})
test('a failed evidence write rolls back the body and its search/embedding queues',()=>{
  const f=fixture();createRun(f.db,'evidence')
  try {
    f.db.exec("CREATE TRIGGER reject_evidence BEFORE INSERT ON memory_revision_evidence BEGIN SELECT RAISE(ABORT,'fixture evidence write failure'); END")
    assert.equal(apply(f.db,'broken',[operation()]).held,1)
    for(const table of ['entries','entry_revisions','memory_index_sources','embedding_jobs','entry_search_documents'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,0,table)
  }finally{f.db.close()}
})
test('a bridge with two roots is erased as a whole and a retained request cannot inject it',()=>{
  const f=adopt();try {
    configureIndex(f.db,range.workspace,'active')
    const root=f.result.entries[0]!,other=recordEntry(f.db,{workspace:root.workspace,kind:'fact',title:'Python runtime',body:'Python supports this experiment.',scope:{visibility:'project'}})
    const fact=withImmediateTransaction(f.db,()=>saveIndexFact(f.db,root.workspace,{role:'bridge',text:'Python experiment evidence.',entities:[{type:'package',value:'Python'}],applicability:'今回だけ',
      sources:[root,other].map(e=>({entryId:e.id,revision:e.revision,contentHash:e.contentHash,supportingText:e.body}))}))
    assert.equal(explainMemory(f.db,{workspace:root.workspace,entryId:fact.id}).lineage.sources.find(s=>s.entryId===root.id)?.claims[0]?.id,'experiment')
    const snapshot={entryId:fact.id,revision:1,origin:'project' as const,...projectMemoryEntry(f.db,fact)!,score:0,scoreComponents:{} as never,selectionReasons:[],metadata:{storedData:true,untrusted:true,instructions:false} as const}
    assert.equal(currentContextMemory(f.db,root.workspace,[snapshot]).size,1)
    assert.equal(retire(f.db,root).count,2)
    assert.equal(currentContextMemory(f.db,root.workspace,[snapshot]).size,0)
    const owned={source:{kind:'plugin:kiokuko-dsh',form:'snapshot',sections:[{name:`memory:memory:${fact.id}`,text:'old'}]},content:[{type:'text',text:'old'}]}
    assert.equal(filterRequestMemory([owned],new Map()).length,0)
    assert.equal(searchEntries(f.db,{workspace:root.workspace,query:'Python'}).items.some(e=>e.id===fact.id),false)
    assert.equal(readEntry(f.db,{workspace:other.workspace,entryId:other.id}).body,other.body)
    assert.throws(()=>withImmediateTransaction(f.db,()=>saveIndexFact(f.db,root.workspace,{role:'atomic',text:root.body,entities:[{type:'package',value:'Python'}],applicability:null,sources:[{entryId:root.id,revision:1,contentHash:root.contentHash,supportingText:root.body}]})))
  }finally{f.db.close()}
})
test('forget fences a dispatched index worker, scrubs its snapshots and retains its usage ledger',async()=>{
  const f=adopt();let worker:IndexReasoningWorker|undefined
  let sent!:()=>void,release!:()=>void
  const dispatched=new Promise<void>(r=>{sent=r}),response=new Promise<void>(r=>{release=r})
  try {
    const root=f.result.entries[0]!
    configureIndex(f.db,root.workspace,'active')
    reserveIndexJob(f.db,root.workspace,{provider:'fixture',model:'fixed',contextWindow:131072,sessionId:'index-session'})
    worker=new IndexReasoningWorker({runtime:f.runtime,config:MemoryIndexReasoningConfig.parse({timeoutMs:3000}),llm:{async *stream(){sent();await response;yield {type:'text-delta',text:'[]'};yield {type:'finish',reason:{kind:'stop'}}}}})
    worker.kick();await dispatched
    retire(f.db,root);release();await worker.whenIdle()
    const row=f.db.prepare('SELECT state,input_json,drafts_json,peers_json FROM memory_index_jobs').get()
    assert.equal(row?.state,'held');assert.equal(row?.input_json,'{}');assert.equal(row?.drafts_json,'[]');assert.equal(row?.peers_json,'[]')
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_index_facts').get()?.n,0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_index_calls').get()?.n,1)
    assert.throws(()=>f.db.prepare("UPDATE memory_index_jobs SET input_json='[]'").run(),/immutable/)
  }finally{release?.();await worker?.dispose();f.db.close()}
})
test('forget removes transitive Evolution manifests and pending induction snapshots',()=>{
  const f=fixture()
  try {
    const episodes=['one','two','three'].map(id=>createEpisode(f.db,id))
    const root=readEntry(f.db,{workspace:range.workspace,entryId:episodes[0]!.sources[0]!.entryId})
    withImmediateTransaction(f.db,()=>saveLesson(f.db,episodes,'positive',{applicability:episodes[0]!.draft.applicability,procedure:episodes[0]!.draft.procedure,verification:episodes[0]!.draft.verification,boundary:episodes[0]!.draft.boundary,evidence:episodes.map(e=>e.runId),conflict:false},NOW))
    scheduleEvolution(f.db,'three',{provider:'fixture',model:'fixed',contextWindow:131072},NOW)
    const result=retire(f.db,root);assert.ok(result.count>=3)
    for(const row of f.db.prepare('SELECT input_json,seen_json,state FROM memory_evolution_jobs').all()){
      assert.equal(row.input_json,'[]');assert.equal(row.seen_json,'[]');assert.equal(row.state,'held')
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_episodes WHERE run_id=?').get('one')?.n,0)
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM memory_derivations WHERE manifest_json LIKE ?").get(`%${root.id}%`)?.n,0)
    assert.throws(()=>withImmediateTransaction(f.db,()=>saveLesson(f.db,episodes,'positive',{applicability:episodes[0]!.draft.applicability,procedure:episodes[0]!.draft.procedure,verification:episodes[0]!.draft.verification,boundary:episodes[0]!.draft.boundary,evidence:episodes.map(e=>e.runId),conflict:false},NOW)))
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[])
  }finally{f.db.close()}
})
test('known manual Global projection is erased and source-linked legacy capture cannot resurrect it',()=>{
  const f=adopt();try {
    const root=f.result.entries[0]!
    ensureGlobalWorkspace(f.db,NOW)
    const global=recordEntry(f.db,{workspace:'global',kind:'decision',title:'Projected condition',body:root.body,scope:{visibility:'global',retrievalScope:'global'},provenance:{type:'curator_globalize',reference:`${root.id}@1#fixture`,sourceWorkspace:root.workspace}})
    assert.equal(retire(f.db,root).count,2)
    assert.throws(()=>readEntry(f.db,{workspace:'global',entryId:global.id}))
    assert.throws(()=>recordEntry(f.db,{workspace:root.workspace,kind:root.kind,title:root.title,body:root.body,provenance:root.provenance}))
    assert.throws(()=>f.db.prepare('DELETE FROM memory_forget_tombstones').run(),/permanent/)
  }finally{f.db.close()}
})
