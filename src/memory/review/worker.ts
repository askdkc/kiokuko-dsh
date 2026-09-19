import type { DshRuntime } from '../../dsh/runtime.js'
import type { DshLlm, DshLogEvent } from '../../dsh/session-memory-finalizer.js'
import { watchCapture } from '../capture-policy.js'
import { TransactionCommitUncertainError, withImmediateTransaction } from '../../db/transaction.js'
import { abortableStream } from '../../deep-thinker/abortable-stream.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { findSecretInValue } from '../secrets.js'
import { finalizationObservationScope } from '../../dsh/efficiency.js'
import { adoptMemories, type AdoptionResult } from './adoption.js'
import { reviewEvidenceWithContext, object, reviewManifest } from './evidence.js'
import { REVIEW_SYSTEM, ReviewResult, type ReviewInput, type ReviewJob, type ReviewRange } from './contracts.js'
import { advanceReviewed, assertReviewClaim, claimReview, dispatchReview, releaseMemoryLease, reviewSettings } from './store.js'

export interface ReviewReadPort { streamRange(sessionId:string,start:number,end:number):AsyncIterable<DshLogEvent>; sourceGeneration(sessionId:string):Promise<string> }
export interface ReviewWorkerOptions {
  runtime:Pick<DshRuntime,'withDatabase'>; source:ReviewReadPort; llm?:DshLlm; now?:()=>string;
  onChanged?:(job:ReviewJob,result:AdoptionResult)=>void|PromiseLike<void>
}
export const jobRange=(job:ReviewJob):ReviewRange=>({workspace:job.workspace,sessionId:job.session_id,runId:job.run_id,sourceGeneration:job.source_generation,startSeq:job.start_seq,endSeq:job.end_seq})
export class MemoryReviewWorker {
  #drain:Promise<void>|undefined; #closed=false; #abort:AbortController|undefined; #activeRun:string|undefined; #workspaces=new Set<string>()
  readonly now:()=>string
  constructor(readonly options:ReviewWorkerOptions){this.now=options.now??(()=>new Date().toISOString())}
  kick(workspace:string):void {
    if(this.#closed)return
    this.#workspaces.add(workspace)
    if(this.#drain)return
    this.#drain=this.#run().catch(()=>{/* Persistent claims recover on the next activity. */}).finally(()=>{this.#drain=undefined;const next=this.#workspaces.values().next().value;if(next&&!this.#closed)this.kick(next)})
  }
  async whenIdle():Promise<void>{while(this.#drain)await this.#drain}
  async dispose():Promise<void>{this.#closed=true;this.#abort?.abort();await this.whenIdle()}
  abort(runId?:string):void{if(runId===undefined||this.#activeRun===runId)this.#abort?.abort()}
  async #run():Promise<void>{
    while(this.#workspaces.size&&!this.#closed){
      const workspace=this.#workspaces.values().next().value!;this.#workspaces.delete(workspace)
      while(!this.#closed){
        const job=await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>claimReview(db,workspace,this.now())))
        if(!job)break
        await this.#process(job)
      }
    }
  }
  async #process(job:ReviewJob):Promise<void>{
    const controller=new AbortController();this.#abort=controller;this.#activeRun=job.run_id
    const unwatch=watchCapture(job.workspace,job.session_id,controller)
    const started=performance.now();let dispatched=false,reason='model_failed',timer:ReturnType<typeof setTimeout>|undefined
    const usage:Record<string,number|null>={inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,reasoningTokens:null}
    try{
      const settings=await this.options.runtime.withDatabase(db=>reviewSettings(db,job.workspace)!)
      if(!this.options.llm){reason='model_unavailable';throw new Error(reason)}
      const input=JSON.parse(job.input_json) as ReviewInput
      if(input.blockedReason){reason=input.blockedReason;throw new Error(reason)}
      if(canonicalContentHash(input)!==job.input_hash)throw new Error('input_changed')
      reason='source_unavailable'
      if(await this.options.source.sourceGeneration(job.session_id)!==job.source_generation)throw new Error(reason)
      const evidence=await reviewEvidenceWithContext(this.options.source,jobRange(job),settings.config.maxInputBytes,input.contextStartSeq)
      if(canonicalContentHash(reviewManifest(evidence))!==canonicalContentHash(input.evidence))throw new Error('source_changed')
      const payload={range:jobRange(job),evidence,existing:input.existing,lookupIncomplete:input.lookupIncomplete}
      const messages=[{role:'user',content:[{type:'text',text:JSON.stringify(payload)}]}]
      const request={provider:input.model.provider,model:input.model.model,...(input.model.reasoningEffort?{reasoningEffort:input.model.reasoningEffort}:{}),
        sessionId:job.session_id,purpose:'compaction' as const,system:REVIEW_SYSTEM,messages,tools:[],maxTokens:settings.config.maxOutputTokens,temperature:0,signal:controller.signal}
      const bytes=Buffer.byteLength(JSON.stringify({...request,signal:undefined}))
      await this.options.runtime.withDatabase(db=>db.prepare('UPDATE memory_review_jobs SET request_bytes=? WHERE id=? AND owner_nonce=?').run(bytes,job.id,job.owner_nonce))
      reason='input_too_large'
      if(bytes>settings.config.maxInputBytes)throw new Error(reason)
      reason='context_capacity_unknown'
      if(!input.model.contextWindow)throw new Error(reason)
      // Conservative capacity admission, not a reported tokenizer measurement.
      reason='context_capacity_exceeded'
      if(bytes+settings.config.maxOutputTokens+2048>input.model.contextWindow)throw new Error(reason)
      if(findSecretInValue({...request,signal:undefined})){reason='secret_detected';throw new Error(reason)}
      if(this.#closed)throw new Error('shutdown')
      dispatched=await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>dispatchReview(db,job,this.now())))
      if(!dispatched)return
      reason='model_failed';timer=setTimeout(()=>controller.abort(),settings.config.timeoutMs)
      let text='',finish=false
      await finalizationObservationScope.run(true,async()=>{
        for await(const raw of abortableStream(this.options.llm!.stream(request),controller.signal)){
          const chunk=object(raw)
          if(chunk.type==='text-delta'&&typeof chunk.text==='string')text+=chunk.text
          if(Buffer.byteLength(text)>Math.min(65536,settings.config.maxOutputTokens*16)){reason='output_limit';throw new Error(reason)}
          const reported=object(chunk.usage)
          for(const key of Object.keys(usage)){const value=reported[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)usage[key]=value}
          if(chunk.type==='finish')finish=object(chunk.reason).kind==='stop'
        }
      })
      if(!finish){reason='abnormal_finish';throw new Error(reason)}
      if((usage.outputTokens??0)>settings.config.maxOutputTokens){reason='output_limit';throw new Error(reason)}
      reason='invalid_schema';const result=ReviewResult.parse(JSON.parse(text))
      if(findSecretInValue(result)){reason='secret_detected';throw new Error(reason)}
      reason='source_changed'
      const current=await reviewEvidenceWithContext(this.options.source,jobRange(job),settings.config.maxInputBytes,input.contextStartSeq)
      if(await this.options.source.sourceGeneration(job.session_id)!==job.source_generation||canonicalContentHash(reviewManifest(current))!==canonicalContentHash(input.evidence))throw new Error(reason)
      controller.signal.throwIfAborted()
      const adoptionStarted=performance.now()
      const adopted=await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
        assertReviewClaim(db,job,this.now())
        db.prepare('UPDATE memory_review_jobs SET adoption_wait_ms=? WHERE id=?').run(performance.now()-adoptionStarted,job.id)
        const adoption=adoptMemories(db,{id:job.id,range:jobRange(job),evidence:current,existing:input.existing,operations:result.proposals,observe:settings.config.mode==='observe',now:this.now(),retry:job.origin==='retry'})
        db.prepare("UPDATE memory_review_jobs SET state='completed',result_json=?,usage_json=?,duration_ms=?,completed_at=?,reason=NULL WHERE id=? AND owner_nonce=?")
          .run(JSON.stringify(result),JSON.stringify(usage),performance.now()-started,this.now(),job.id,job.owner_nonce)
        if(job.retry_parent_id&&adoption.held===0){
          let parent:string|null=job.retry_parent_id
          while(parent){db.prepare('UPDATE memory_review_jobs SET resolved_by=? WHERE id=?').run(job.id,parent);parent=db.prepare('SELECT retry_parent_id FROM memory_review_jobs WHERE id=?').get<{retry_parent_id:string|null}>(parent)?.retry_parent_id??null}
        }
        advanceReviewed(db,job.run_id);releaseMemoryLease(db,job.run_id,job.owner_nonce!);return adoption
      }))
      if(settings.config.notifications==='changes'&&(adopted.added||adopted.updated)){
        try{void Promise.resolve(this.options.onChanged?.(job,adopted)).catch(()=>undefined)}catch{/* Commit is authoritative; notice delivery is optional. */}
      }
    }catch(error){
      if(error instanceof TransactionCommitUncertainError){
        const state=await this.options.runtime.withDatabase(db=>db.prepare('SELECT state FROM memory_review_jobs WHERE id=?').get<{state:string}>(job.id))
        if(state?.state==='completed')return
        reason='commit_uncertain'
      }else if(controller.signal.aborted)reason=this.#closed?'shutdown':'timeout'
      else if(error instanceof Error&&['input_too_large','secret_detected','source_unavailable'].includes(error.message))reason=error.message
      await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
        const deferred=!dispatched&&['model_unavailable','context_capacity_unknown','shutdown'].includes(reason)
        db.prepare("UPDATE memory_review_jobs SET state=?,reason=?,usage_json=?,duration_ms=?,owner_nonce=NULL,next_eligible_at=? WHERE id=? AND owner_nonce=? AND state IN ('claimed','dispatched')")
          .run(deferred?'deferred':'held',reason,JSON.stringify(usage),performance.now()-started,deferred?new Date(Date.parse(this.now())+60000).toISOString():null,job.id,job.owner_nonce)
        releaseMemoryLease(db,job.run_id,job.owner_nonce!)
      }))
    }finally{unwatch();if(timer)clearTimeout(timer);if(this.#abort===controller){this.#abort=undefined;this.#activeRun=undefined}}
  }
}
