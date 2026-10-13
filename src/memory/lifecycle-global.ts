import type {SqliteDatabase} from '../db/adapter.js'
import {canonicalContentHash} from '../serialization/validate.js'
import {recordEntryInTransaction,readEntry} from './entries.js'
import {ensureGlobalWorkspace,GLOBAL_WORKSPACE} from './workspaces.js'
import {isRetrievableEntry,hybridSearch} from './hybrid-retrieval.js'
import {containsProjectSpecificData} from './portability.js'
import {findSecretInValue} from './secrets.js'
import type {RoutineCandidate} from './lifecycle.js'

/** Extract portable rules only. Project observations/actions never enter Global. */
export function projectGlobalPrinciples(db:SqliteDatabase,workspace:string,candidates:RoutineCandidate[]):void {
  const templates={
    caution:{summary:'Before reusing a criticized result, identify the failed assumption, apply a concrete preventive check, and verify the corrected outcome.',tags:['verification','feedback','prevention']},
    praise:{summary:'Treat praise as a signal to inspect linked public actions and results. Reproduce and verify before adopting the procedure.',tags:['verification','feedback','procedure']},
    repeated:{summary:'Repeated completion is a routine candidate. Check independent run evidence, counterexamples, and current constraints before reuse.',tags:['verification','routine','procedure']},
  }
  for(const candidate of candidates){
    if(!candidate.active){db.prepare('UPDATE dsh_memory_principle_sources SET active=0 WHERE workspace=? AND candidate_id=?').run(workspace,candidate.id);continue}
    const hash=canonicalContentHash(candidate)
    const previous=db.prepare('SELECT candidate_hash,active FROM dsh_memory_principle_sources WHERE workspace=? AND candidate_id=?').get<{candidate_hash:string;active:number}>(workspace,candidate.id)
    if(previous?.candidate_hash===hash&&previous.active===1)continue
    ensureGlobalWorkspace(db)
    const rule=templates[candidate.kind==='caution'?'caution':candidate.id.startsWith('feedback:')?'praise':'repeated']
    const projectionKey=canonicalContentHash([workspace,candidate.id])
    const entry=recordEntryInTransaction(db,{workspace:GLOBAL_WORKSPACE,kind:'lesson',status:'candidate',trustLevel:'untrusted',confidence:0.3,
      title:'Portable lifecycle principle candidate',body:rule.summary,summary:rule.summary,tags:rule.tags,scope:{layer:'global',portable:true},
      provenance:{type:'lifecycle_principle',reference:projectionKey,sourceContentHash:hash,evidenceIds:candidate.sources.slice(0,128).map(ref=>canonicalContentHash([ref.producer,ref.eventId,ref.revision]))},
      createdBy:'kiokuko-dsh:lifecycle',actor:'kiokuko-dsh:lifecycle'})
    db.prepare(`INSERT INTO dsh_memory_principle_sources VALUES(?,?,?,?,?,1) ON CONFLICT(workspace,candidate_id)
      DO UPDATE SET entry_id=excluded.entry_id,candidate_hash=excluded.candidate_hash,sources_json=excluded.sources_json,active=1`)
      .run(workspace,candidate.id,entry.id,hash,JSON.stringify(candidate.sources.map(({producer,sourceKey,digest})=>({producer,sourceKey,digest}))))
  }
}

export interface GlobalPrinciple {entryId:string;revision:number;summary:string;tags:string[];confidence:number;verification:'unknown';verificationProvenance:'untrusted_global_reference';sourceEventIds:string[];scope:'global';untrusted:true}
/** Existing Global references and portable principles use ordinary eligibility gates. */
export function globalPrinciples(db:SqliteDatabase,input:{query?:string|undefined;tags?:readonly string[]|undefined;limit?:number|undefined}):GlobalPrinciple[] {
  const words=(input.query??'').toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0,12),tags=input.tags??[],result:GlobalPrinciple[]=[]
  const query=(input.query??'').trim()||tags.join(' ')
  const ids=query?hybridSearch(db,{workspace:GLOBAL_WORKSPACE,query,limit:64,...(tags[0]?{tag:tags[0]}:{})}).map(candidate=>({id:candidate.entryId})):
    db.prepare("SELECT id FROM entries WHERE workspace=? AND status IN ('candidate','verified') ORDER BY updated_at DESC LIMIT 64").all<{id:string}>(GLOBAL_WORKSPACE)
  for(const {id} of ids){
    const entry=readEntry(db,{workspace:GLOBAL_WORKSPACE,entryId:id})
    if(!['lesson','reference'].includes(entry.kind)||!isRetrievableEntry(db,entry))continue
    const summary=(entry.summary??entry.body).slice(0,2048)
    if(containsProjectSpecificData(summary,entry)||findSecretInValue(summary)||!tags.every(tag=>entry.tags.includes(tag))
      ||words.length&&!words.some(word=>`${summary} ${entry.tags.join(' ')}`.toLocaleLowerCase().includes(word)))continue
    result.push({entryId:entry.id,revision:entry.revision,summary,tags:entry.tags,confidence:Math.min(0.3,entry.confidence),verification:'unknown',
      verificationProvenance:'untrusted_global_reference',sourceEventIds:Array.isArray(entry.provenance.evidenceIds)?entry.provenance.evidenceIds.filter((v):v is string=>typeof v==='string').slice(0,8):[],scope:'global',untrusted:true})
    if(result.length>=Math.max(1,Math.min(16,input.limit??5)))break
  }
  return result
}
