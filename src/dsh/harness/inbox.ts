import type { Inbox, InboxTarget, AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import type { UserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** A command facade over the canonical session splices, never a second task ledger. */
export class KiokukoInbox implements Inbox {
  private readonly pending: Record<InboxTarget,UserMessage[]> = {'next-turn':[],'next-step':[]}
  constructor(private readonly session: Session, private readonly events: AgentEventDispatch, seed: readonly SessionEvent[]) {
    for(const event of seed)if(event.type==='agent/inbox/spliced')this.apply(event.data)
  }
  get nextTurn() { return Object.freeze([...this.pending['next-turn']]) }
  get nextStep() { return Object.freeze([...this.pending['next-step']]) }
  private apply(data: {target:InboxTarget;start:number;removedCount?:number;inserted:UserMessage[]}) {
    return this.pending[data.target].splice(data.start,data.removedCount??0,...data.inserted)
  }
  private mutate(target:InboxTarget,start:number,count:number,inserted:UserMessage[],cancelled=false):UserMessage[] {
    const items=this.pending[target], position=start<0?Math.max(items.length+start,0):Math.min(start,items.length)
    const removedCount=Math.max(0,Math.min(count,items.length-position))
    if(!removedCount&&!inserted.length)return []
    const event=this.session.append('agent/inbox/spliced',{target,start:position,removedCount,inserted,...(cancelled?{outcome:'canceled' as const}:{})})
    const removed=this.apply(event.data)
    for(const message of inserted)this.events.emit('agent/inbox/inserted',{message})
    if(cancelled)for(const message of removed)this.events.emit('agent/inbox/discarded',{message})
    return removed
  }
  clear() { this.mutate('next-step',0,Infinity,[],true); this.mutate('next-turn',0,Infinity,[],true) }
  append(target:InboxTarget,message:UserMessage) { this.splice(target,Infinity,0,[message]) }
  prepend(target:InboxTarget,message:UserMessage) { this.splice(target,0,0,[message]) }
  splice(target:InboxTarget,start:number,deleteCount:number,inserted:UserMessage[]) { return this.mutate(target,start,deleteCount,inserted) }
  replace(id:MessageId,message:UserMessage) { for(const target of ['next-turn','next-step'] as const){const i=this.pending[target].findIndex(m=>m.id===id);if(i>=0){this.splice(target,i,1,[message]);return true}}return false }
  remove(id:MessageId) { for(const target of ['next-turn','next-step'] as const){const i=this.pending[target].findIndex(m=>m.id===id);if(i>=0){this.mutate(target,i,1,[],true);return true}}return false }
}
