import {createHash,randomUUID} from 'node:crypto'
import {codingIntent, codingContinuation} from '../coding-workflow/intent.js'
import type {LispCodingInput} from './coding-choice.js'
import { LispCodingCancelled, type LispCodingQuestionResult } from '../coding-question.js'
import { LispError } from './contracts.js'
import { savedResultVersion } from './inspection.js'
import { PrototypeReview, type InspectionReceipt } from './prototype-review.js'

export const LISP_PROTOTYPE_GUIDANCE = 'Lisp is the selected execution route. Use lisp_eval for calculations and transformations, kioku.test:node / vitest for selected tests, and kioku.process:run / start-job for other external commands including Git, GitHub CLI and builds. Do not call native Bash/zsh/PowerShell directly while Lisp is enabled. Read/search/Skill and owned file tools remain available. A preliminary prototype is optional in ordinary development. Native permissions still apply. Never bypass a denial or automatically fall back after cancellation, timeout, unknown outcomes or partial effects. An explicitly protected coding workflow retains its own prototype and verification gates.'
const PROTECTED_PROTOTYPE_GUIDANCE = 'This protected workflow requires a small relevant lisp_eval prototype:true and complete saved-result inspection with lisp_inspect before implementation. Use section=result without a pointer and follow nextOffset until the whole result has been read. Prototype success is not task completion. Two failures stop automatic prototype retries. After fixing the cause, the user can select “新しい Lisp を起動” in the Lisp status control or run /kioku-lisp recover to retry with a fresh worker. Ordinary read tools and conversation remain available; Bash still follows host permissions.'
const EFFECT_TOOLS = new Set(['bash','zsh','exec','run_code','write','edit','delete','remove','kioku_write','kioku_edit','kioku_remove','kioku_exec','lisp_eval','lisp_apply','lisp_call','lisp_hot_call'])
type Agent = LispCodingInput['agent']
type ToolArguments = Record<string, unknown>
type ToolOutcome = { ok?: boolean; operationId?: string; replay?: boolean }
export type PreparationObservation = (outcome?: ToolOutcome, inspection?: InspectionReceipt) => void
interface Preparation {
  agent: Agent; sessionId: string; root: string; task: string; key: string
  choice?: 'yes'|'no'; answerRef?: string; scope?: string
  protectedWorkflow: boolean; reason?: string
  phase: 'selected'|'cancelled'|'unavailable'|'choice_pending'|'prototype_required'|'result_pending'|'reviewed'|'declined'|'failed'
  attempts: number; failures: number; review?: PrototypeReview; pending?: Promise<void>
  prototypeInFlight?: boolean; effectDispatches?: number
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
    resultVersion(agent: Agent, operationId: string): Promise<string | undefined>
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
  answered(agent:Agent,task:string,choice:'yes'|'no',answerRef:string,scope:string):void {
    let state=this.current(agent)
    if(!state || state.task!==task || state.answerRef && state.answerRef!==answerRef || state.scope && state.scope!==scope) {
      const identity=this.host.identity(agent),key=createHash('sha256').update(JSON.stringify([identity,task,answerRef,scope])).digest('hex')
      state={agent,...identity,task,key,protectedWorkflow:true,phase:'choice_pending',attempts:0,failures:0}
      this.states.set(agent,state)
    }
    if(state.choice===choice && state.scope===scope)return
    state.key=createHash('sha256').update(JSON.stringify([state.key,task,answerRef,scope,'protected'])).digest('hex')
    state.protectedWorkflow=true
    state.scope=scope
    state.choice=choice;state.answerRef=answerRef;state.phase=choice==='yes'?'prototype_required':'declined';state.attempts=0;state.failures=0;delete state.review
  }
  manual(agent:Agent,enabled:boolean,answerRef?:string):void {
    const state=this.current(agent)
    if(!state || state.phase==='cancelled')return
    state.key=createHash('sha256').update(JSON.stringify([state.key,enabled,answerRef ?? randomUUID()])).digest('hex')
    state.choice=enabled?'yes':'no';state.answerRef=answerRef ?? `human-command:${state.key}:${enabled}`
    state.phase=enabled?(state.protectedWorkflow?'prototype_required':'selected'):'declined';state.attempts=0;state.failures=0;delete state.review
  }
  manualOverride(agent:Agent):{choice:'yes'|'no';answerRef:string}|undefined {
    const state=this.current(agent)
    return state?.choice && state.answerRef?.startsWith('human-command:')
      ? {choice:state.choice,answerRef:state.answerRef}:undefined
  }
  cancelled(agent:Agent,task:string):void {
    let state=this.current(agent)
    if(!state || state.task!==task){
      state={agent,...this.host.identity(agent),task,key:randomUUID(),protectedWorkflow:false,phase:'cancelled',attempts:0,failures:0}
      this.states.set(agent,state)
    } else {state.key=randomUUID();state.phase='cancelled';delete state.choice;delete state.answerRef;delete state.review}
  }
  binding(agent:Agent):string|undefined { return this.current(agent)?.key }
  recovered(agent:Agent, key:string|undefined):void {
    const state = this.current(agent)
    if (state?.key !== key || state?.phase !== 'failed') return
    state.key = randomUUID()
    state.phase = 'prototype_required'
    state.attempts = 0
    state.failures = 0
    delete state.review
  }
  status(agent:Agent):object {
    const state=this.current(agent)
    return state?{phase:state.phase,attempts:state.attempts,failures:state.failures,operationId:state.review?.operationId ?? null,
      ...(state.phase==='result_pending' && state.review ? {inspection:state.review.status()} : {}),
      verified:state.phase==='reviewed',guidance:state.phase==='cancelled'?'Implementation attempt cancelled; work retained. Do not automatically retry or switch tools.':state.phase==='unavailable'?`Question unavailable: ${state.reason}`:state.phase==='selected'?LISP_PROTOTYPE_GUIDANCE:state.phase==='declined'?'Use ordinary tools; do not reopen Lisp for this request.':state.phase==='reviewed'?'The prototype was inspected. Implement and verify separately; this is not task completion.':state.phase==='choice_pending'?'Await the human Lisp choice; reads and conversation remain available.':state.protectedWorkflow?PROTECTED_PROTOTYPE_GUIDANCE:LISP_PROTOTYPE_GUIDANCE}:{phase:'not_applicable',verified:false}
  }
  denial(agent:Agent,name:string,args:ToolArguments,parent?:unknown):string|undefined {
    const state=this.current(agent)
    if(!state || parent!==undefined || state.choice==='no')return
    const effect = EFFECT_TOOLS.has(name)
    const execution = effect || name === 'lisp_recover'
    if(state.phase==='cancelled')return execution?'LISP_REQUEST_CANCELLED: this implementation attempt stopped. Do not retry or switch tools; a new explicit implementation request is required.':undefined
    if(state.phase==='unavailable')return execution?`LISP_CHOICE_UNAVAILABLE: ${state.reason}`:undefined
    if(state.phase==='choice_pending')return execution?'LISP_CHOICE_PENDING: answer the Lisp choice or explicitly use /kioku-lisp enable or disable. Ordinary read tools and conversation remain available; Bash follows host permissions.':undefined
    if(!state.protectedWorkflow || !this.host.enabled(agent))return
    if(effect && state.prototypeInFlight) return 'LISP_PROTOTYPE_BUSY: wait for the active prototype result.'
    if(name==='lisp_eval' && args?.prototype===true) {
      if(state.effectDispatches) return 'LISP_PROTOTYPE_BUSY: wait for the active implementation tool.'
      if(state.phase==='reviewed') return
      return state.failures>=2?'LISP_PROTOTYPE_FAILED: two attempts failed. After fixing the cause, use the Lisp recovery control or /kioku-lisp recover before trying again.':undefined
    }
    if(effect && state.phase!=='reviewed') {
      const inspection = state.phase==='result_pending' && state.review ? ` ${JSON.stringify(state.review.status())}.` : ''
      return `LISP_PROTOTYPE_REQUIRED: ${state.phase}.${inspection} ${PROTECTED_PROTOTYPE_GUIDANCE}`
    }
  }

  /** Revalidate after native approval, and hold the review until dispatch drains. */
  async dispatch<T>(agent: Agent, name: string, args: ToolArguments, parent: unknown, signal: AbortSignal | undefined, next: () => Promise<T>): Promise<T> {
    const denied = this.denial(agent, name, args, parent)
    if (denied) throw new LispError('LISP_PREPARATION_DENIED', denied)
    const state = this.current(agent)
    const review = state?.review
    if (parent !== undefined || !state?.protectedWorkflow || state.phase !== 'reviewed' || !review
      || !EFFECT_TOOLS.has(name) || (name === 'lisp_eval' && args?.prototype === true)
      || !this.host.enabled(agent)) return next()

    const key = state.key
    const version = await this.host.resultVersion(agent, review.operationId)
    signal?.throwIfAborted()
    if (this.current(agent) !== state || state.key !== key || state.review !== review
      || state.phase !== 'reviewed' || state.prototypeInFlight) {
      throw new LispError('LISP_PREPARATION_CHANGED', 'Lisp prototype review changed before dispatch. Check the current Lisp status.')
    }
    if (version !== review.version) {
      review.invalidate()
      state.phase = 'result_pending'
      throw new LispError('LISP_PROTOTYPE_REQUIRED', this.denial(agent, name, args, parent) ?? 'Prototype result version changed.')
    }
    state.effectDispatches = (state.effectDispatches ?? 0) + 1
    try { return await next() }
    finally { state.effectDispatches-- }
  }

  track(agent: Agent, name: string, args: ToolArguments, parent?: unknown): PreparationObservation | undefined {
    const state = this.current(agent)
    if (parent !== undefined || state?.choice !== 'yes') return
    const { key, review } = state
    if (name === 'lisp_eval' && args.prototype === true) {
      const denied = this.denial(agent, name, args)
      if (denied) throw new LispError('LISP_PREPARATION_DENIED', denied)
      const protectedWorkflow = state.protectedWorkflow
      if (protectedWorkflow) state.prototypeInFlight = true
      return (result) => {
        if (protectedWorkflow) delete state.prototypeInFlight
        if (this.current(agent) !== state || state.key !== key || result?.replay === true) return
        if (state.phase === 'reviewed' && (!protectedWorkflow || result?.ok !== true)) return
        state.attempts++
        if (result?.ok === true && typeof result.operationId === 'string') {
          state.review = new PrototypeReview(result.operationId, savedResultVersion(JSON.stringify(result)))
          state.phase = 'result_pending'
        } else {
          delete state.review
          state.failures++
          state.phase = protectedWorkflow ? (state.failures >= 2 ? 'failed' : 'prototype_required') : 'selected'
        }
      }
    }
    if (name !== 'lisp_inspect' || state.phase !== 'result_pending' || !review
      || args.resultOperationId !== review.operationId || (args.section ?? 'result') !== 'result'
      || args.pointer !== undefined || args.ref !== undefined || args.managedOperationId !== undefined) return
    const offset = args.offset ?? 0
    return (_result, inspection) => {
      if (this.current(agent) !== state || state.key !== key || state.review !== review || state.phase !== 'result_pending') return
      if (review.record(inspection, offset)) state.phase = 'reviewed'
    }
  }
}
