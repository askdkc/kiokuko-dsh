import type {SqliteDatabase} from '../db/adapter.js'
import type {EntryRecord} from './entries.js'
import {capturePolicy} from './capture-policy.js'
import {canonicalContentHash} from '../serialization/validate.js'

/** A withdrawn/corrected source must disappear from every Global retrieval lane. */
export function lifecycleGlobalProjectionActive(db:SqliteDatabase,entry:EntryRecord):boolean {
  if(entry.provenance.type!=='lifecycle_principle')return true
  const mapping=db.prepare('SELECT workspace,candidate_id,candidate_hash,sources_json,active FROM dsh_memory_principle_sources WHERE entry_id=?')
    .get<{workspace:string;candidate_id:string;candidate_hash:string;sources_json:string;active:number}>(entry.id)
  if(!mapping||mapping.active!==1||entry.workspace!=='global'||entry.trustLevel!=='untrusted'||entry.status!=='candidate')return false
  const candidate=db.prepare('SELECT content_hash,candidate_json FROM dsh_memory_routine_revisions WHERE workspace=? AND candidate_id=? ORDER BY revision DESC LIMIT 1')
    .get<{content_hash:string;candidate_json:string}>(mapping.workspace,mapping.candidate_id)
  if(candidate?.content_hash!==mapping.candidate_hash||canonicalContentHash(JSON.parse(candidate.candidate_json))!==candidate.content_hash)return false
  const refs=JSON.parse(mapping.sources_json) as {producer:string;sourceKey:string;digest:string}[]
  return refs.length>0&&refs.every(ref=>{
    const source=db.prepare('SELECT content_hash,tombstone,host_verified,session_id,source_revision,observation_json FROM dsh_memory_observations WHERE workspace=? AND producer=? AND source_key=? ORDER BY source_revision DESC LIMIT 1')
      .get<{content_hash:string;tombstone:number;host_verified:number;session_id:string;source_revision:number;observation_json:string}>(mapping.workspace,ref.producer,ref.sourceKey)
    return source?.content_hash===ref.digest&&source.tombstone===0&&capturePolicy(db,mapping.workspace,source.session_id).mode==='allowed'
      &&canonicalContentHash({value:JSON.parse(source.observation_json),sourceKey:ref.sourceKey,revision:source.source_revision,tombstone:false,hostVerified:source.host_verified===1})===source.content_hash
  })
}
