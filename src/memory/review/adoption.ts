import { readRevisionEvidence } from '../evidence.js'
import { assertEvidenceNotForgotten } from '../forgotten.js'
import { citationManifest, saveCitationManifest } from './citations.js'
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
export function memorySnapshots(db:SqliteDatabase,range:ReviewRange,query:string,includeClaims=false):{existing:MemorySnapshot[];lookupIncomplete:boolean} {
  const owned=db.prepare('SELECT DISTINCT entry_id FROM memory_review_effects WHERE run_id=? AND entry_id IS NOT NULL ORDER BY source_end_seq DESC LIMIT 13')
    .all<{entry_id:string}>(range.runId)
  const entries=new Map<string,EntryRecord>();let lookupIncomplete=owned.length>12
  for(const row of owned){try {const entry=readEntry(db,{workspace:range.workspace,entryId:row.entry_id});if(entry.status!=='superseded')entries.set(entry.id,entry)}catch{lookupIncomplete=true}}
  try {const found=searchEntries(db,{workspace:range.workspace,query:query.slice(0,4000),limit:12});for(const e of found.items)entries.set(e.id,e);lookupIncomplete||=found.truncated}catch{lookupIncomplete=true}
  const existing:MemorySnapshot[]=[];let bytes=0
  for(const entry of entries.values()){
    if(findSecretInValue({title:entry.title,body:entry.body})) {lookupIncomplete=true;continue}
    const claims=includeClaims?readRevisionEvidence(db,entry.id,entry.revision,entry.workspace)?.claims.map(({id,text})=>({id,text}))??[]:undefined
    const item={entryId:entry.id,revision:entry.revision,contentHash:entry.contentHash,kind:entry.kind,status:entry.status,trustLevel:entry.trustLevel,title:entry.title,body:entry.body,editable:editable(db,entry),...(claims===undefined?{}:{claimIds:claims.map(c=>c.id),claims})}
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
    return { added: 0, updated: 0, unchanged: 0, held: input.operations.length, entries: [] }; // No legacy proposal has native revision approval.
  }
