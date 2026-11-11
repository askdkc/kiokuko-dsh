import { projectRuntimeContextMessages, retireLegacyRuntimeContexts } from './runtime-context.js'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent, type AgentFactory, type AgentHandle, type AgentOptions,
  type CreateAgentOptions, type ResumeAgentOptions, type AgentCancelCause, type CancelOptions, type ModelSelection, type SessionStartSource } from '@deepseek-ai/dsh-agent'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { AssistantStreamAccumulator, BlockAssembler, LlmError, markAgentLoopRequest, createAssistantMessage, createSystemMessage, createUserMessage,
  createToolResultMessage, type UserMessage, type ContextFormed, type ContextSnapshotSection, type LlmCallConfig, type LlmFailure, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, interruptedTurnClosers, ToolCallRecovery, type Session, type SessionEvent,
  type TurnEndReason, type SessionSeq } from '@deepseek-ai/dsh-session'
import { renderPrompt, renderContextSections, joinContextSections } from '@deepseek-ai/dsh-system-prompt'
import { KiokukoInbox } from './inbox.js'
import { normalizeModelStreamFailure } from './model-stream-failure.js'
import { KiokukoHarnessLifecycle } from './lifecycle.js'
import { KIOKUKO_DSH_SOURCE_KIND } from '../plugin-source.js'
import { memoryFailureDiagnostic } from '../memory-failure.js'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {withoutInheritedTaskAuthority} from '../task-authority-context.js'
import { projectRequestSourceMessages } from '../request-sources.js'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap { 'plugin:kiokuko-dsh/harness-action': { action:string; phase:string; turn:number; step:number; parentSession?:string; callId?:string; diagnostic?:LlmFailure } }
}
declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'runtime-context': {kind:'runtime-context'} & ContextFormed; 'plugin:kiokuko-dsh': {kind:typeof KIOKUKO_DSH_SOURCE_KIND;form:'instructions'|'snapshot';sections?:readonly {name:string;text:string}[]} } }
export interface HarnessOptions extends AgentOptions {
  /** Optional per-turn limit. Omission lets ordinary work continue until completion or cancellation. */
  maxSteps?: number
}
type ModelStepResult = 'continue' | 'completed' | 'max-tokens'

/** Durable turn-failure facts under the current DSH contract: a caught
 * `LlmError` keeps its provider failure verbatim; anything else is flattened
 * into a bounded, redacted diagnostic instead of a sentinel that erases the
 * cause behind an opaque record. */
function turnFailureDiagnostic(error:unknown):LlmFailure {
  if(error instanceof LlmError)return error.failure
  const diagnostic=memoryFailureDiagnostic(error)
  const code=(error as {code?:unknown}|undefined)?.code
  const named=typeof code==='string'&&code.trim()!==''?code.trim():undefined
  return {message:diagnostic.message,code:(named??'UNKNOWN').slice(0,64)}
}
type PersistenceHandle = { header: any; inheritedEventCount: any; read(from:number,to?:number,options?:unknown):Promise<{events:SessionEvent[];eventState:any}>;
  append(events:readonly SessionEvent[]):Promise<void>;close():Promise<void> }

async function duringSetup<T>(operation:Promise<T>|T,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();let onAbort!:()=>void
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort()})])}
  finally {if(onAbort)signal.removeEventListener('abort',onAbort)}
}

function sameSelection(left:ModelSelection|undefined,right:Readonly<ModelSelection>) {
  return left?.provider===right.provider&&left.model===right.model&&left.reasoningEffort===right.reasoningEffort
}
function detachedSelection(value:{provider?:unknown;model?:unknown;reasoningEffort?:unknown}|undefined):ModelSelection|undefined {
  if(typeof value?.provider!=='string'||!value.provider||typeof value.model!=='string'||!value.model)return undefined
  return {provider:value.provider,model:value.model,...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort as Exclude<ModelSelection['reasoningEffort'],undefined>})}
}
/** Durable model-selection facade for the replacement harness. */
class KiokukoHarnessModel {
  constructor(private readonly session:Session,private readonly options:AgentOptions) {}
  private recorded():ModelSelection|undefined {
    let used:ModelSelection|undefined,pending:ModelSelection|undefined
    for(const event of this.session.snapshotEvents() as readonly {type:string;data:any}[]) {
      if(event.type==='model/selection')pending=detachedSelection(event.data)
      else if(event.type==='request/header') {
        used=detachedSelection({...event.data?.header?.config,...(event.data?.header?.adapterDefaults?.reasoningEffort===true?{reasoningEffort:undefined}:{})})
        if(used&&sameSelection(pending,used))pending=undefined
      }
    }
    return pending??used
  }
  current():Readonly<ModelSelection>|undefined {
    const selection=this.recorded()??detachedSelection(this.options)
    return selection&&{...selection}
  }
  select(selection:Readonly<ModelSelection>) {
    if(sameSelection(this.recorded(),selection))return
    Reflect.apply(this.session.append,this.session,['model/selection',{provider:selection.provider,model:selection.model,...(selection.reasoningEffort===undefined?{}:{reasoningEffort:selection.reasoningEffort})}])
  }
}

/** Kiokuko owns scheduling and request/tool boundaries; DSH supplies the services. */
export class KiokukoHarnessAgent implements Agent {
  readonly id: Agent['id']; readonly ctx: Context; readonly scope: ReturnType<typeof createScope>
  readonly inbox: KiokukoInbox; readonly model: KiokukoHarnessModel; readonly options: HarnessOptions
  private readonly dispatch: ReturnType<typeof agentEvents>
  private driver: Promise<void>|undefined; private maintenance: Promise<unknown>|undefined; private abort: AbortController|undefined
  private ready=false; private disposed=false; private wake=false; private turn=0; private step=0; private streamRevision=0
  private claimedInputs:readonly UserMessage[]=[]
  private headerSeen=false
  private runtimeContextSeen=false
  private systemSeq:SessionSeq|undefined;private systemText:string|undefined
  private attemptedProvider:string|undefined;private retryPolicy:import('@deepseek-ai/dsh-llm').ResolvedRetryPolicy|undefined
  constructor(private readonly ownerCtx:Context, readonly session:Session, options:HarnessOptions,
    private readonly lifecycle:KiokukoHarnessLifecycle, seed:readonly SessionEvent[], callerCtx=ownerCtx) {
    const parent=scopeOf(callerCtx)
    this.id=session.id;this.options={...options};this.model=new KiokukoHarnessModel(session,this.options);this.scope=createScope(ownerCtx,this,parent?{parent}:{});this.ctx=this.scope.ctx
    this.dispatch=agentEvents(this.ctx,this);this.inbox=new KiokukoInbox(session,this.dispatch,seed)
    for(const e of seed){if(e.type==='turn/start')this.turn=e.data.turn;if(e.type==='request/header')this.headerSeen=true}
    this.runtimeContextSeen=seed.some(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context')
    const head=seed.find(e=>e.seq===session.surface.nodes[0]);if(head?.type==='system/message'){this.systemSeq=head.seq;this.systemText=head.data.message.content.map(b=>b.type==='text'?b.text:'').join('')}
  }
  /** Only the retained native surface proves that a snapshot was delivered. */
  private retainedRuntimeContextEvent() {
    const nodes=this.session.surface.nodes
    for(let index=nodes.length-1;index>=0;index--) {
      const event=this.session.eventAt(nodes[index]!)
      if(event?.type==='user/message'&&event.data.source.kind==='runtime-context')return event
    }
  }
  private retainedRuntimeContext():UserMessage|undefined { return this.retainedRuntimeContextEvent()?.data }
  private projectRuntimeContext(sections:readonly ContextSnapshotSection[]):UserMessage|undefined {
    const retained=this.retainedRuntimeContext()
    if(!sections.length&&!retained&&!this.runtimeContextSeen)return
    const text=sections.length?joinContextSections(sections):'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
    if(retained?.content.length===1&&retained.content[0]?.type==='text'&&retained.content[0].text===text)return
    return createUserMessage({content:[{type:'text',text}],source:sections.length
      ?{kind:'runtime-context',form:'snapshot',sections}:{kind:'runtime-context'}})
  }
  get status(): 'idle'|'running' { return this.driver ? 'running':'idle' }
  private audit(action:string,phase:string,callId?:string,diagnostic?:LlmFailure) {
    try {
      appendPluginRecord(this.session,'plugin:kiokuko-dsh/harness-action',{action,phase,turn:this.turn,step:this.step,
        ...(this.session.header.parentSession?{parentSession:this.session.header.parentSession}:{}),...(callId?{callId}:{}),
        ...(diagnostic?{diagnostic}:{})})
    } catch {
      // A native Session brand mismatch (development trees that load two
      // dsh-session copies) must not block agent lifecycle; this record is
      // diagnostic and its absence never changes session state.
    }
  }
  release() { this.ready=true;this.audit('lifecycle','ready');if(this.wake)this.start() }
  send(message:UserMessage,target:'next-turn'|'next-step',wakeup:boolean) {
    if(this.disposed)throw new Error('Kiokuko agent is disposed')
    this.inbox.append(this.abort?.signal.aborted&&wakeup?'next-turn':target,message)
    if(wakeup){this.wake=true;if(this.ready&&!this.maintenance)this.start()}
  }
  followup(message:UserMessage) { this.send(message,'next-turn',true) }
  steer(message:UserMessage) { this.send(message,'next-step',true) }
  inject(message:UserMessage) { this.send(message,'next-step',false) }
  cancel(cause:AgentCancelCause,options:CancelOptions={}) {
    if(!this.abort&&!this.driver&&!this.maintenance)return
    if(options.keepInbox)this.inbox.discardClaimed(this.claimedInputs)
    else this.inbox.clear()
    if(cause.kind==='disposed'){this.disposed=true;this.wake=false}
    this.audit('cancel',cause.kind);this.abort?.abort(cause)
  }
  async whenIdle():Promise<void> { while(this.driver||this.maintenance)await (this.driver??this.maintenance) }
  runMaintenance<T>(task:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    if(this.driver||this.maintenance||this.disposed)throw new Error('Kiokuko agent is not idle')
    const abort=this.abort=new AbortController()
    let result:Promise<T>;try{result=Promise.resolve(task(abort.signal))}catch(error){result=Promise.reject(error)}
    const settled=result.finally(()=>{if(this.abort===abort)this.abort=undefined;this.maintenance=undefined;if(this.wake&&this.ready&&!this.disposed)this.start()})
    this.maintenance=settled;return settled
  }
  private start() {
    if(this.driver||this.disposed||!this.ready||this.maintenance)return
    this.abort=new AbortController()
    // Install status synchronously; execution starts after this reservation.
    this.driver=Promise.resolve().then(()=>withoutInheritedTaskAuthority(()=>this.ownerCtx.agents.withInitiator(this,()=>this.drain())))
      .catch(()=>{ /* The durable turn/end contains failure; notifications below preserve diagnosis. */ })
      .finally(()=>{this.driver=undefined;this.abort=undefined;this.dispatch.emit('agent/status',{status:'idle'});
        this.lifecycle.becameIdle(this);(this.ctx.emit as Function)('agent/idle',{agent:this});
        if(this.wake&&!this.disposed)this.start()})
    this.dispatch.emit('agent/status',{status:'running'})
  }
  private async drain() {
    do {
      this.wake=false;this.abort=new AbortController();this.turn++;this.step=0
      this.session.append('turn/start',{turn:this.turn});this.audit('turn','start')
      let reason:TurnEndReason={kind:'completed'},blocked=false
      const signal=this.abort.signal
      try {
        let first=true, again=true
        while(again&&!this.disposed) {
          signal.throwIfAborted();this.step++
          const ordinary=first?this.inbox.nextTurn.slice(0,1):[]
          const steering=[...this.inbox.nextStep]
          let handled=false
          const payload={agent:this,messages:[...ordinary,...steering],turn:this.turn,step:this.step,signal,inputHandled:()=>{handled=true}}
          // Existing routing observes the claimed input while assembling the
          // step. Keep the durable inbox until admission or explicit handoff.
          for(const message of payload.messages)this.dispatch.emit('agent/inbox/claimed',{message,turn:this.turn})
          let assembly:any,decision:Awaited<ReturnType<KiokukoHarnessLifecycle['preStep']>>,modelSelection:Readonly<ModelSelection>
          let toolSet:any
          try {
          this.claimedInputs=payload.messages
          try {
            const prompt=this.ctx.get('systemPrompt',false) as any
            const selectedModel=this.model.current()
            if(!selectedModel)throw new Error(`agent "${this.id}" has no provider/model`)
            modelSelection=selectedModel
            const tools=this.ctx.get('tools',false) as any
            toolSet=typeof tools?.resolve==='function'?await tools.resolve({agent:this,modelSelection,signal}):undefined
            signal.throwIfAborted()
            const assemblyContext={...assembleContextFor(this,signal),modelSelection,...(toolSet===undefined?{}:{toolSet})}
            assembly=prompt?await prompt.assemble(assemblyContext):undefined
            const sections=assembly?renderContextSections(assembly):[]
            const context=this.projectRuntimeContext(sections)
            // Observers receive only claimed inbox input. The terminal admission
            // adds changed context, matching the native pre-step contract.
            const messages=context?[...payload.messages,context]:payload.messages
            const internal=await this.lifecycle.preStep(payload,async()=>({kind:'enter',messages}))
            decision=internal
            if(internal.kind==='enter') {
              const stepPayload={...payload,messages:internal.messages,modelSelection}
              decision=await this.dispatch.waterfall('agent/pre-step',stepPayload,async()=>internal)
            }
            signal.throwIfAborted()
            if(decision.kind==='reject'&&!handled){reason={kind:'blocked'};blocked=true;break}
            // Intake rejection retains inputs; commit the claim only after admission.
            if(first&&ordinary.length)this.inbox.splice('next-turn',0,ordinary.length,[])
            if(steering.length)this.inbox.splice('next-step',0,steering.length,[])
            // A consumed steer is no longer pending work; later queued input keeps its wake.
            if(!this.inbox.nextTurn.length&&!this.inbox.nextStep.length)this.wake=false
            if(decision.kind==='reject'){reason={kind:'blocked'};blocked=true;this.audit('intake','handoff');break}
            if(first&&!decision.messages.length)break
          } finally {this.claimedInputs=[]}
          first=false;this.session.append('step/start',{turn:this.turn,step:this.step})
          try {
            const result=await this.modelStep(decision.messages,signal,assembly,modelSelection,toolSet)
            if(result==='max-tokens')reason={kind:'max-tokens'}
            again=result==='continue'
          }
          finally { this.session.append('step/end',{turn:this.turn,step:this.step}) }
          if(!again&&!this.inbox.nextStep.length){await this.lifecycle.turnStopping({agent:this,turn:this.turn,signal});
            await this.dispatch.serial('agent/turn-stopping',{turn:this.turn,signal});signal.throwIfAborted()}
          again=again||this.inbox.nextStep.length>0
          if(again&&this.options.maxSteps!==undefined&&this.step>=this.options.maxSteps){
            throw new LlmError(`Kiokuko configured step budget reached (maxSteps=${this.options.maxSteps}); inspect the recorded work before continuing. Remove or raise the harness maxSteps setting for longer turns.`, 'KIOKUKO_STEP_BUDGET_REACHED')
          }
          } finally {toolSet?.dispose()}
        }
      } catch(error) {
        blocked=true // Retained input must not turn a preparation failure into a retry loop.
        const failure=turnFailureDiagnostic(error)
        reason=signal.aborted?{kind:'aborted',reason:signal.reason as AgentCancelCause}:{kind:'error',error:failure}
        this.audit('turn',signal.aborted?'cancel':'error',undefined,signal.aborted?undefined:failure)
        if(!signal.aborted){
          const message=memoryFailureDiagnostic(error).message
          this.dispatch.emit('agent/error',{turn:this.turn,step:this.step,error:new LlmError(message,failure.code,failure)})
        }
      } finally { this.session.append('turn/end',{turn:this.turn,reason});this.audit('turn','result') }
      if(blocked||signal.aborted&&!this.wake)break
    } while(!this.disposed&&(this.wake||this.inbox.nextTurn.length>0))
  }
  private commitInput(message:UserMessage):void {
    if(message.source.kind==='runtime-context') {
      const previous=this.retainedRuntimeContextEvent(),retained=previous?.data,block=message.content[0]
      if(message.content.length===1&&block?.type==='text'&&retained?.content.length===1
        &&retained.content[0]?.type==='text'&&retained.content[0].text===block.text)return
      // Replace only the prior state node, never the tools/messages between
      // updates. The append-only event log keeps every original for audit;
      // compaction and token estimation see the same current state as requests.
      this.session.append('user/message',message,previous
        ?{surfaceOp:{op:'replace',startSeq:previous.seq,endSeq:previous.seq},sourceEventSeqs:[previous.seq]}
        :{surfaceOp:'append'})
      this.runtimeContextSeen=true
      return
    }
    this.session.append('user/message',message,{surfaceOp:'append'})
  }
  private async modelStep(messages:UserMessage[],signal:AbortSignal,assembly:any,modelSelection:Readonly<ModelSelection>,toolSet?:unknown):Promise<ModelStepResult> {
    if(this.systemSeq===undefined){const event=this.session.append('system/message',{turn:this.turn,step:this.step,message:createSystemMessage('')},{surfaceOp:'append'});this.systemSeq=event.seq;this.systemText=''}
    // Prefer the host-admitted snapshot over the earlier assembly, including on retry.
    const snapshot=[...messages].reverse().find(message=>message.source.kind==='runtime-context')
      ??this.projectRuntimeContext(assembly?renderContextSections(assembly):[])??this.retainedRuntimeContext()
    // Accepted input must survive even provider/prompt preparation failure.
    for(const message of messages)this.commitInput(message)
    for(;;){try{return await this.requestAttempt(signal,assembly,modelSelection,toolSet,snapshot)}catch(error){
      if(signal.aborted||!(error instanceof LlmError))throw error
      const recovery=await this.dispatch.waterfall('agent/request-error',{turn:this.turn,step:this.step,provider:this.attemptedProvider??'',failure:error.failure,retryPolicy:this.retryPolicy,signal},async()=>undefined)
      if(recovery?.kind!=='retry')throw error
      this.audit('model','retry')
    }}
  }
  private async requestAttempt(signal:AbortSignal,assembly:any,modelSelection:Readonly<ModelSelection>,toolSet?:unknown,snapshot?:UserMessage):Promise<ModelStepResult> {
    const proposed:LlmCallConfig={...modelSelection,...(this.options.maxTokens?{maxTokens:this.options.maxTokens}:{})}
    const config=await this.dispatch.waterfall('agent/request',{turn:this.turn,step:this.step,signal},async()=>proposed)
    this.attemptedProvider=config.provider;this.retryPolicy=undefined
    const prepared=await this.ctx.llm.prepareCall(config,signal)
    this.retryPolicy=prepared.retryPolicy
    const tools=assembly?.tools??[]
    // Preserve which native definitions this request actually admitted. The
    // host's live view removes revoked/replaced registrations during streaming.
    const admittedTools = new Set<string>((toolSet as { view?(scope: object): ReadonlyMap<string, unknown> } | undefined)?.view?.(this).keys() ?? [])
    this.session.append('request/header',{header:{config:prepared.config,...(tools.length?{tools}:{}),...(Object.keys(prepared.adapterDefaults??{}).length?{adapterDefaults:prepared.adapterDefaults}:{})},reason:this.headerSeen?'change':'initial'})
    this.headerSeen=true
    const text=assembly?renderPrompt(assembly):''
    if(this.systemText!==text){const event=this.session.append('system/message',{turn:this.turn,step:this.step,message:createSystemMessage(text)},
      this.systemSeq!==undefined?{surfaceOp:{op:'replace',startSeq:this.systemSeq,endSeq:this.systemSeq},sourceEventSeqs:[this.systemSeq]}:{surfaceOp:'append'})
      this.systemSeq=event.seq;this.systemText=text}
    // Reconcile after preparation/compaction without replaying accepted human input.
    if(snapshot)this.commitInput(snapshot)
    await this.ctx.sessions.flush(this.session)
    const assembler=new BlockAssembler(),accumulator=new AssistantStreamAccumulator(),revision=++this.streamRevision
    const attemptId=`kiokuko:${this.id}:${this.turn}:${this.step}:${revision}` as any
    let count=0,settled=false
    this.audit('model','start');this.dispatch.emit('agent/assistant-stream',{frame:{type:'start',attemptId,revision,turn:this.turn,step:this.step}})
    try {
      const history=projectRequestSourceMessages(this,projectRuntimeContextMessages(this.session.deriveMessages()));history.forEach(message=>deepFreeze(message));Object.freeze(history)
      const request=markAgentLoopRequest(Object.freeze({...prepared.config,messages:history,
        ...(tools.length?{tools:deepFreeze(structuredClone(tools))}:{}),toolHistory:this.session.toolHistory(),sessionId:this.session.id,signal}))
      for await(const chunk of prepared.stream(request)) {
        signal.throwIfAborted();const timed=accumulator.push({time:Date.now(),chunk});assembler.push(timed.chunk)
        this.dispatch.emit('agent/assistant-stream',{frame:{type:'chunk',attemptId,revision,index:count++,time:timed.time,chunk:timed.chunk}})
      }
      signal.throwIfAborted()
      const content=assembler.blocks(), stream=[...accumulator.snapshot()]
      const finish=assembler.finish
      if(finish.kind==='error'||finish.kind==='aborted') {
        // Classify only failed model output, before any tool effect is admitted.
        const failure=finish.kind==='error'?normalizeModelStreamFailure(finish.failure):finish.failure
        throw new LlmError(memoryFailureDiagnostic(failure).message,failure.code,failure)
      }
      const calls=content.filter((block):block is ToolCallBlock=>block.type==='tool-call')
      // Some providers put unfinished reasoning in text blocks even with a
      // normal stop. Keep that stream in the attempt log, outside prompt history.
      if(calls.length===0) {
        const text=content.flatMap(block=>block.type==='text'?[block.text]:[]).join('').trimStart()
        if(text.startsWith('<thinking>')&&!text.includes('</thinking>')) {
          const message=finish.kind==='max-tokens'
            ? 'The model reached its output limit before answering.'
            : 'The model stopped before finishing its reasoning or returning an answer.'
          throw new LlmError(message,'INCOMPLETE_ASSISTANT_RESPONSE')
        }
      }
      const event=content.length?this.session.append('assistant/message',{turn:this.turn,step:this.step,message:assembler.message({provider:prepared.config.provider,model:prepared.config.model,...(assembler.replayState?{replayState:assembler.replayState}:{})}),stream,...(assembler.usage?{usage:assembler.usage}:{})},{surfaceOp:'append'}):this.session.append('assistant/attempt',{turn:this.turn,step:this.step,stream})
      settled=true;this.dispatch.emit('agent/assistant-stream',{frame:{type:'end',attemptId,revision,index:count,outcome:{kind:'committed',eventType:event.type as 'assistant/message'|'assistant/attempt',seq:event.seq}}})
      this.audit('model','result')
      if(finish.kind==='max-tokens')return 'max-tokens'
      let concludesTurn=false
      for(const call of calls)concludesTurn=await this.executeTool(call,signal,toolSet,admittedTools)||concludesTurn
      return calls.length>0&&!concludesTurn?'continue':'completed'
    } catch(error) {
      if(!settled){const content=assembler.interruptedBlocks(),stream=[...accumulator.snapshot()]
        const event=signal.aborted&&content.length?this.session.append('assistant/message',{turn:this.turn,step:this.step,message:createAssistantMessage({content,source:{provider:prepared.config.provider,model:prepared.config.model,...(assembler.replayState?{replayState:assembler.replayState}:{})}}),stream,interrupted:true},{surfaceOp:'append'}):this.session.append('assistant/attempt',{turn:this.turn,step:this.step,stream})
        this.dispatch.emit('agent/assistant-stream',{frame:{type:'end',attemptId,revision,index:count,outcome:{kind:'committed',eventType:event.type as 'assistant/message'|'assistant/attempt',seq:event.seq}}})}
      this.audit('model',signal.aborted?'cancel':'error');throw error
    }
  }
  private async executeTool(call:ToolCallBlock,signal:AbortSignal,toolSet?:unknown,admittedTools?:ReadonlySet<string>) {
    const recovery=new ToolCallRecovery();const off=this.ctx.on('session/event',(session:Session,event:SessionEvent)=>{if(session===this.session)recovery.observe(event)})
    let callSeq!:SessionSeq
    const record=(result:any)=>this.session.append('tool/result',{turn:this.turn,step:this.step,
      message:createToolResultMessage({callId:call.id,content:result.content??[],isError:result.isError===true}),
      ...(result.error?.info?{error:result.error.info}:{}),...(result.meta===undefined?{}:{meta:result.meta})
    },{surfaceOp:'append',sourceEventSeqs:[callSeq]})
    try {
      callSeq=this.session.append('tool/call',{turn:this.turn,step:this.step,callId:call.id,name:call.name,arguments:call.arguments}).seq
      this.audit('tool','start',call.id);await this.ctx.sessions.flush(this.session)
      const tools=this.ctx.get('tools',false) as any
      if(!tools)throw new Error('Tool runtime unavailable')
      let result:any,nativeConcluded:boolean|undefined
      // Executor selection is the batch API capability, not a version fence.
      // Never resend a failed dispatch through the other API.
      const currentTools = (toolSet as { view?(scope: object): ReadonlyMap<string, unknown> } | undefined)?.view?.(this)
      if (!signal.aborted && admittedTools?.has(call.name) && currentTools && !currentTools.has(call.name)) {
        // A human mode change or re-registration invalidates the old step.
        // Never re-resolve here: that would authorize a replacement under a
        // model request that only saw the previous implementation.
        result = { isError: true, content: [{ type: 'text', text: JSON.stringify({
          code: 'TOOL_SURFACE_CHANGED', tool: call.name, executed: false,
          message: 'The tool registration changed while this model request was in progress. This call was not executed.',
          recovery: 'Use the next step’s current tool list. If the tool remains available, issue a new call; do not replay earlier operations or override a disabled mode. For Lisp recovery, inspect lisp_status and saved result receipts before further execution.',
        }) }] }
      } else if(typeof tools.setExecutor==='function') {
        const batch=await tools.execute({calls:[call],agent:this,signal,...(toolSet===undefined?{}:{toolSet})})
        if(!Array.isArray(batch?.results)||batch.results.length!==1||batch.results[0].callId!==call.id)
          throw new Error('Tool executor did not settle the exact requested call')
        nativeConcluded=batch.concluded===true
        result={...batch.results[0].result,additionalContexts:batch.additionalContexts??batch.results[0].result.additionalContexts}
      } else {
        let args:unknown;try{args=JSON.parse(call.arguments)}catch{args=call.arguments}
        result=await tools.execute({callId:call.id,name:call.name,arguments:args,agent:this,signal})
      }
      record(result)
      this.audit('tool',signal.aborted?'cancel':result.isError?'error':'result',call.id)
      for(const context of result.additionalContexts??[])this.inject(context)
      await this.ctx.sessions.flush(this.session)
      return nativeConcluded??(result.isError!==true&&result.concludesTurn===true)
    } catch(error) {
      // Preserve any host-confirmed partial settlement before closing unknown
      // calls conservatively. A scheduler failure is not a successful turn.
      const partial=(error as {partial?:{results?:{callId:string;result:unknown}[]}})?.partial
      const confirmed=partial?.results?.find(result=>result.callId===call.id)
      if(confirmed)record(confirmed.result)
      for(const event of recovery.results())this.session.append('tool/result',event.data,{surfaceOp:'append',...(event.sourceEventSeqs?{sourceEventSeqs:event.sourceEventSeqs}:{})})
      this.audit('tool',signal.aborted?'cancel':'error',call.id)
      throw error
    } finally { off() }
  }
  async stopForDisposal() { this.disposed=true;this.abort?.abort({kind:'disposed'});this.inbox.clear();await this.whenIdle() }
  reportDisposalFailure(error:Error) { agentEvents(this.ownerCtx,this).emit('agent/error',{turn:this.turn,step:this.step,error}) }
  async dispose() { await this.stopForDisposal();await this.scope.dispose() }
}

/** Factory provider: no dependency on or delegation to the stock AgentLoop. */
export class KiokukoAgentFactory implements AgentFactory {
  readonly lifecycle=new KiokukoHarnessLifecycle()
  private readonly handles=new Set<AgentHandle>();private closed=false
  constructor(private readonly ctx:Context,private readonly defaults:HarnessOptions={}) {}
  async createAgent(ownerCtx:Context,options:CreateAgentOptions):Promise<AgentHandle> {
    const session=this.ctx.sessions.prepare(options.sessionId,{...(options.meta?{meta:options.meta}:{}),...(options.seed?{seed:options.seed}:{}),...(options.inheritedEventCount!==undefined?{inheritedEventCount:options.inheritedEventCount}:{})})
    const persistence=this.ctx.get('sessionPersistence',false) as any
    const stored:PersistenceHandle|undefined=await persistence?.create(session.header,{inheritedEventCount:session.inheritedEventCount,...(options.signal?{signal:options.signal}:{})})
    return this.publish(ownerCtx,session,options,'startup',options.seed??[],stored)
  }
  async resume(ownerCtx:Context,options:ResumeAgentOptions):Promise<AgentHandle> {
    const persistence=this.ctx.get('sessionPersistence',false) as any
    if(!persistence)throw new Error('Kiokuko resume requires the DSH session persistence service')
    const stored:PersistenceHandle=await persistence.open(options.resumeSessionId,'write',options.signal?{signal:options.signal}:{})
    try { const read=await stored.read(0,undefined,options.signal?{signal:options.signal}:{})
      const closers=interruptedTurnClosers(read.events);if(closers.length)await stored.append(closers)
      const seed=[...read.events,...closers]
      const session=this.ctx.sessions.prepare(options.resumeSessionId,{seed,meta:structuredClone(stored.header),inheritedEventCount:stored.inheritedEventCount,eventState:read.eventState})
      return await this.publish(ownerCtx,session,options,'resume',seed,stored,seed.length)
    } catch(error) { await stored.close();throw error }
  }
  private async publish(ownerCtx:Context,session:Session,options:CreateAgentOptions|ResumeAgentOptions,source:SessionStartSource,seed:readonly SessionEvent[],stored?:PersistenceHandle,storedCount=0):Promise<AgentHandle> {
    if(this.closed){await stored?.close();throw new Error('Kiokuko factory is stopped')}
    const abort=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal
    const previous=source==='resume'?session.requestHeader():undefined
    const restored:AgentOptions=previous?{provider:previous.config.provider,model:previous.config.model,
      ...(previous.adapterDefaults?.reasoningEffort!==true&&previous.config.reasoningEffort?{reasoningEffort:previous.config.reasoningEffort}:{})}:{}
    const agent=new KiokukoHarnessAgent(this.ctx,session,{...this.defaults,...restored,...options.agentOptions},this.lifecycle,seed,ownerCtx)
    let detachAgent:(()=>void)|undefined,detachSession:(()=>void)|undefined,disposing:Promise<void>|undefined
    const dispose=()=>disposing??=(async()=>{
      abort.abort(new Error('Kiokuko agent owner disposed'))
      const failures:unknown[]=[]
      try{await agent.stopForDisposal()}catch(error){failures.push(error)}
      try{if(detachSession)await this.ctx.sessions.flush(session)}catch(cause){
        const error=Object.assign(new Error('Session persistence failed during Kiokuko agent disposal',{cause}),{code:'SESSION_PERSISTENCE_FAILED'})
        failures.push(error)
        try{agent.reportDisposalFailure(error)}catch(notification){failures.push(notification)}
      }
      for(const cleanup of [()=>stored?.close(),()=>agent.scope.dispose(),()=>detachAgent?.(),()=>detachSession?.()]){
        try{await cleanup()}catch(error){failures.push(error)}
      }
      this.handles.delete(handle)
      if(failures.length===1)throw failures[0]
      if(failures.length)throw new AggregateError(failures,'Kiokuko agent disposal failed')
    })()
    const handle:AgentHandle={agent,dispose};this.handles.add(handle)
    const unfollow=ownerCtx.effect(function*(){yield agent.scope.rawDispose;yield()=>dispose()},'Kiokuko agent lifecycle')
    const ownedDispose=()=>Promise.all([dispose(),unfollow()]).then(()=>undefined);handle.dispose=ownedDispose
    try {
      signal.throwIfAborted()
      if(stored&&session.seq>storedCount)await stored.append(session.snapshotEvents(storedCount as any))
      // Native subagent setup appends its descriptor and working directory.
      // The Session must be store-owned and announced before those records;
      // the Agent itself remains unpublished and cannot run until setup commits.
      signal.throwIfAborted();detachSession=agent.ctx.sessions.enter(session);agent.ctx.sessions.announce(session)
      retireLegacyRuntimeContexts(session)
      const commit=await duringSetup(options.setup?.(agent.ctx,agent),signal);signal.throwIfAborted();ownerCtx.fiber.assertActive();commit?.commit()
      // Older DSH accepts an explicit parent; current DSH owns the handle through ownerCtx.
      const registration = 'parentAgent' in options ? [agent, options.parentAgent] : [agent]
      detachAgent=Reflect.apply(this.ctx.agents.enter,this.ctx.agents,registration)
      await this.ctx.agents.announce(agent,source,signal);signal.throwIfAborted()
      agent.release();return handle
    } catch(error) { await handle.dispose();throw error }
  }
  async dispose() { this.closed=true;await Promise.all([...this.handles].map(h=>h.dispose())) }
}
