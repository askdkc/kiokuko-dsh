import {createHash,randomUUID} from 'node:crypto'
import {codingIntent, codingContinuation} from '../coding-workflow/intent.js'
import type {LispCodingInput} from './coding-choice.js'

export const LISP_PROTOTYPE_GUIDANCE = 'For this coding request, first run one small relevant Lisp prototype with lisp_eval (prototype:true, operationId, code), covering a concrete uncertainty and counterexample without project changes. Then read its actual saved result with lisp_inspect (resultOperationId from the successful evaluation, section:"result"). Inspect failures; never treat ON, a model passed field, or an unevaluated plan as prototype evidence. Only after successful execution and result inspection proceed with implementation and its separate checks. Two failed prototype attempts stop automatic retries; repair the cause or explicitly use /kioku-lisp disable. Reads, conversation, cancellation and native permissions remain available.'
type Agent = LispCodingInput['agent']
interface Preparation {
  agent: Agent; sessionId: string; root: string; task: string; key: string
  choice?: 'yes'|'no'; answerRef?: string
  phase: 'choice_pending'|'prototype_required'|'result_pending'|'reviewed'|'declined'|'failed'
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
    choose(input:LispCodingInput):Promise<{choice:'yes'|'no';answerRef:string}|undefined>
    activate(agent:Agent):Promise<void>
  }) {}
  private current(agent:Agent):Preparation|undefined {
    const state=this.states.get(agent)
    if (!state) return undefined
    const identity=this.host.identity(agent)
    return state && state.agent===agent && state.sessionId===identity.sessionId && state.root===identity.root ? state : undefined
  }
  async prepare(input:LispCodingInput):Promise<void> {
    const previous=this.current(input.agent)
    if (!codingIntent(input.task)) {
      if (!codingContinuation(input.task)) this.states.delete(input.agent)
      return
    }
    const identity=this.host.identity(input.agent)
    const key=createHash('sha256').update(JSON.stringify([identity,input.turn,input.task])).digest('hex')
    if (previous?.key===key) { await previous.pending; return }
    const state:Preparation={agent:input.agent,...identity,task:input.task,key,phase:'choice_pending',attempts:0,failures:0}
    this.states.set(input.agent,state)
    state.pending=(async()=>{
      const selected=(this.host.selected ? await this.host.selected(input.agent) : this.host.enabled(input.agent))
        ? {choice:'yes' as const,answerRef:`enabled-session:${identity.sessionId}:${key}`}
        : await this.host.choose(input)
      input.signal.throwIfAborted()
      if(this.current(input.agent)!==state)throw new Error('Lisp coding request changed while awaiting its choice')
      if(!selected)return
      state.choice=selected.choice;state.answerRef=selected.answerRef
      state.phase=selected.choice==='yes'?'prototype_required':'declined'
      if(selected.choice==='yes')await this.host.activate(input.agent)
      else await this.host.deactivate?.(input.agent)
    })()
    try{await state.pending}finally{delete state.pending}
  }
  choiceFor(agent:Agent,task:string):{choice:'yes'|'no';answerRef:string}|undefined {
    const state=this.current(agent)
    return state?.task===task && state.choice && state.answerRef ? {choice:state.choice,answerRef:state.answerRef}:undefined
  }
  answered(agent:Agent,task:string,choice:'yes'|'no',answerRef:string):void {
    let state=this.current(agent)
    if(!state || state.task!==task || state.answerRef && state.answerRef!==answerRef) {
      const identity=this.host.identity(agent),key=createHash('sha256').update(JSON.stringify([identity,task,answerRef])).digest('hex')
      state={agent,...identity,task,key,phase:'choice_pending',attempts:0,failures:0}
      this.states.set(agent,state)
    }
    if(state.choice===choice)return
    state.choice=choice;state.answerRef=answerRef;state.phase=choice==='yes'?'prototype_required':'declined';state.attempts=0;state.failures=0;delete state.operationId
  }
  manual(agent:Agent,enabled:boolean,answerRef?:string):void {
    const state=this.current(agent)
    if(!state)return
    state.key=createHash('sha256').update(JSON.stringify([state.key,enabled,answerRef ?? randomUUID()])).digest('hex')
    state.choice=enabled?'yes':'no';state.answerRef=answerRef ?? `human-command:${state.key}:${enabled}`
    state.phase=enabled?'prototype_required':'declined';state.attempts=0;state.failures=0;delete state.operationId
  }
  binding(agent:Agent):string|undefined { return this.current(agent)?.key }
  status(agent:Agent):object {
    const state=this.current(agent)
    return state?{phase:state.phase,attempts:state.attempts,failures:state.failures,operationId:state.operationId,verified:state.phase==='reviewed',guidance:state.phase==='declined'?'Use ordinary tools; do not reopen Lisp for this request.':state.phase==='reviewed'?'The prototype was inspected. Implement and verify separately; this is not task completion.':state.phase==='choice_pending'?'Await the human Lisp choice; reads and conversation remain available.':LISP_PROTOTYPE_GUIDANCE}:{phase:'not_applicable',verified:false}
  }
  denial(agent:Agent,name:string,args:any,parent?:unknown):string|undefined {
    const state=this.current(agent)
    if(!state || parent!==undefined || state.choice==='no' || state.phase==='reviewed')return
    const effect = ['bash','zsh','exec','run_code','write','edit','delete','remove','kioku_write','kioku_edit','kioku_remove','kioku_exec','lisp_eval','lisp_apply','lisp_call','lisp_hot_call'].includes(name)
    if(state.phase==='choice_pending')return effect?'LISP_CHOICE_PENDING: answer the Lisp choice or explicitly use /kioku-lisp enable or disable. Reads and conversation remain available.':undefined
    if(!this.host.enabled(agent))return
    if(name==='lisp_eval' && args?.prototype===true) {
      return state.failures>=2?'LISP_PROTOTYPE_FAILED: two attempts failed; repair the cause or explicitly disable Lisp.':undefined
    }
    if(effect)
      return `LISP_PROTOTYPE_REQUIRED: ${state.phase}. ${LISP_PROTOTYPE_GUIDANCE}`
  }
  observed(agent:Agent,name:string,args:any,result:any,requestKey:string|undefined):void {
    const state=this.current(agent)
    if(!state || state.key!==requestKey || state.choice!=='yes' || result?.replay===true)return
    if(name==='lisp_eval' && args.prototype===true && state.phase!=='reviewed') {
      state.attempts++
      if(result?.ok===true && typeof result.operationId==='string'){
        state.operationId=result.operationId;state.phase='result_pending'
      }else { state.failures++; state.phase=state.failures>=2?'failed':'prototype_required' }
    }
    if(name==='lisp_inspect' && state.phase==='result_pending' && args.resultOperationId===state.operationId && args.section === 'result' && args.pointer === undefined && (args.offset ?? 0) === 0
      && result?.ok===true && result.state === 'SUCCEEDED' && result.nextOffset === null)
      state.phase='reviewed'
  }
}
