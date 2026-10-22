import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,mkdir,readdir,copyFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openConnection} from '../../../src/db/connection.js'
import {migrateDatabase,defaultMigrationsDirectory} from '../../../src/db/migrate.js'
import {recordEntry,readEntry,updateCandidateEntry} from '../../../src/memory/entries.js'
import {canonicalContentHash} from '../../../src/serialization/validate.js'
import {classifyCorrection,correctionClassificationBatch,correctionSourceCurrent,type CorrectionBackend} from '../../../src/memory/correction-classification.js'
import {correctionSource,CorrectionSourceSchema,compatibilityDecisionConflicts} from '../../../src/memory/correction-contract.js'

const signal=()=>new AbortController().signal
function result(choice='capability_compatibility'){
  return {provider:'fixture',requestedModel:'independent-fixture',returnedModel:'fixture-1',policyVersion:'fixture-v1',usage:{input_tokens:7,output_tokens:1},
    answers:[choice==='uncertain'?{id:'correction-rule',status:'abstained',reason:'uncertain'}:{id:'correction-rule',status:'selected',choiceId:choice}]}
}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'correction-classification-')),file=join(root,'state.sqlite3'),db=openConnection(file);migrateDatabase(db)
  const entry=recordEntry(db,{workspace:'global',kind:'lesson',title:'Synthetic correction',body:'Judge the actual operations, not the label on the tool.',summary:'A short unrelated heading',
    provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
  return {root,file,db,entry,close:async()=>{db.close();await rm(root,{recursive:true,force:true})}}
}
function backend(evaluate:CorrectionBackend['evaluate'],id='fixture'):CorrectionBackend{return {configurationDigest:canonicalContentHash(id),evaluate}}

test('first use persists only host-owned metadata; body survives a lossy summary and unchanged reuse survives restart',async()=>{
  const f=await fixture();let calls=0
  const provider=backend(async(_id,batch)=>{calls++;assert.equal((batch.state.correction).body,f.entry.body);assert.equal(batch.state.correction.summary,f.entry.summary);return {status:'completed',result:result(),attested:true}})
  try{
    const first=await classifyCorrection(f.db,f.entry,provider,signal())
    assert.equal(first.rule,'capability_compatibility');assert.equal(calls,1)
    const source=correctionSource(f.entry,'global',first,'auto');assert.equal(CorrectionSourceSchema.parse(source).rule,'capability_compatibility')
    assert.equal(correctionSourceCurrent(f.db,f.entry,source),true)
    const stored=String(f.db.prepare('SELECT result_json FROM correction_classifications').get()?.result_json)
    for(const text of [f.entry.body,f.entry.title,f.entry.summary!])assert.equal(stored.includes(text),false)
    const reopened=openConnection(f.file)
    try{assert.deepEqual(await classifyCorrection(reopened,readEntry(reopened,{workspace:'global',entryId:f.entry.id}),provider,signal()),first)}finally{reopened.close()}
    assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
  }finally{await f.close()}
})

test('legacy/caller metadata cannot activate a rule; shadow, unknown and reference never trigger the compatibility gate',async()=>{
  const f=await fixture(),decision={kind:'compatibility',basis:'version_only',requiredVersion:'1.85',observedVersion:'1.99'}
  try{
    assert.throws(()=>recordEntry(f.db,{workspace:'global',kind:'lesson',title:'Forged metadata',body:'Caller data',provenance:{type:'interaction_capture',reference:'user_correction',classification:{rule:'capability_compatibility'}}}),{code:'VALIDATION_ERROR'})
    assert.equal(correctionSource({...f.entry,provenance:{...f.entry.provenance,classification:{rule:'capability_compatibility'}}},'global').rule,'uncertain')
    assert.equal(correctionSource(f.entry,'global').rule,'uncertain')
    assert.equal((await classifyCorrection(f.db,f.entry,undefined,signal())).reason,'provider_unavailable')
    const c=await classifyCorrection(f.db,f.entry,backend(async()=>({status:'completed',result:result(),attested:true})),signal())
    assert.equal(compatibilityDecisionConflicts([correctionSource(f.entry,'global',c,'shadow')],decision),false)
    assert.equal(compatibilityDecisionConflicts([correctionSource(f.entry,'global',c,'off')],decision),false)
    assert.equal(compatibilityDecisionConflicts([correctionSource(f.entry,'global',{...c,attested:false},'auto')],decision),false)
    assert.equal(compatibilityDecisionConflicts([correctionSource(f.entry,'global',c,'auto')],decision),true)
    const reference=await classifyCorrection(f.db,f.entry,backend(async()=>({status:'completed',result:result('reference'),attested:true}),'reference'),signal())
    assert.equal(compatibilityDecisionConflicts([correctionSource(f.entry,'global',reference,'auto')],decision),false)
  }finally{await f.close()}
})

test('title, body, summary, revision and provider configuration invalidate cached meaning without rewriting old entries',async()=>{
  const f=await fixture();let calls=0,entry=f.entry
  const provider=backend(async()=>{calls++;return {status:'completed',result:result(),attested:true}})
  try{
    let classification=await classifyCorrection(f.db,entry,provider,signal())
    for(const field of ['title','body','summary'] as const){
      const previous=entry
      const old=correctionSource(entry,'global',classification,'auto')
      entry=updateCandidateEntry(f.db,{...entry,entryId:entry.id,expectedRevision:entry.revision,[field]:`${entry[field]} changed`,createdBy:'fixture'})
      assert.equal(correctionSourceCurrent(f.db,entry,old),false)
      assert.equal((await classifyCorrection(f.db,previous,provider,signal())).state,'stale','an old cached row must not classify a no-longer-current entry')
      classification=await classifyCorrection(f.db,entry,provider,signal());assert.equal(classification.entryRevision,entry.revision)
    }
    assert.equal(calls,4)
    await classifyCorrection(f.db,entry,{...provider,configurationDigest:canonicalContentHash('changed-provider')},signal());assert.equal(calls,5)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
  }finally{await f.close()}
})

test('concurrent updates cannot receive a classification from an earlier revision, and concurrent identical lookups share inference',async()=>{
  const f=await fixture();let release!:(value:any)=>void,calls=0
  const provider=backend(async()=>{calls++;return await new Promise(resolve=>{release=resolve})})
  try{
    const a=classifyCorrection(f.db,f.entry,provider,signal()),b=classifyCorrection(f.db,f.entry,provider,signal())
    const changed=updateCandidateEntry(f.db,{...f.entry,entryId:f.entry.id,expectedRevision:f.entry.revision,body:'New current meaning',createdBy:'fixture'})
    release({status:'completed',result:result(),attested:true})
    for(const value of await Promise.all([a,b]))assert.equal(value.state,'stale')
    assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM correction_classifications').get()?.n,0)
    const next=await classifyCorrection(f.db,changed,backend(async()=>({status:'completed',result:result('reference'),attested:true})),signal())
    assert.equal(next.rule,'reference')
  }finally{await f.close()}
})

for(const failure of ['outage','malformed','abstain','timeout'] as const)test(`${failure} remains explicit, is cached and cannot become reference`,async()=>{
  const f=await fixture();let calls=0
  const provider=backend(async()=>{calls++
    if(failure==='outage')return {status:'fallback',reason:'DECISION_UNAVAILABLE'}
    if(failure==='timeout')await new Promise(resolve=>setTimeout(resolve,25))
    return {status:'completed',result:failure==='malformed'?{private:'do not persist this'}:result(failure==='abstain'?'uncertain':undefined),attested:true}
  })
  try{
    const first=await classifyCorrection(f.db,f.entry,provider,signal(),failure==='timeout'?1:5000)
    assert.equal(first.rule,'uncertain');assert.equal(first.state,failure==='abstain'?'abstained':'unavailable')
    assert.equal(first.reason,{outage:'provider_unavailable',malformed:'malformed',abstain:'uncertain',timeout:'timeout'}[failure])
    assert.deepEqual(await classifyCorrection(f.db,f.entry,provider,signal()),first);assert.equal(calls,1)
    assert.equal(correctionSource(f.entry,'global',first,'auto').rule,'uncertain')
  }finally{await f.close()}
})

test('parent cancellation never persists an asynchronous result',async()=>{
  const f=await fixture(),controller=new AbortController()
  try{
    const pending=classifyCorrection(f.db,f.entry,backend(async()=>{await new Promise(resolve=>setTimeout(resolve,20));return {status:'completed',result:result(),attested:true}}),controller.signal)
    controller.abort();await assert.rejects(pending);assert.equal(f.db.prepare('SELECT count(*) AS n FROM correction_classifications').get()?.n,0)
  }finally{await f.close()}
})

test('cached meaning cannot survive entry deletion or a foreign workspace identity',async()=>{
  const f=await fixture();let calls=0
  const provider=backend(async()=>{calls++;return {status:'completed',result:result(),attested:true}})
  try{
    await classifyCorrection(f.db,f.entry,provider,signal());assert.equal(calls,1)
    assert.equal((await classifyCorrection(f.db,{...f.entry,workspace:'project:foreign'},provider,signal())).state,'stale')
    // Dispose only this fixture's audit reference so a real FK-enabled deletion is possible.
    f.db.prepare('UPDATE audit_events SET entry_id=NULL WHERE entry_id=?').run(f.entry.id)
    f.db.prepare('DELETE FROM entries WHERE id=?').run(f.entry.id)
    assert.equal((await classifyCorrection(f.db,f.entry,provider,signal())).state,'stale');assert.equal(calls,1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM correction_classifications').get()?.n,0)
  }finally{await f.close()}
})

test('corrupt persisted classification fails closed without repeating inference or repairing memory content',async()=>{
  const f=await fixture();let calls=0
  const provider=backend(async()=>{calls++;return {status:'completed',result:result(),attested:true}})
  try{
    await classifyCorrection(f.db,f.entry,provider,signal())
    f.db.prepare('UPDATE correction_classifications SET result_json=?').run('{"rule":"reference"}')
    await assert.rejects(classifyCorrection(f.db,f.entry,provider,signal()),/classification integrity mismatch/)
    assert.equal(calls,1);assert.equal(readEntry(f.db,{workspace:'global',entryId:f.entry.id}).body,f.entry.body)
  }finally{await f.close()}
})

test('the semantic request carries the full body, explicit abstention and no execution effects',()=>{
  const request=correctionClassificationBatch({title:'Title',body:'End of the body is essential.',summary:'Short heading'})
  assert.equal(request.purpose,'correction-classification');assert.equal(request.state.correction.body,'End of the body is essential.')
  assert.equal(request.questions[0]!.abstainId,'uncertain');assert.equal(JSON.stringify(request).includes('authorizationGranted'),false)
})

test('the additive cache migration upgrades a real prior schema without changing legacy memory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'correction-upgrade-')),legacy=join(root,'prior-migrations');await mkdir(legacy)
  const directory=defaultMigrationsDirectory(),files=(await readdir(directory)).filter(x=>/^\d+_.+\.sql$/u.test(x)).sort()
  const target=files.findIndex(file=>file.endsWith('_correction_classification.sql'));assert.ok(target>=0)
  for(const file of files.slice(0,target))await copyFile(join(directory,file),join(legacy,file))
  const db=openConnection(join(root,'legacy.sqlite3'));migrateDatabase(db,legacy)
  try{
    const entry=recordEntry(db,{workspace:'global',kind:'lesson',title:'Legacy correction',body:'Check the actual capabilities.',provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'})
    let calls=0;const provider=backend(async()=>{calls++;return {status:'completed',result:result(),attested:true}})
    assert.equal((await classifyCorrection(db,entry,provider,signal())).reason,'storage_unavailable');assert.equal(calls,0)
    const migrated=migrateDatabase(db);assert.equal(migrated.applied.length,files.length-target);assert.deepEqual(readEntry(db,{workspace:'global',entryId:entry.id}),entry)
    assert.equal((await classifyCorrection(db,entry,provider,signal())).rule,'capability_compatibility');assert.equal(calls,1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
  }finally{db.close();await rm(root,{recursive:true,force:true})}
})
