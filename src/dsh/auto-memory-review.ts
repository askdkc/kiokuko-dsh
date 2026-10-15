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
    return; // Post-task review replaces background admission and model extraction.
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
    return; // No memory bookkeeping prerequisite for ordinary tasks.
  }
  async acceptInput(workspace:string,sessionId:string,text:string):Promise<void>{
    const refusal=captureRefusal(text);if(!refusal)return
    await this.options.runtime.withDatabase(db=>withImmediateTransaction(db,()=>excludeCapture(db,workspace,sessionId,refusal.mode,refusal.reason,this.now())))
    abortCapture(workspace,sessionId)
    await this.options.onCapturePolicy?.(sessionId,refusal.mode).catch(()=>undefined)
  }
  notify(binding:ReviewBinding,throughSeq:number,origin:'periodic'|'boundary'='periodic'):void {
    return; // No automatic pre-approval extraction or durable proposal.
  }
  async scan(binding:ReviewBinding,throughSeq:number,origin:'periodic'|'manual'|'boundary'='periodic'):Promise<ReviewJob|undefined>{
    return; // Organization requires the native post-task permission question.
  }
  async reserve(range:ReviewRange,origin:ReviewJob['origin'],parent?:ReviewJob,contextStartSeq?:number):Promise<ReviewJob>{
    throw new Error('post_task_memory_review_required');
  }
  async retry(workspace:string,id:string):Promise<ReviewJob>{
    throw new Error('post_task_memory_review_required');
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
