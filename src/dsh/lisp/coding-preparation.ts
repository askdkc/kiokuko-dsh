import {createHash,randomUUID} from 'node:crypto'
import {codingIntent, codingContinuation} from '../coding-workflow/intent.js'
import type {LispCodingInput} from './coding-choice.js'
import { LispCodingCancelled, type LispCodingQuestionResult } from '../coding-question.js'

export const LISP_PROTOTYPE_GUIDANCE = 'Lisp is the selected execution route. Use lisp_eval for calculations and transformations, and kioku.process:run / start-job inside Lisp for external commands including Git, GitHub CLI, builds and tests. Do not call native Bash/zsh/PowerShell directly while Lisp is enabled. Read/search/Skill and owned file tools remain available. A preliminary prototype is optional in ordinary development. Native permissions still apply. Never bypass a denial or automatically fall back after cancellation, timeout, unknown outcomes or partial effects. An explicitly protected coding workflow retains its own prototype and verification gates.'
const PROTECTED_PROTOTYPE_GUIDANCE = 'This protected workflow requires a small relevant lisp_eval prototype:true and complete saved-result inspection with lisp_inspect before implementation. Prototype success is not task completion. Two failures stop automatic prototype retries; repair the cause or explicitly disable Lisp. Ordinary read tools and conversation remain available; Bash still follows host permissions.'
type Agent = LispCodingInput['agent']
interface Preparation {
  agent: Agent; sessionId: string; root: string; task: string; key: string
  choice?: 'yes'|'no'; answerRef?: string
  protectedWorkflow: boolean; reason?: string
  phase: 'selected'|'cancelled'|'unavailable'|'choice_pending'|'prototype_required'|'result_pending'|'reviewed'|'declined'|'failed'
  attempts: number; failures: number; operationId?: string; pending?: Promise<void>
}
/** A bounded request protocol. It does not grant native authority or classify arbitrary Lisp effects. */
export class LispCodingPreparation {
  private readonly states = new WeakMap<object,Preparation>()
  constructor(private readonly host: {
    identity(agent:Agent):{sessionId:string;root:string}
    enabled(agent:Agent):boolean
    selected?(agent:Agent):Promise<boolean>
    deactivate?(agent:Agent):Promise<void>
    choose(input:LispCodingInput):Promise<LispCodingQuestionResult>
    activate(agent:Agent, signal?:AbortSignal):Promise<void>
  }) {}
  private current(agent:Agent):Preparation|undefined {
    const state=this.states.get(agent)
    if (!state) return undefined
    const identity=this.host.identity(agent)
    return state && state.agent===agent && state.sessionId===identity.sessionId && state.root===identity.root ? state : undefined
  }
  async prepare(input:LispCodingInput):Promise<void> {
    const previous=this.current(input.agent)
    if (previous?.task === input.task && previous.choice && ['selected','declined','reviewed','prototype_required'].includes(previous.phase)) { await previous.pending; return }
    // A resolved provider decision is a positive signal only. Negative, unresolved or
    // unavailable decisions keep the deterministic detector and never replace the request intent.
    const semanticCoding = input.requestIntent?.action === 'change' && input.requestIntent.changeScope === 'implementation'
    if (!semanticCoding && !codingIntent(input.task)) {
      if (!codingContinuation(input.task)) this.states.delete(input.agent)
      return
    }
    const identity=this.host.identity(input.agent)
    const key=createHash('sha256').update(JSON.stringify([identity,input.turn,input.task])).digest('hex')
    if (previous?.key===key) { await previous.pending; if(previous.phase==='cancelled')throw new LispCodingCancelled(); if(previous.phase==='unavailable')throw new Error(previous.reason); return }
    const state:Preparation={agent:input.agent,...identity,task:input.task,key,protectedWorkflow:false,phase:'choice_pending',attempts:0,failures:0}
    this.states.set(input.agent,state)
    state.pending=(async()=>{
      const manualSelected = this.host.selected ? await this.host.selected(input.agent) : this.host.enabled(input.agent)
      if(this.current(input.agent)!==state || state.key!==key || input.signal.aborted)throw new LispCodingCancelled('Lisp coding request changed before its choice')
      const selected=manualSelected
        ? {status:'answered' as const,choice:'yes' as const,answerRef:`enabled-session:${identity.sessionId}:${key}`}
        : await this.host.choose(input)
      if(this.current(input.agent)!==state || state.key!==key)throw new LispCodingCancelled('Lisp coding request changed while awaiting its choice')
      if(input.signal.aborted || selected.status==='cancelled') { state.phase='cancelled'; throw new LispCodingCancelled() }
      if(selected.status==='pending')return
      if(selected.status==='unavailable') { state.phase='unavailable'; state.reason=selected.reason; throw new Error(selected.reason) }
      state.choice=selected.choice;state.answerRef=selected.answerRef
      state.phase=selected.choice==='yes'?'selected':'declined'
      if(selected.choice==='yes')await this.host.activate(input.agent,input.signal)
      else await this.host.deactivate?.(input.agent)
    })()
    try{await state.pending}catch(error){if(this.current(input.agent)===state && state.key===key && state.phase==='choice_pending'){state.phase=input.signal.aborted?'cancelled':'unavailable';state.reason=error instanceof Error?error.message:String(error)}throw error}finally{delete state.pending}
  }
  async selectTask(input:LispCodingInput, choice:'yes'|'no', answerRef:string):Promise<void> {
    input.signal.throwIfAborted()
    const identity=this.host.identity(input.agent)
    const previous=this.current(input.agent)
    if(previous?.task===input.task && previous.answerRef===answerRef && previous.choice===choice
      && (choice==='no' || this.host.enabled(input.agent))) return
    const key=createHash('sha256').update(JSON.stringify([identity,input.task,answerRef])).digest('hex')
    const state:Preparation={agent:input.agent,...identity,task:input.task,key,choice,answerRef,protectedWorkflow:false,
      phase:choice==='yes'?'selected':'declined',attempts:0,failures:0}
    this.states.set(input.agent,state)
    try {
      if(choice==='yes')await this.host.activate(input.agent,input.signal)
      else await this.host.deactivate?.(input.agent)
    } catch(error) { state.phase='unavailable'; state.reason=error instanceof Error?error.message:String(error); throw error }
    input.signal.throwIfAborted()
  }
  choiceFor(agent:Agent,task:string):{choice:'yes'|'no';answerRef:string}|undefined {
    const state=this.current(agent)
    return state?.task===task && state.choice && state.answerRef ? {choice:state.choice,answerRef:state.answerRef}:undefined
  }
  answered(agent:Agent,task:string,choice:'yes'|'no',answerRef:string):void {
    let state=this.current(agent)
    if(!state || state.task!==task || state.answerRef && state.answerRef!==answerRef) {
      const identity=this.host.identity(agent),key=createHash('sha256').update(JSON.stringify([identity,task,answerRef])).digest('hex')
      state={agent,...identity,task,key,protectedWorkflow:true,phase:'choice_pending',attempts:0,failures:0}
      this.states.set(agent,state)
    }
    if(state.choice===choice && state.protectedWorkflow)return
    state.key=createHash('sha256').update(JSON.stringify([state.key,task,answerRef,'protected'])).digest('hex')
    state.protectedWorkflow=true
    state.choice=choice;state.answerRef=answerRef;state.phase=choice==='yes'?'prototype_required':'declined';state.attempts=0;state.failures=0;delete state.operationId
  }
  manual(agent:Agent,enabled:boolean,answerRef?:string):void {
    const state=this.current(agent)
    if(!state || state.phase==='cancelled')return
    state.key=createHash('sha256').update(JSON.stringify([state.key,enabled,answerRef ?? randomUUID()])).digest('hex')
    state.choice=enabled?'yes':'no';state.answerRef=answerRef ?? `human-command:${state.key}:${enabled}`
    state.phase=enabled?(state.protectedWorkflow?'prototype_required':'selected'):'declined';state.attempts=0;state.failures=0;delete state.operationId
  }
  cancelled(agent:Agent,task:string):void {
    const state=this.current(agent)
    if(state?.task===task){state.key=randomUUID();state.phase='cancelled';delete state.choice;delete state.answerRef}
  }
  binding(agent:Agent):string|undefined { return this.current(agent)?.key }
  status(agent:Agent):object {
    const state=this.current(agent)
    return state?{phase:state.phase,attempts:state.attempts,failures:state.failures,operationId:state.operationId ?? null,verified:state.phase==='reviewed',guidance:state.phase==='cancelled'?'Implementation attempt cancelled; work retained. Do not automatically retry or switch tools.':state.phase==='unavailable'?`Question unavailable: ${state.reason}`:state.phase==='selected'?LISP_PROTOTYPE_GUIDANCE:state.phase==='declined'?'Use ordinary tools; do not reopen Lisp for this request.':state.phase==='reviewed'?'The prototype was inspected. Implement and verify separately; this is not task completion.':state.phase==='choice_pending'?'Await the human Lisp choice; reads and conversation remain available.':state.protectedWorkflow?PROTECTED_PROTOTYPE_GUIDANCE:LISP_PROTOTYPE_GUIDANCE}:{phase:'not_applicable',verified:false}
  }
  denial(agent:Agent,name:string,args:any,parent?:unknown):string|undefined {
    const state=this.current(agent)
    if(!state || parent!==undefined || state.choice==='no' || state.phase==='reviewed')return
    const effect = ['bash','zsh','exec','run_code','write','edit','delete','remove','kioku_write','kioku_edit','kioku_remove','kioku_exec','lisp_eval','lisp_apply','lisp_call','lisp_hot_call'].includes(name)
    if(state.phase==='cancelled')return effect?'LISP_REQUEST_CANCELLED: this implementation attempt stopped. Do not retry or switch tools; a new explicit implementation request is required.':undefined
    if(state.phase==='unavailable')return effect?`LISP_CHOICE_UNAVAILABLE: ${state.reason}`:undefined
    if(state.phase==='choice_pending')return effect?'LISP_CHOICE_PENDING: answer the Lisp choice or explicitly use /kioku-lisp enable or disable. Ordinary read tools and conversation remain available; Bash follows host permissions.':undefined
    if(!state.protectedWorkflow || !this.host.enabled(agent))return
    if(name==='lisp_eval' && args?.prototype===true) {
      return state.failures>=2?'LISP_PROTOTYPE_FAILED: two attempts failed; repair the cause or explicitly disable Lisp.':undefined
    }
    if(effect)
      return `LISP_PROTOTYPE_REQUIRED: ${state.phase}. ${PROTECTED_PROTOTYPE_GUIDANCE}`
  }
  observed(agent:Agent,name:string,args:any,result:any,requestKey:string|undefined):void {
    const state=this.current(agent)
    if(!state || state.key!==requestKey || state.choice!=='yes' || result?.replay===true)return
    if(name==='lisp_eval' && args.prototype===true && state.phase!=='reviewed') {
      state.attempts++
      if(result?.ok===true && typeof result.operationId==='string'){
        state.operationId=result.operationId;state.phase='result_pending'
      }else { state.failures++; state.phase=state.protectedWorkflow?(state.failures>=2?'failed':'prototype_required'):'selected' }
    }
    if(name==='lisp_inspect' && state.phase==='result_pending' && args.resultOperationId===state.operationId && args.section === 'result' && args.pointer === undefined && (args.offset ?? 0) === 0
      && result?.ok===true && result.state === 'SUCCEEDED' && result.nextOffset === null)
      state.phase='reviewed'
  }
}
