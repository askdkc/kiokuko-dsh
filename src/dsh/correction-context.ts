import {canonicalContentHash} from '../serialization/validate.js'
import {queryScopedContextGated, type ScopedContextResult} from '../context/scoped-broker.js'
import {readEntry} from '../memory/entries.js'
import type {SqliteDatabase} from '../db/adapter.js'
import type {ResolvedProjectWorkspace} from '../memory/workspaces.js'
import type {TaskProfile} from '../akinator/types.js'
import {KIOKUKO_DSH_SOURCE_KIND} from './plugin-source.js'
import type {HybridSearchRuntime} from '../memory/hybrid-retrieval.js'
import {correctionSource,type CorrectionSource} from '../memory/correction-contract.js'
import {unclassifiedCorrection,type CorrectionMode} from '../memory/correction-contract.js'
import {classifyCorrection,correctionSourceCurrent,type CorrectionBackend} from '../memory/correction-classification.js'
import {correctionClassifier} from './decisions/correction.js'
import type {DecisionService} from './decisions/service.js'
export {correctionSource,type CorrectionSource} from '../memory/correction-contract.js'
export interface CorrectionReceipt {
  runId:string;workspace:string;repositoryRoot:string;requestDigest:string
  retrieval:'not_requested'|'no_correction'|'retrieved'|'unavailable'
  delivery:'not_delivered'|'delivered';sources:CorrectionSource[];inputDigest?:string
}
/** Optional memory lookup after admission. Never creates memories, reviews or a delivery claim. */
export async function readTaskCorrections(db:SqliteDatabase,input:{project:ResolvedProjectWorkspace;runId:string;task:string;profile:TaskProfile;signal:AbortSignal;runtime?:HybridSearchRuntime;decisions?:DecisionService|undefined;backend?:CorrectionBackend;correctionMode?:CorrectionMode}) {
  const receipt:CorrectionReceipt={runId:input.runId,workspace:input.project.workspace,repositoryRoot:input.project.repositoryRoot,
    requestDigest:canonicalContentHash(input.task),retrieval:'not_requested',delivery:'not_delivered',sources:[]}
  try {
    input.signal.throwIfAborted()
    const result=await queryScopedContextGated(db,{project:input.project,task:input.task,taskProfile:input.profile,limit:8,characterBudget:8000},candidate=>({persist:false,value:candidate,assertBeforePersist:()=>input.signal.throwIfAborted()}),input.runtime??{})
    const context=result.value
    const configured=await correctionClassifier(input.decisions),mode=input.correctionMode??configured.mode
    const items:typeof context.items=[]
    for(const item of context.items){
      const entry=readEntry(db,{workspace:item.workspace??input.project.workspace,entryId:item.entryId})
      if(entry.provenance.type!=='interaction_capture'||entry.provenance.reference!=='user_correction')continue
      const classification=mode==='off'?unclassifiedCorrection(entry,'mode_off'):await classifyCorrection(db,entry,input.backend??configured.backend,input.signal)
      receipt.sources.push(correctionSource(entry,item.origin,classification,mode));items.push(item)
    }
    input.signal.throwIfAborted()
    receipt.retrieval=items.length?'retrieved':'no_correction'
    return {context:items.length?{...context,items}:null,corrections:receipt}
  } catch(error) {
    input.signal.throwIfAborted()
    receipt.retrieval='unavailable'
    return {context:null,corrections:receipt}
  }
}
/** A projection attempt is not delivery: inspect the actual native provider input. */
export function observeCorrectionInput(receipt:CorrectionReceipt,allowed:ReadonlyMap<string,string>,messages:readonly any[]):CorrectionReceipt {
  if(receipt.retrieval!=='retrieved')return receipt
  const seen=new Set<string>()
  for(const message of messages){
    if(message?.role!=='user'||message.source?.kind!==KIOKUKO_DSH_SOURCE_KIND||!Array.isArray(message.source.sections))continue
    for(const section of message.source.sections){
      if(typeof section.name!=='string'||allowed.get(section.name)!==section.text)continue
      if(message.content?.length===1&&message.content[0]?.type==='text'&&message.content[0].text===section.text)seen.add(section.name)
    }
  }
  const selected=[...allowed].filter(([name])=>receipt.sources.some(source=>name===`memory:memory:${source.entryId}`))
  const delivered=selected.length===receipt.sources.length&&selected.every(([name])=>seen.has(name))
  const {inputDigest:_previous,...current}=receipt
  return {...current,delivery:delivered?'delivered':'not_delivered',...(delivered?{inputDigest:canonicalContentHash(selected)}:{})}
}
export function currentCorrectionSources(db:SqliteDatabase,receipt:CorrectionReceipt):boolean {
  return receipt.sources.every(source=>{
    try {const entry=readEntry(db,{workspace:source.workspace,entryId:source.entryId});return entry.status!=='superseded'&&entry.provenance.reference==='user_correction'
      &&correctionSourceCurrent(db,entry,source)}catch{return false}
  })
}
