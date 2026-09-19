import type { SqliteDatabase } from '../../db/adapter.js'
import { canonicalContentHash, type JsonObject } from '../../serialization/validate.js'
import { readEntry, recordEntryInTransaction, updateCandidateEntryInTransaction, type EntryRecord } from '../entries.js'
import { searchEntries } from '../retrieval.js'
import { buildStructuredScope } from '../structured-memory.js'
import { findSecretInValue } from '../secrets.js'
import type { MemoryOperation, MemorySnapshot, ReviewEvidence, ReviewRange } from './contracts.js'

export const REVIEW_ACTOR='kiokuko-dsh-memory-review'
function editable(db:SqliteDatabase,entry:EntryRecord):boolean {
  const latest=db.prepare('SELECT created_by FROM entry_revisions WHERE entry_id=? AND revision=?').get<{created_by:string}>(entry.id,entry.revision)
  return entry.status==='candidate'&&entry.createdBy===REVIEW_ACTOR&&latest?.created_by===REVIEW_ACTOR&&
    !db.prepare('SELECT 1 FROM external_skill_entries WHERE entry_id=?').get(entry.id)
}
export function memorySnapshots(db:SqliteDatabase,range:ReviewRange,query:string):{existing:MemorySnapshot[];lookupIncomplete:boolean} {
  const owned=db.prepare('SELECT DISTINCT entry_id FROM memory_review_effects WHERE run_id=? AND entry_id IS NOT NULL ORDER BY source_end_seq DESC LIMIT 13')
    .all<{entry_id:string}>(range.runId)
  const entries=new Map<string,EntryRecord>();let lookupIncomplete=owned.length>12
  for(const row of owned){try {const entry=readEntry(db,{workspace:range.workspace,entryId:row.entry_id});if(entry.status!=='superseded')entries.set(entry.id,entry)}catch{lookupIncomplete=true}}
  try {const found=searchEntries(db,{workspace:range.workspace,query:query.slice(0,4000),limit:12});for(const e of found.items)entries.set(e.id,e);lookupIncomplete||=found.truncated}catch{lookupIncomplete=true}
  const existing:MemorySnapshot[]=[];let bytes=0
  for(const entry of entries.values()){
    if(findSecretInValue({title:entry.title,body:entry.body})) {lookupIncomplete=true;continue}
    const item={entryId:entry.id,revision:entry.revision,contentHash:entry.contentHash,kind:entry.kind,status:entry.status,trustLevel:entry.trustLevel,title:entry.title,body:entry.body,editable:editable(db,entry)}
    const size=Buffer.byteLength(JSON.stringify(item))
    if(existing.length>=12||bytes+size>8192){lookupIncomplete=true;continue}
    existing.push(item);bytes+=size
  }
  return {existing,lookupIncomplete}
}
export interface AdoptionInput {id:string;range:ReviewRange;evidence:ReviewEvidence[];existing:MemorySnapshot[];operations:MemoryOperation[];observe:boolean;now:string;actor?:string;retry?:boolean}
export interface AdoptionResult {added:number;updated:number;unchanged:number;held:number;entries:EntryRecord[]}
/** The caller owns fencing, source revalidation and the entire adoption transaction. */
export function adoptMemories(db:SqliteDatabase,input:AdoptionInput):AdoptionResult {
  const {range}=input,result:AdoptionResult={added:0,updated:0,unchanged:0,held:0,entries:[]},targets=new Set<string>()
  const repository=db.prepare('SELECT repository_id FROM repositories WHERE workspace=?').get<{repository_id:string}>(range.workspace)
  if(!repository)throw new Error('owner_mismatch')
  const scope=buildStructuredScope({visibility:'project',retrievalScope:'project-only',repositoryId:repository.repository_id})
  for(const [index,op] of input.operations.entries()){
    if(db.prepare('SELECT 1 FROM memory_review_effects WHERE job_id=? AND operation_index=?').get(input.id,index))throw new Error('effect_already_applied')
    let disposition='held',reason:string|null=null,entry:EntryRecord|undefined,previous:number|null=null,identity:string|null=null
    const refs=input.evidence.filter(e=>op.evidenceIds.includes(e.id)),manifest=refs.map(({text:_text,...ref})=>ref)
    db.exec('SAVEPOINT memory_review_operation')
    try {
      if(new Set(op.evidenceIds).size!==op.evidenceIds.length||refs.length!==op.evidenceIds.length||refs.some(e=>!e.eligibleForNewMemory))throw new Error('evidence_invalid')
      if(findSecretInValue(op))throw new Error('secret_detected')
      if(op.action==='defer')throw new Error(op.reason)
      if(op.action!=='add'){
        if(targets.has(op.targetEntryId)||input.operations.filter(other=>'targetEntryId' in other&&other.targetEntryId===op.targetEntryId).length!==1)throw new Error('ambiguous_target')
        targets.add(op.targetEntryId)
        const snapshot=input.existing.find(e=>e.entryId===op.targetEntryId)
        if(!snapshot)throw new Error('target_not_offered')
        entry=readEntry(db,{workspace:range.workspace,entryId:op.targetEntryId})
        if(entry.revision!==snapshot.revision||entry.contentHash!==snapshot.contentHash||entry.status!==snapshot.status)throw new Error('revision_changed')
        if(entry.status==='superseded')throw new Error('source_retired')
        if(op.action==='update'&&(!snapshot.editable||!editable(db,entry)||op.expectedRevision!==entry.revision||op.expectedContentHash!==entry.contentHash))throw new Error('target_not_editable')
      }
      if(input.retry&&op.action!=='unchanged'&&db.prepare("SELECT 1 FROM memory_review_effects WHERE run_id=? AND source_end_seq>? AND disposition IN ('added','updated') LIMIT 1").get(range.runId,range.endSeq))throw new Error('newer_evidence_conflict')
      // Retain tombstones independently of entries; old evidence cannot resurrect a deletion.
      const old=db.prepare('SELECT entry_id,evidence_json FROM memory_review_effects WHERE run_id=? AND session_id=? AND source_generation=? AND entry_id IS NOT NULL')
        .all<{entry_id:string;evidence_json:string}>(range.runId,range.sessionId,range.sourceGeneration)
      for(const effect of old){
        if(!(JSON.parse(effect.evidence_json) as ReviewEvidence[]).some(e=>refs.some(ref=>ref.normalizedSourceHash===e.normalizedSourceHash)))continue
        const current=db.prepare('SELECT status FROM entries WHERE id=?').get<{status:string}>(effect.entry_id)
        if(!current||current.status==='superseded')throw new Error('source_retired')
      }
      if(op.action==='unchanged')disposition='unchanged'
      else {
        identity=canonicalContentHash({workspace:range.workspace,kind:op.kind,body:op.body.replace(/\r\n?/g,'\n').trim()})
        const duplicate=db.prepare(`SELECT e.id FROM entries e JOIN entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision
          WHERE e.workspace=? AND r.kind=? AND trim(replace(r.body,char(13),''))=? AND e.status<>'superseded' LIMIT 1`).get<{id:string}>(range.workspace,op.kind,op.body.replace(/\r/g,'').trim())
        if(duplicate){entry=readEntry(db,{workspace:range.workspace,entryId:duplicate.id});disposition='unchanged'}
        else if(input.observe)disposition='observed'
        else {
          const actor=input.actor??REVIEW_ACTOR
          const provenance:JsonObject={type:actor===REVIEW_ACTOR?'dsh-memory-review':'dsh-session-finalization',reference:`dsh-session:${range.sessionId}?seq=${range.startSeq}-${range.endSeq}#sha256:${canonicalContentHash(manifest)}`,sourceRepositoryId:repository.repository_id,sourceWorkspace:range.workspace,runId:range.runId,clientKind:'dsh',timestamp:input.now}
          const trust=refs.every(e=>e.role==='user_assertion')?'user_asserted':'untrusted'
          if(op.action==='add'){
            entry=recordEntryInTransaction(db,{workspace:range.workspace,kind:op.kind,title:op.title,body:op.body,status:'candidate',trustLevel:trust,confidence:0.5,scope,provenance,tags:['dsh','memory-review'],createdBy:actor,actor},{now:input.now});disposition='added'
          }else {
            if(entry!.trustLevel!==trust)throw new Error('trust_mismatch')
            previous=entry!.revision
            entry=updateCandidateEntryInTransaction(db,{workspace:range.workspace,entryId:entry!.id,expectedRevision:op.expectedRevision,kind:op.kind,title:op.title,body:op.body,scope:entry!.scope,provenance,tags:entry!.tags,createdBy:REVIEW_ACTOR,actor,now:input.now});disposition='updated'
          }
        }
      }
      db.exec('RELEASE memory_review_operation')
    }catch(error){
      db.exec('ROLLBACK TO memory_review_operation');db.exec('RELEASE memory_review_operation')
      const allowed=new Set(['evidence_invalid','secret_detected','ambiguous','conflict','insufficient_context','ambiguous_target','target_not_offered','revision_changed','source_retired','target_not_editable','newer_evidence_conflict','trust_mismatch'])
      reason=error instanceof Error&&allowed.has(error.message)?error.message:'adoption_rejected';disposition='held'
    }
    db.prepare(`INSERT INTO memory_review_effects(job_id,operation_index,workspace,run_id,session_id,source_generation,evidence_json,action,disposition,reason,entry_id,revision,content_hash,previous_revision,content_identity,source_end_seq)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,index,range.workspace,range.runId,range.sessionId,range.sourceGeneration,JSON.stringify(manifest),op.action,disposition,reason,entry?.id??null,entry?.revision??null,entry?.contentHash??null,previous,identity,range.endSeq)
    if(disposition==='added')result.added++;else if(disposition==='updated')result.updated++;else if(disposition==='held')result.held++;else result.unchanged++
    if(entry&&disposition!=='held')result.entries.push(entry)
  }
  return result
}
