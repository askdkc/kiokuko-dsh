import test from 'node:test'
import assert from 'node:assert/strict'
import { seed,fixture,NOW } from './fixture.js'
import { configureEvolution, saveEpisode, saveLesson, evolutionEntryState, diversifyEpisodes } from '../../../../src/memory/evolution/store.js'
import { readEntry,updateCandidateEntry } from '../../../../src/memory/entries.js'
import { searchEntries } from '../../../../src/memory/retrieval.js'
import { contextRetrievalStateHash } from '../../../../src/context/selection-state.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'

test('observe stores episodes but hides derived entries, active is scoped and source changes invalidate caches', () => {
  const {db}=fixture()
  try {
    const e=seed(db,'source')
    const derived=db.prepare('SELECT entry_id AS id FROM memory_derivations').get<{id:string}>()!.id
    assert.ok(!searchEntries(db,{workspace:e.workspace,query:'migration'}).items.some(i=>i.id===derived))
    configureEvolution(db,'active')
    const entry=readEntry(db,{workspace:e.workspace,entryId:derived})
    assert.equal(evolutionEntryState(db,entry).eligible,true)
    assert.ok(searchEntries(db,{workspace:e.workspace,query:'migration'}).items.some(i=>i.id===derived))
    assert.equal(searchEntries(db,{workspace:'project:other',query:'migration'}).count,0)
    const hash=contextRetrievalStateHash(db,[e.workspace])
    const source=readEntry(db,{workspace:e.workspace,entryId:e.sources[0]!.entryId})
    updateCandidateEntry(db,{workspace:e.workspace,entryId:source.id,expectedRevision:source.revision,kind:source.kind,title:source.title,body:'new evidence'})
    assert.equal(evolutionEntryState(db,entry).eligible,false)
    assert.notEqual(contextRetrievalStateHash(db,[e.workspace]),hash)
    configureEvolution(db,'off');assert.equal(evolutionEntryState(db,entry).eligible,false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()?.n,1)
  } finally {db.close()}
})
test('episode replay is idempotent and changed bound input is rejected atomically', () => {
  const {db}=fixture()
  try {
    const e=seed(db,'replay')
    withImmediateTransaction(db,()=>saveEpisode(db,e,NOW))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_derivations').get()?.n,1)
    assert.throws(()=>withImmediateTransaction(db,()=>saveEpisode(db,{...e,logDigest:'different'},NOW)),/replay_conflict/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get()?.n,1)
  } finally {db.close()}
})
test('lessons preserve candidate trust and reject invented repairs and incomplete support', () => {
  const {db}=fixture()
  try {
    const es=['a','b','c'].map(id=>seed(db,id));const d=es[0]!.draft
    const lesson={applicability:d.applicability,procedure:d.procedure,verification:d.verification,boundary:d.boundary,evidence:es.map(e=>e.runId),conflict:false}
    const saved=withImmediateTransaction(db,()=>saveLesson(db,es,'positive',lesson,NOW))
    assert.equal(saved.status,'candidate');assert.equal(saved.trustLevel,'untrusted')
    assert.equal(withImmediateTransaction(db,()=>saveLesson(db,es,'positive',lesson,NOW)).revision,1)
    assert.throws(()=>withImmediateTransaction(db,()=>saveLesson(db,es,'positive',{...lesson,procedure:'Invented fix'},NOW)),/unsupported_synthesis/)
    assert.throws(()=>withImmediateTransaction(db,()=>saveLesson(db,es,'positive',{...lesson,evidence:['a']},NOW)),/missing_evidence/)
    assert.throws(()=>withImmediateTransaction(db,()=>saveLesson(db,es,'positive',{...lesson,conflict:true},NOW)),/conflicting/)
    const items=Array.from({length:4},()=>({entryId:saved.id,selectionReasons:[]}))
    configureEvolution(db,'active')
    assert.equal(diversifyEpisodes(db,items).length,2)
    assert.equal(diversifyEpisodes(db,items.map(i=>({...i,selectionReasons:['exact_signal_match']}))).length,4)
    const overviews=es.map(e=>({entryId:db.prepare('SELECT overview_entry_id AS id FROM memory_episodes WHERE run_id=?').get<{id:string}>(e.runId)!.id,selectionReasons:[] as string[]}))
    const originals=es.map(e=>({entryId:e.sources[0]!.entryId,selectionReasons:[] as string[]}))
    const ranked=[...originals,...overviews,{entryId:saved.id,selectionReasons:[]}]
    assert.deepEqual(diversifyEpisodes(db,ranked).map(i=>i.entryId),[...originals.map(i=>i.entryId),saved.id])
    assert.ok(diversifyEpisodes(db,ranked.map(i=>({...i,selectionReasons:['exact_signal_match']}))).some(i=>i.entryId===overviews[0]!.entryId))
    assert.deepEqual(diversifyEpisodes(db,[...originals,...overviews]),[...originals,...overviews])
  } finally {db.close()}
})
test('feedback is revision-bound and propagates from an episode overview to its lesson', () => {
  const {db}=fixture()
  try {
    const es=['a','b','c'].map(id=>seed(db,id)),d=es[0]!.draft
    const lesson=withImmediateTransaction(db,()=>saveLesson(db,es,'positive',{applicability:d.applicability,procedure:d.procedure,verification:d.verification,boundary:d.boundary,evidence:es.map(e=>e.runId),conflict:false},NOW))
    configureEvolution(db,'active')
    assert.equal(evolutionEntryState(db,lesson).eligible,true)
    const overview=db.prepare("SELECT overview_entry_id AS id FROM memory_episodes WHERE run_id='a'").get<{id:string}>()!.id
    db.prepare("INSERT INTO context_deliveries(delivery_id,run_id,through_sequence,task_profile_hash,query_hash,policy_version,external_sync_summary_json,char_budget,char_count,truncated,created_at) VALUES('d','a',0,'p','q','test','{}',1000,0,0,?)").run(NOW)
    db.prepare("INSERT INTO context_delivery_entries(delivery_id,entry_id,entry_revision,rank,score_components_json,selection_reason_json) VALUES('d',?,1,1,'{}','[]')").run(overview)
    db.prepare("INSERT INTO context_feedback(feedback_id,delivery_id,entry_id,run_id,verdict,actor,idempotency_key,created_at) VALUES('f','d',?,'a','conflicting','tester','feedback',?)").run(overview,NOW)
    assert.equal(evolutionEntryState(db,lesson).eligible,false)
    assert.ok(!searchEntries(db,{workspace:'project:test',query:'migration'}).items.some(e=>e.id===lesson.id))
  } finally {db.close()}
})
test('deleting an episode overview invalidates descendants and retained evidence contains only hashes', () => {
  const {db}=fixture()
  try {
    const es=['a','b','c'].map(id=>seed(db,id)),d=es[0]!.draft
    const lesson=withImmediateTransaction(db,()=>saveLesson(db,es,'positive',{applicability:d.applicability,procedure:d.procedure,verification:d.verification,boundary:d.boundary,evidence:es.map(e=>e.runId),conflict:false},NOW))
    configureEvolution(db,'active')
    assert.ok(es[0]!.evidence.every(e=>'contentHash' in e&&!('text' in e)))
    db.prepare("UPDATE audit_events SET entry_id=NULL WHERE entry_id=(SELECT overview_entry_id FROM memory_episodes WHERE run_id='a')").run()
    db.prepare("DELETE FROM entries WHERE id=(SELECT overview_entry_id FROM memory_episodes WHERE run_id='a')").run()
    assert.equal(evolutionEntryState(db,lesson).eligible,false)
  } finally {db.close()}
})
test('editing a derived candidate cannot strip provenance to bypass observe/off eligibility', () => {
  const {db}=fixture()
  try {
    const e=seed(db,'edit'),id=db.prepare('SELECT overview_entry_id AS id FROM memory_episodes').get<{id:string}>()!.id
    const old=readEntry(db,{workspace:e.workspace,entryId:id})
    const changed=updateCandidateEntry(db,{workspace:e.workspace,entryId:id,expectedRevision:old.revision,kind:old.kind,title:old.title,body:'User-edited migration reference',now:'2026-09-10T00:00:01.000Z'})
    assert.equal(changed.provenance.type,undefined)
    assert.equal(evolutionEntryState(db,changed).eligible,false)
    configureEvolution(db,'off')
    assert.ok(!searchEntries(db,{workspace:e.workspace,query:'migration'}).items.some(item=>item.id===id))
  } finally {db.close()}
})
