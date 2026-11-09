import assert from 'node:assert/strict'
import test from 'node:test'
import { lispFallbackCompactionOutcome } from '../../../../src/dsh/lisp/surface.js'

const event = (type:string, data:any={}) => ({type,data})
const agent = (events:any[]) => ({id:'agent',session:{id:'session',header:{cwd:'/workspace'},surface:{nodes:events.map((_,index)=>index+1)},
  eventAt(seq:number){return events[seq-1]},snapshotEvents(){return events.map((item,index)=>({...item,seq:index+1}))}},ctx:{get(){}}}) as any

test('fallback compaction preserves history when unavailable, inapplicable or malformed', async () => {
  const signal=new AbortController().signal
  assert.deepEqual(await lispFallbackCompactionOutcome(agent([]),signal),{outcome:'unavailable'})
  assert.deepEqual(await lispFallbackCompactionOutcome(agent([event('system/message'),event('assistant/message')]),signal,{compactRegion:async()=>({compactionId:'must-not-run'})}),
    {outcome:'skipped',reason:'history_too_short_or_unbalanced'})
  const balanced=agent([event('system/message'),event('assistant/message'),event('user/message',{source:{kind:'user'}}),
    event('assistant/message'),event('user/message',{source:{kind:'user'}}),event('assistant/message'),event('user/message',{source:{kind:'user'}})])
  assert.deepEqual(await lispFallbackCompactionOutcome(balanced,signal,{compactRegion:async()=>({})}),
    {outcome:'failed',reason:'missing_compaction_identity'})
  const failed=await lispFallbackCompactionOutcome(balanced,signal,{compactRegion:async()=>{throw new Error('summary unavailable')}})
  assert.equal(failed.outcome,'failed');assert.match(JSON.stringify(failed),/summary unavailable/)
  assert.deepEqual(await lispFallbackCompactionOutcome(balanced,signal,{compactRegion:async()=>({compactionId:'compact-1'})}),
    {outcome:'summarized',compactionId:'compact-1'})
})
