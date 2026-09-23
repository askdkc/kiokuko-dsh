import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshDshSkillSnapshots } from '../../../src/dsh/skill-snapshot.js'
import { projectDshContext, retainedEvents } from '../../../src/dsh/context-projection.js'
import type { DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import type { DshModelMessage } from '../../../src/dsh/context-injection.js'

const fragment=(content:string):DshModelMessage=>({role:'user',source:'route-skill',name:'fixture',content})
test('Skill upgrades replace owned surface snapshots, preserve audit history and restore after compaction',()=>{
  const events:DshLogEvent[]=[]
  const session={snapshotEvents:()=>events,append(type:string,data:unknown,options:any){events.push({type,seq:events.length,time:0,data,...options})}}
  for(const message of projectDshContext([fragment('old')],session))session.append('user/message',message,{surfaceOp:'append'})
  const original=structuredClone(events[0])
  const unrelated={...(events[0]!.data as any),source:{kind:'user'}}
  session.append('user/message',unrelated,{surfaceOp:'append'})
  refreshDshSkillSnapshots([fragment('current')],session)
  assert.deepEqual(events[0],original)
  assert.equal((retainedEvents(session)[0]!.data as any).content[0].text,'current')
  assert.deepEqual(projectDshContext([fragment('current')],session),[])
  assert.equal(retainedEvents(session)[1]!.data,unrelated)
  const seq=retainedEvents(session)[0]!.seq
  session.append('user/message',{role:'user',content:[{type:'text',text:'summary'}],source:{kind:'plugin:compaction'}},{surfaceOp:{op:'replace',start:seq,end:seq}})
  assert.equal(projectDshContext([fragment('current')],session).length,1)
})
test('only currently confirmed system guidance retires a duplicate Skill snapshot',()=>{
  const events:DshLogEvent[]=projectDshContext([fragment('body')],{}).map((data,seq)=>({seq,time:0,type:'user/message',data,surfaceOp:'append'}))
  const session={snapshotEvents:()=>events,append(type:string,data:unknown,options:any){events.push({seq:events.length,time:0,type,data,...options})}}
  refreshDshSkillSnapshots([],session);assert.equal(events.length,1)
  refreshDshSkillSnapshots([],session,new Set(['fixture']));assert.equal(events.length,2)
  assert.deepEqual((retainedEvents(session)[0]!.data as any).content,[])
})
