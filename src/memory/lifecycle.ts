import {contextStamp,cachedContext,saveContext} from './lifecycle-cache.js'
import {projectGlobalPrinciples,globalPrinciples,type GlobalPrinciple} from './lifecycle-global.js'
import { z } from 'zod'
import type { SqliteDatabase } from '../db/adapter.js'
import {withOptionalMemoryAccess,withOptionalMemoryTransaction} from './lifecycle-database.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { capturePolicy } from './capture-policy.js'
import { findSecretInValue } from './secrets.js'

const identity = z.string().min(1).max(256).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const text = z.string().trim().min(1).max(2048)
const outcome = z.enum(['passed', 'failed', 'unknown'])
export const MemoryObservation = z.object({
  cwd: z.string().min(1), eventId: identity, sessionId: identity,
  kind: z.enum(['compaction','completion','model_switch','complaint','praise']), summary: text.optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(16).default([]),
  outcome: outcome.default('unknown'), verification: outcome.default('unknown'),
  actions: z.array(z.object({kind:z.enum(['inspect','edit','build','test','recover','explain','other']),
    outcome, summary:z.string().trim().min(1).max(512)}).strict()).max(32).default([]),
  source: z.object({producer:identity,runId:identity,eventIds:z.array(identity).min(1).max(32),revision:z.number().int().nonnegative().default(0),tombstone:z.boolean().default(false)}).strict(),
  issue: text.optional(), prevention: text.optional(), fromModel:identity.optional(), toModel:identity.optional(),
}).strict()
export type MemoryObservationInput = z.input<typeof MemoryObservation>
export type Observation = Omit<z.infer<typeof MemoryObservation>,'summary'> & {summary:string}
export interface ObservationVersion {sourceKey?:string;revision?:number;tombstone?:boolean;hostVerified?:boolean}
export interface MemorySource {producer:string;eventId:string;runId:string;eventIds:string[];sourceKey:string;revision:number;digest:string;verification:Observation['verification'];verificationSource:'host_receipt'|'producer_assertion'}
interface Saved {value:Observation;source:MemorySource;hostVerified:boolean;tombstone:boolean;createdAt:string}
export interface RoutineCandidate {id:string;kind:'caution'|'procedure';summary:string;tags:string[];verification:Observation['verification'];confidence:number;candidate:true;active:boolean;sources:MemorySource[]}
export interface MemoryContext {schemaVersion:1;workspace:string;cautions:RoutineCandidate[];successfulProcedures:RoutineCandidate[];
  recentHistory:{kind:Observation['kind'];summary:string;actions:Observation['actions'];source:MemorySource}[];
  continuation:{kind:Observation['kind'];summary:string;actions:Observation['actions'];source:MemorySource}[];
  sourceRefs:MemorySource[];workMayContinue:true;diagnostics:string[];available:boolean;
  entries:{entryId:string;revision:number;summary:string;tags:string[];confidence:number;verification:Observation['verification'];verificationProvenance:string;sourceEventIds:string[];scope:'project'|'global';untrusted:true}[];
  globalPrinciples:GlobalPrinciple[];
  handoff:null|{sessionId:string;expiresAt:string;observations:MemoryContext['continuation']};warnings:string[]}

/** Producer assertions stay assertions. Only a host-bound check can set hostVerified. */
export function observeMemory(db:SqliteDatabase,workspace:string,input:unknown,version:ObservationVersion={}) {
    return { accepted: false, recorded: false, duplicate: false, workMayContinue: true as const, diagnostics: ['post_task_memory_review_required'] };
  }

function latest(db:SqliteDatabase,workspace:string):Saved[] {
  const rows=db.prepare(`SELECT o.* FROM dsh_memory_observations o WHERE o.workspace=? AND NOT EXISTS
    (SELECT 1 FROM dsh_memory_observations n WHERE n.workspace=o.workspace AND n.producer=o.producer AND n.source_key=o.source_key AND n.source_revision>o.source_revision)
    ORDER BY o.created_at DESC,o.event_id DESC LIMIT 512`).all<{observation_json:string;producer:string;event_id:string;source_key:string;source_revision:number;content_hash:string;host_verified:number;tombstone:number;created_at:string}> (workspace)
  const seen=new Set(rows.map(row=>`${row.producer}:${row.source_key}`))
  const cached=db.prepare(`SELECT r.candidate_json FROM dsh_memory_routine_revisions r WHERE r.workspace=? AND NOT EXISTS
    (SELECT 1 FROM dsh_memory_routine_revisions n WHERE n.workspace=r.workspace AND n.candidate_id=r.candidate_id AND n.revision>r.revision)
    ORDER BY r.created_at DESC LIMIT 128`).all<{candidate_json:string}>(workspace)
  for(const old of cached){const candidate=JSON.parse(old.candidate_json) as RoutineCandidate;if(!candidate.active)continue
    for(const ref of candidate.sources){const key=`${ref.producer}:${ref.sourceKey}`;if(seen.has(key)||rows.length>=1024)continue
      const row=db.prepare('SELECT * FROM dsh_memory_observations WHERE workspace=? AND producer=? AND source_key=? ORDER BY source_revision DESC LIMIT 1').get<(typeof rows)[number]>(workspace,ref.producer,ref.sourceKey)
      if(row){rows.push(row);seen.add(key)}}}
  return rows.map(row=>{
    const parsed=MemoryObservation.parse(JSON.parse(row.observation_json)),value:Observation={...parsed,summary:parsed.summary??'Observation withdrawn.'}
    if(canonicalContentHash({value,sourceKey:row.source_key,revision:row.source_revision,tombstone:row.tombstone===1,hostVerified:row.host_verified===1})!==row.content_hash)throw new Error('memory_integrity_error')
    const source:MemorySource={producer:row.producer,eventId:row.event_id,runId:value.source.runId,eventIds:value.source.eventIds,
      sourceKey:row.source_key,revision:row.source_revision,digest:row.content_hash,verification:value.verification,verificationSource:row.host_verified===1?'host_receipt':'producer_assertion'}
    return {value,source,hostVerified:row.host_verified===1,tombstone:row.tombstone===1||capturePolicy(db,workspace,value.sessionId).mode!=='allowed',createdAt:row.created_at}
  })
}
function sourceCurrent(sources:MemorySource[],current:Saved[]):boolean {
  return sources.length>0&&sources.every(ref=>current.some(row=>!row.tombstone&&row.source.producer===ref.producer&&row.source.sourceKey===ref.sourceKey&&row.source.digest===ref.digest))
}
function signature(row:Saved):string {return canonicalContentHash(row.value.actions.filter(a=>a.kind!=='explain').map(a=>({kind:a.kind,summary:a.summary})))}
function derive(rows:Saved[]):RoutineCandidate[] {
  const active=rows.filter(row=>!row.tombstone), candidates:RoutineCandidate[]=[]
  for(const row of active.filter(row=>['complaint','praise'].includes(row.value.kind))){
    const caution=row.value.kind==='complaint'
    candidates.push({id:`feedback:${canonicalContentHash([row.source.producer,row.source.sourceKey])}`,kind:caution?'caution':'procedure',
      summary:[row.value.issue??row.value.summary,row.value.prevention??(caution?'A source-backed correction and verification are still required before reusing this result.':'Human praise is a candidate signal; it does not establish verification.')].join('\n'),
      tags:row.value.tags,verification:row.hostVerified?'passed':'unknown',confidence:row.hostVerified?0.7:0.3,candidate:true,active:true,sources:[row.source]})
  }
  const groups=new Map<string,Saved[]>()
  for(const row of active.filter(row=>row.value.kind==='completion'&&row.value.outcome!=='failed'&&!row.value.tags.some(tag=>['status:cancelled','status:interrupted'].includes(tag))&&row.value.actions.length)){
    const key=signature(row),group=groups.get(key)??[];group.push(row);groups.set(key,group)
  }
  for(const [key,group] of groups){
    const independent=[...new Map(group.map(row=>[row.value.source.runId,row])).values()]
    if(independent.length<2)continue
    const counterexamples=active.filter(row=>(row.value.kind==='complaint'||row.value.kind==='completion'&&row.value.outcome==='failed')&&row.value.actions.length&&signature(row)===key)
    const verified=independent.filter(row=>row.hostVerified&&row.value.outcome==='passed').length
    candidates.push({id:`procedure:${key}`,kind:'procedure',summary:`Repeated recorded procedure (${independent.length} independent runs):\n${independent[0]!.value.actions.map(a=>`${a.kind}: ${a.summary}`).join('\n')}`,
      tags:[...new Set(independent.flatMap(row=>row.value.tags))].slice(0,16),verification:verified>=2&&!counterexamples.length?'passed':'unknown',
      confidence:counterexamples.length?0.2:verified>=2?0.75:0.3,candidate:true,active:true,sources:[...independent,...counterexamples].map(row=>row.source)})
  }
  return candidates.slice(0,128)
}
/** Deterministic bounded extraction, including untrusted portable Global candidates. */
export function improveMemory(db:SqliteDatabase,workspace:string,limit=32){
    return {accepted:false,recorded:false,workMayContinue:true as const,changed:0,skipped:true,diagnostics:['post_task_memory_review_required']};
  }

export function memoryContext(db:SqliteDatabase,workspace:string,input:{query?:string|undefined;tags?:readonly string[]|undefined;sessionId?:string|undefined;limit?:number|undefined}={}):MemoryContext {
  const empty:MemoryContext={schemaVersion:1,workspace,cautions:[],successfulProcedures:[],recentHistory:[],continuation:[],sourceRefs:[],workMayContinue:true,diagnostics:[],available:true,entries:[],globalPrinciples:[],handoff:null,warnings:[]}
  try{return withOptionalMemoryTransaction(db,()=>{
    if(input.sessionId&&capturePolicy(db,workspace,input.sessionId).mode!=='allowed')return {...empty,diagnostics:['capture_excluded']}
    const now=Date.now(),key=JSON.stringify([workspace,input.sessionId??null,input.query??'',input.tags??[],input.limit??5]),stamp=contextStamp(db,workspace)
    const reused=cachedContext(db,key,stamp,now);if(reused)return reused
    const rows=latest(db,workspace),limit=Math.max(1,Math.min(16,input.limit??5)),words=(input.query??'').toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0,12),tags=input.tags??[]
    const match=(summary:string,itemTags:string[])=>tags.every(tag=>itemTags.includes(tag))&&(!words.length||words.some(word=>`${summary} ${itemTags.join(' ')}`.toLocaleLowerCase().includes(word)))
    const savedRows=db.prepare(`SELECT r.candidate_json,r.revision FROM dsh_memory_routine_revisions r WHERE r.workspace=? AND NOT EXISTS
      (SELECT 1 FROM dsh_memory_routine_revisions n WHERE n.workspace=r.workspace AND n.candidate_id=r.candidate_id AND n.revision>r.revision) ORDER BY r.created_at DESC LIMIT 128`)
      .all<{candidate_json:string;revision:number}>(workspace)
    const revisions=new Map(savedRows.map(row=>[(JSON.parse(row.candidate_json) as RoutineCandidate).id,row.revision]))
    const saved=savedRows.map(row=>JSON.parse(row.candidate_json) as RoutineCandidate)
    const currentCandidates=new Map(derive(rows).map(candidate=>[candidate.id,canonicalContentHash(candidate)]))
    const candidates=saved.filter(c=>c.active&&sourceCurrent(c.sources,rows)&&currentCandidates.get(c.id)===canonicalContentHash(c)&&match(c.summary,c.tags))
    const continuation=input.sessionId?rows.filter(row=>!row.tombstone&&Date.parse(row.createdAt)>=now-86400000&&row.value.sessionId===input.sessionId&&['model_switch','compaction','completion'].includes(row.value.kind)).slice(0,limit)
      .map(row=>({kind:row.value.kind,summary:row.value.summary,actions:row.value.actions,source:row.source})):[]
    const cautions=candidates.filter(c=>c.kind==='caution').slice(0,limit),successfulProcedures=candidates.filter(c=>c.kind==='procedure').slice(0,limit)
    const recentHistory=rows.filter(row=>!row.tombstone&&row.value.kind==='completion'&&row.value.sessionId!==input.sessionId&&match(row.value.summary,row.value.tags)).slice(0,limit)
      .map(row=>({kind:row.value.kind,summary:row.value.summary,actions:row.value.actions,source:row.source}))
    const compact=(ref:MemorySource)=>({...ref,eventIds:ref.eventIds.slice(0,8)})
    const projected:MemoryContext={...empty,globalPrinciples:globalPrinciples(db,input),cautions:cautions.map(c=>({...c,summary:c.summary.slice(0,2048),sources:c.sources.slice(0,6).map(compact)})),
      successfulProcedures:successfulProcedures.map(c=>({...c,summary:c.summary.slice(0,2048),sources:c.sources.slice(0,6).map(compact)})),
      continuation:continuation.map(c=>({...c,source:compact(c.source)})),recentHistory:recentHistory.map(c=>({...c,source:compact(c.source)}))}
    const refs=()=>{
      projected.sourceRefs=[...projected.cautions.flatMap(c=>c.sources),...projected.successfulProcedures.flatMap(c=>c.sources),...projected.continuation.map(c=>c.source),...projected.recentHistory.map(c=>c.source)].slice(0,32)
      projected.entries=[...projected.cautions,...projected.successfulProcedures].map<MemoryContext['entries'][number]>(c=>({entryId:`lifecycle:${c.id}`,revision:revisions.get(c.id)??1,summary:c.summary,tags:c.tags,confidence:c.confidence,
        verification:c.verification,verificationProvenance:c.sources.every(ref=>ref.verificationSource==='host_receipt')?'host_receipt':'producer_assertion',sourceEventIds:c.sources.map(ref=>ref.eventId),scope:'project',untrusted:true})).concat(projected.globalPrinciples)
      const dated=rows.filter(row=>!row.tombstone&&row.value.sessionId===input.sessionId&&projected.continuation.some(c=>c.source.digest===row.source.digest)).map(row=>Date.parse(row.createdAt))
      projected.handoff=input.sessionId&&dated.length?{sessionId:input.sessionId,expiresAt:new Date(Math.max(...dated)+86400000).toISOString(),observations:projected.continuation}:null
      projected.warnings=projected.diagnostics
    }
    refs()
    while(Buffer.byteLength(JSON.stringify(projected))>15000){projected.diagnostics=['context_excerpt_bounded']
      if(projected.globalPrinciples.length)projected.globalPrinciples.pop();else if(projected.successfulProcedures.length)projected.successfulProcedures.pop();else if(projected.recentHistory.length)projected.recentHistory.pop();else if(projected.continuation.length)projected.continuation.pop();else if(projected.cautions.length)projected.cautions.pop();else break
      refs()}
    const expirations=rows.filter(row=>!row.tombstone&&row.value.sessionId===input.sessionId&&Date.parse(row.createdAt)+86400000>now
      &&['model_switch','compaction','completion'].includes(row.value.kind)).map(row=>Date.parse(row.createdAt)+86400000)
    return saveContext(db,key,stamp,projected,Math.min(...expirations),now)
  },true)}catch{return {...empty,available:false,diagnostics:['memory_unavailable'],warnings:['memory_unavailable']}}
}
