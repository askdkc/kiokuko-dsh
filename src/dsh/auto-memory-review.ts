import type { DshRuntime } from './runtime.js'
import type { DshLogEvent, DshLlm } from './session-memory-finalizer.js'
import type { DshSessionLogMirror } from './session-log-mirror.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { abortCapture, assertCaptureAllowed, capturePolicy, captureRefusal, excludeCapture } from '../memory/capture-policy.js'
import { memorySnapshots } from '../memory/review/adoption.js'
import { MemoryReviewConfig, REVIEW_SYSTEM, type ReviewEvidence, type ReviewConfig, type ReviewJob, type ReviewRange } from '../memory/review/contracts.js'
import { reviewEvidenceWithContext, completedReviewTurns, reviewManifest, reviewModel } from '../memory/review/evidence.js'
import { admitReview, configureReview, recordReviewTurns, reserveReview, reviewSettings, reviewState } from '../memory/review/store.js'
import type { ReviewWorkerOptions } from '../memory/review/worker.js'
import { jobRange, MemoryReviewWorker } from '../memory/review/worker.js'

export interface ReviewNativeSession {
  id:string; seq?:number; firstLiveSeq?:number; inheritedEventCount?:number;
  header?:{parentSession?:string;isSeeded?:boolean;origin?:string}; eventAt?:(seq:number)=>DshLogEvent|undefined
}
export interface ReviewBinding {workspace:string;runId:string;session:ReviewNativeSession;startSeq:number}
export class AutoMemoryReviewCoordinator {
  readonly worker:MemoryReviewWorker; readonly now:()=>string
  #config:ReviewConfig; #generations=new Map<string,number>(); #tails=new Map<string,Promise<unknown>>(); #closed=false
  constructor(readonly options:{runtime:Pick<DshRuntime,'withDatabase'>;mirror:DshSessionLogMirror;llm?:DshLlm;config?:ReviewConfig;onChanged?:ReviewWorkerOptions['onChanged'];onCapturePolicy?:(sessionId:string,mode:'held'|'excluded')=>Promise<void>;flush?:(session:object)=>PromiseLike<unknown>;now?:()=>string}){
    this.#config=MemoryReviewConfig.parse(options.config??{});this.now=options.now??(()=>new Date().toISOString())
    this.worker=new MemoryReviewWorker({runtime:options.runtime,source:options.mirror,...(options.llm?{llm:options.llm}:{}),now:this.now,...(options.onChanged?{onChanged:options.onChanged}:{})})
  }
  async start(workspace:string):Promise<void>{
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
      configureReview(db,workspace,this.#config,this.now())
      const current=reviewSettings(db,workspace)!
      // A cold host may disable capture, but cannot silently re-enable a newer setting.
      if(this.#config.mode==='off'&&current.config.mode!=='off')configureReview(db,workspace,this.#config,this.now(),current.generation)
      this.#generations.set(workspace,reviewSettings(db,workspace)!.generation)
    }))
    this.worker.kick(workspace)
  }
  async setMode(workspace:string,mode:ReviewConfig['mode']):Promise<void>{
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
      configureReview(db,workspace,this.#config,this.now())
      const current=reviewSettings(db,workspace)!
      configureReview(db,workspace,{...current.config,mode},this.now(),current.generation)
      this.#generations.set(workspace,reviewSettings(db,workspace)!.generation)
    }))
    this.#config={...this.#config,mode};this.worker.abort()
    if(mode!=='off')this.worker.kick(workspace)
  }
  async configure(config:ReviewConfig):Promise<void>{
    const next=MemoryReviewConfig.parse(config)
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
      for(const [workspace,generation] of this.#generations){
        configureReview(db,workspace,next,this.now(),generation)
        this.#generations.set(workspace,reviewSettings(db,workspace)!.generation)
      }
    }))
    this.#config=next;this.worker.abort()
  }
  async bind(binding:ReviewBinding):Promise<void>{
    if(this.#closed||binding.session.header?.origin==='subagent')return
    // Only the exact native indexed API qualifies; no full-history snapshot fallback.
    const admittedAfter=Math.max(binding.startSeq,binding.session.inheritedEventCount??0)-1
    const unchanged=(sourceGeneration:string)=>this.options.runtime.withDatabase(db=>{
      const state=reviewState(db,binding.runId),settings=reviewSettings(db,binding.workspace)
      const run=db.prepare('SELECT workspace,dsh_session_id,status FROM ledger_runs WHERE run_id=?')
        .get<{workspace:string;dsh_session_id:string;status:string}>(binding.runId)
      return state?.workspace===binding.workspace && state.session_id===binding.session.id
        && state.source_generation===sourceGeneration && state.admitted_after_seq===admittedAfter
        && run?.workspace===binding.workspace && run.dsh_session_id===binding.session.id
        && ['active','intake'].includes(run.status) && settings?.generation===this.#generations.get(binding.workspace)
        && settings!==undefined && canonicalContentHash(settings.config)===canonicalContentHash(this.#config)
        && capturePolicy(db,binding.workspace,binding.session.id).mode==='allowed'
    })
    const first=binding.session.eventAt?.(0)
    // A repeated bind must not rewrite the first mirrored event merely to rediscover its identity.
    if(first && await this.options.mirror.matchesEvent(binding.session.id,first).catch(()=>false)) {
      const previousGeneration=await this.options.mirror.sourceGeneration(binding.session.id).catch(()=>undefined)
      if(previousGeneration && await unchanged(previousGeneration)){this.worker.kick(binding.workspace);return}
    }
    if(first)await this.options.mirror.observe(binding.session.id,first)
    const sourceGeneration=await this.options.mirror.sourceGeneration(binding.session.id)
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
      configureReview(db,binding.workspace,this.#config,this.now())
      if(!this.#generations.has(binding.workspace))this.#generations.set(binding.workspace,reviewSettings(db,binding.workspace)!.generation)
      const parent=binding.session.header?.parentSession
      if(parent){
        const policy=capturePolicy(db,binding.workspace,parent)
        if(policy.mode!=='allowed')excludeCapture(db,binding.workspace,binding.session.id,policy.mode,'capture_lineage_excluded',this.now())
        else if(!db.prepare('SELECT 1 FROM ledger_runs WHERE workspace=? AND dsh_session_id=?').get(binding.workspace,parent))excludeCapture(db,binding.workspace,binding.session.id,'held','capture_lineage_unknown',this.now())
      }else if(binding.session.header?.isSeeded||Number(binding.session.inheritedEventCount)>0)excludeCapture(db,binding.workspace,binding.session.id,'held','capture_lineage_unknown',this.now())
      admitReview(db,{workspace:binding.workspace,sessionId:binding.session.id,runId:binding.runId,sourceGeneration,startSeq:Math.max(binding.startSeq,binding.session.inheritedEventCount??0),endSeq:binding.startSeq})
    }))
    const policy=await this.options.runtime.withDatabase(db=>capturePolicy(db,binding.workspace,binding.session.id))
    if(policy.mode!=='allowed')await this.options.onCapturePolicy?.(binding.session.id,policy.mode).catch(()=>undefined)
    this.worker.kick(binding.workspace)
  }
  async acceptInput(workspace:string,sessionId:string,text:string):Promise<void>{
    const refusal=captureRefusal(text);if(!refusal)return
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>excludeCapture(db,workspace,sessionId,refusal.mode,refusal.reason,this.now())))
    abortCapture(workspace,sessionId)
    await this.options.onCapturePolicy?.(sessionId,refusal.mode).catch(()=>undefined)
  }
  notify(binding:ReviewBinding,throughSeq:number,origin:'periodic'|'boundary'='periodic'):void {
    if(this.#closed)return
    const previous=this.#tails.get(binding.runId)??Promise.resolve()
    const operation=previous.catch(()=>undefined).then(()=>this.scan(binding,throughSeq,origin)).catch(async error=>{
      const reason=error instanceof Error&&['source_unavailable','input_too_large','capture_excluded','run_terminal','host_capability_missing','review_off'].includes(error.message)?error.message:'review_deferred'
      await this.options.runtime.withDatabase(db=>db.prepare('UPDATE memory_review_states SET reason=? WHERE run_id=? AND reason IS NOT ?').run(reason,binding.runId,reason))
    }).finally(()=>{if(this.#tails.get(binding.runId)===operation)this.#tails.delete(binding.runId)})
    this.#tails.set(binding.runId,operation)
    void operation.catch(()=>undefined)
  }
  async scan(binding:ReviewBinding,throughSeq:number,origin:'periodic'|'manual'|'boundary'='periodic'):Promise<ReviewJob|undefined>{
    if(this.#closed)return
    const {runtime,mirror}=this.options
    const state=await runtime.withDatabase(db=>{assertCaptureAllowed(db,binding.workspace,binding.session.id);return reviewState(db,binding.runId)})
    if(!state)return
    if(state.terminal_outcome)throw new Error('run_terminal')
    const settings=await runtime.withDatabase(db=>reviewSettings(db,binding.workspace)!)
    if(settings.config.mode==='off')throw new Error('review_off')
    const checkpoint=await mirror.checkpoint(binding.session.id)
    const boundaryEvent=binding.session.eventAt?.(throughSeq)
    const alreadyClassified = throughSeq<=state.scanned_through_seq && checkpoint.nativeDurableThrough>=throughSeq
      && checkpoint.confirmedThrough>=throughSeq && !checkpoint.error && checkpoint.health==='healthy'
      && boundaryEvent!==undefined && await mirror.matchesEvent(binding.session.id,boundaryEvent)
      && await mirror.sourceGeneration(binding.session.id)===state.source_generation
    if(!alreadyClassified){
      if(!this.options.flush||!binding.session.eventAt)throw new Error('host_capability_missing')
      if(await this.options.flush(binding.session)===false)throw new Error('host_capability_missing')
      if(this.#closed)return
      // Catch missed notifications from the exact indexed native range, never snapshot the prefix.
      for(let seq=Math.max(state.scanned_through_seq+1,checkpoint.mirroredThrough+1);seq<=throughSeq;seq++){
        const event=binding.session.eventAt(seq);if(!event)throw new Error('source_unavailable')
        await mirror.observe(binding.session.id,event)
      }
      const confirmed=await mirror.checkpointThroughAfterNativeFlush(binding.session,throughSeq,Math.min(throughSeq,state.scanned_through_seq+1))
      if((confirmed.rangeConfirmedThrough??-1)<throughSeq||confirmed.error)throw new Error('source_unavailable')
      if(await mirror.sourceGeneration(binding.session.id)!==state.source_generation)throw new Error('source_unavailable')
      if(throughSeq>state.scanned_through_seq){
        const classified=await completedReviewTurns(mirror.streamRange(binding.session.id,state.scanned_through_seq+1,throughSeq))
        await runtime.withDatabase(db=>withImmediateTransaction(db,()=>recordReviewTurns(db,state,classified.turns,classified.scanned)))
      }
    }
    const range=await runtime.withDatabase(db=>{
      const current=reviewState(db,binding.runId)!
      const pending=db.prepare('SELECT min(start_seq) AS start,max(end_seq) AS end,count(DISTINCT start_seq) AS n FROM memory_review_turns WHERE run_id=? AND end_seq>?')
        .get<{start:number|null;end:number|null;n:number}>(binding.runId,current.scheduled_through_seq)!
      const minimum=origin==='manual'?1:origin==='boundary'?settings.config.minimumTurns:settings.config.turnInterval
      if(pending.n<minimum||pending.start===null||pending.end===null||origin==='boundary'&&!settings.config.boundaryFlush)return
      return {workspace:binding.workspace,sessionId:binding.session.id,runId:binding.runId,sourceGeneration:state.source_generation,startSeq:pending.start,endSeq:pending.end}
    })
    if(!range){this.worker.kick(binding.workspace);return}
    const job=await this.reserve(range,origin)
    this.worker.kick(binding.workspace);return job
  }
  async reserve(range:ReviewRange,origin:ReviewJob['origin'],parent?:ReviewJob,contextStartSeq?:number):Promise<ReviewJob>{
    if(this.#closed)throw new Error('shutdown')
    const settings=await this.options.runtime.withDatabase(db=>{assertCaptureAllowed(db,range.workspace,range.sessionId);return reviewSettings(db,range.workspace)!})
    let evidence:ReviewEvidence[]=[],blockedReason:string|undefined
    contextStartSeq??=parent?(JSON.parse(parent.input_json) as {contextStartSeq?:number}).contextStartSeq:undefined
    try{evidence=await reviewEvidenceWithContext(this.options.mirror,range,settings.config.maxInputBytes,contextStartSeq)}
    catch(error){if(error instanceof Error&&['input_too_large','secret_detected','insufficient_context'].includes(error.message))blockedReason=error.message;else throw error}
    // Include the complete request envelope before deciding a turn-boundary split.
    const snapshot=await this.options.runtime.withDatabase(db=>memorySnapshots(db,range,evidence.map(e=>e.text).join('\n')))
    if(Buffer.byteLength(JSON.stringify({system:REVIEW_SYSTEM,range,evidence,...snapshot}))+1024>settings.config.maxInputBytes)blockedReason='input_too_large'
    if(blockedReason==='input_too_large'&&!parent){
      const turns=await this.options.runtime.withDatabase(db=>db.prepare('SELECT DISTINCT start_seq,end_seq FROM memory_review_turns WHERE run_id=? AND start_seq>=? AND end_seq<=? ORDER BY start_seq').all<{start_seq:number;end_seq:number}>(range.runId,range.startSeq,range.endSeq))
      if(turns.length>1){
        const cut=Math.floor(turns.length/2)
        const first=await this.reserve({...range,endSeq:turns[cut-1]!.end_seq},origin,undefined,contextStartSeq)
        // Later chunks must see candidates adopted from earlier chunks. Never
        // freeze all snapshots before the first correction has been evaluated.
        this.worker.kick(range.workspace);await this.worker.whenIdle()
        await this.reserve({...range,startSeq:turns[cut]!.start_seq},origin,undefined,contextStartSeq??range.startSeq)
        return first
      }
    }
    const header=await this.options.mirror.latestEvent(range.sessionId,'request/header',range.endSeq)
    const context=await this.options.mirror.latestEvent(range.sessionId,'request/context',range.endSeq)
    const model=parent?(JSON.parse(parent.input_json) as {model:NonNullable<ReturnType<typeof reviewModel>>}).model:reviewModel(header,context)
    if(!model)throw new Error('model_unavailable')
    return this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>{
      return reserveReview(db,range,{evidence:reviewManifest(evidence),...snapshot,model,...(contextStartSeq===undefined?{}:{contextStartSeq}),...(blockedReason?{blockedReason}:{})},origin,this.now(),parent)
    }))
  }
  async retry(workspace:string,id:string):Promise<ReviewJob>{
    const parent=await this.options.runtime.withDatabase(db=>{
      const row=db.prepare('SELECT * FROM memory_review_jobs WHERE id=? AND workspace=?').get<ReviewJob>(id,workspace)
      if(!row)throw new Error('job_not_found')
      assertCaptureAllowed(db,workspace,row.session_id)
      if(reviewSettings(db,workspace)?.config.mode==='off')throw new Error('review_off')
      return row
    })
    const existing=await this.options.runtime.withDatabase(db=>db.prepare('SELECT * FROM memory_review_jobs WHERE retry_parent_id=?').get<ReviewJob>(parent.id))
    if(existing)return existing
    try {
      if(await this.options.mirror.sourceGeneration(parent.session_id)!==parent.source_generation)throw new Error('source_unavailable')
      const job=await this.reserve(jobRange(parent),'retry',parent);this.worker.kick(workspace);return job
    } catch(error) {
      if(error instanceof Error&&error.message==='source_unavailable')await this.options.runtime.withDatabase(db=>db.prepare("UPDATE memory_review_jobs SET reason='source_unavailable' WHERE id=? AND resolved_by IS NULL").run(parent.id))
      throw error
    }
  }
  async status(workspace:string,sessionId:string):Promise<Record<string,unknown>>{
    return this.options.runtime.withDatabase(db=>{
      const settings=reviewSettings(db,workspace),policy=capturePolicy(db,workspace,sessionId)
      const jobs=db.prepare(`SELECT id,run_id,state,reason,start_seq,end_seq,dispatched_at,completed_at,usage_json,duration_ms,request_bytes,adoption_wait_ms,next_eligible_at,retry_parent_id,resolved_by,
        json_extract(input_json,'$.model.provider') AS provider,json_extract(input_json,'$.model.model') AS model
        FROM memory_review_jobs WHERE workspace=? AND session_id=? ORDER BY created_at DESC LIMIT 50`).all<Record<string,unknown>&{id:string;run_id:string}>(workspace,sessionId).map(row=>{
          const {usage_json,...job}=row
          const held=!!db.prepare("SELECT 1 FROM memory_review_effects WHERE job_id=? AND disposition='held'").get(row.id)
          const finalizer=!!db.prepare("SELECT 1 FROM dsh_memory_finalizations WHERE run_id=? AND status IN ('pending','processing')").get(row.run_id)
          const child=!!db.prepare('SELECT 1 FROM memory_review_jobs WHERE retry_parent_id=?').get(row.id)
          return {...job,usage:typeof usage_json==='string'?JSON.parse(usage_json):null,
            retryAvailable:policy.mode==='allowed'&&settings?.config.mode!=='off'&&!row.resolved_by&&!finalizer&&!child&&row.reason!=='source_unavailable'&&(['held','rejected','cancelled'].includes(String(row.state))||row.state==='completed'&&held)}
        })
      const calls=db.prepare('SELECT count(*) AS n FROM memory_review_jobs WHERE workspace=? AND dispatch_day=?').get<{n:number}>(workspace,this.now().slice(0,10))!.n
      return {requestedMode:this.#config.mode,effectiveMode:settings?.config.mode??this.#config.mode,settingsGeneration:settings?.generation??null,capture:policy,
        dailyCalls:calls,remaining:Math.max(0,(settings?.config.dailyCalls??this.#config.dailyCalls)-calls),
        states:db.prepare('SELECT * FROM memory_review_states WHERE workspace=? AND session_id=?').all(workspace,sessionId),jobs,
        effects:db.prepare('SELECT disposition,reason,count(*) AS count FROM memory_review_effects WHERE workspace=? AND session_id=? GROUP BY disposition,reason').all(workspace,sessionId),
        finalizers:db.prepare('SELECT run_id,status,attempt_count,capture_admission,last_error_code,provider,model,input_tokens,output_tokens FROM dsh_memory_finalizations WHERE workspace=? AND dsh_session_id=?').all(workspace,sessionId),
        evolutionCalls:db.prepare('SELECT outcome,count(*) AS calls,sum(input_tokens) AS inputTokens,sum(output_tokens) AS outputTokens FROM memory_evolution_calls WHERE workspace=? GROUP BY outcome').all(workspace)}
    })
  }
  async exclude(workspace:string,sessionId:string):Promise<void>{
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>excludeCapture(db,workspace,sessionId,'excluded','capture_excluded',this.now())))
    abortCapture(workspace,sessionId)
  }
  async whenIdle():Promise<void>{while(this.#tails.size)await Promise.allSettled(this.#tails.values());await this.worker.whenIdle()}
  async dispose():Promise<void>{this.#closed=true;await this.worker.dispose()}
}
