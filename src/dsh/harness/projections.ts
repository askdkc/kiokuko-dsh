import { z } from 'zod'
import type { InboxState, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

// The plugin and staged DSH runtime may resolve different compatible Zod patch versions.
// Keep the state type explicit on ProjectionDefinition and erase only that package boundary.
/** DSH client/query projections over the Kiokuko-owned canonical events. */
export const kiokukoTurnBoundaries: ProjectionDefinition<'turnBoundary',TurnBoundaryProjection> = {
  key:'turnBoundary',stateVersion:1,
  stateSchema:z.object({openTurnStartSeq:z.number().int().nullable(),lastStepStartSeq:z.number().int().nullable(),lastStepBoundary:z.object({kind:z.enum(['start','end']),seq:z.number().int()}).nullable(),lastTurn:z.number().int()}) as any,
  init:()=>({openTurnStartSeq:null,lastStepStartSeq:null,lastStepBoundary:null,lastTurn:0}),
  apply:(state,event)=>{
    if(event.type==='turn/start')return {...state,openTurnStartSeq:event.seq,lastTurn:event.data.turn}
    if(event.type==='turn/end')return {...state,openTurnStartSeq:null}
    if(event.type==='step/start')return {...state,lastStepStartSeq:event.seq,lastStepBoundary:{kind:'start',seq:event.seq}}
    if(event.type==='step/end')return {...state,lastStepBoundary:{kind:'end',seq:event.seq}}
    return state
  },
}
const inboxSchema=z.object({'next-turn':z.array(z.unknown()),'next-step':z.array(z.unknown())})
export const kiokukoInboxProjection = {
  key:'inbox',stateVersion:1,stateSchema:inboxSchema as any,
  init:():InboxState=>({'next-turn':[],'next-step':[]}),
  apply:(state:InboxState,event:import('@deepseek-ai/dsh-session').SessionEvent)=>{if(event.type!=='agent/inbox/spliced')return state
    const {target,start,removedCount=0,inserted}=event.data,items=[...state[target]];items.splice(start,removedCount,...inserted)
    return {...state,[target]:items}
  },
  wire:{viewSchema:inboxSchema as any,view:(state:InboxState)=>state as any},
} satisfies ProjectionDefinition<'inbox',InboxState>
