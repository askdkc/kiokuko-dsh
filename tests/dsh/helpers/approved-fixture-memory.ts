/** Explicit trusted test-human preference. Execution evidence uses real replay fixtures elsewhere. */
import assert from 'node:assert/strict'
import type {SqliteDatabase} from '../../../src/db/adapter.js'
import {recordEntryInTransaction} from '../../../src/memory/entries.js'
import {reviewCompletedReplay,type ReplayMemoryProposal} from '../../../src/memory/replay-review.js'
import {createApprovedReplayMemoryStore} from '../../../src/memory/replay-store.js'
export async function approveFixtureMemory(db:SqliteDatabase,workspace:string,body:string,keywords:string[]) {
 let entry!:ReturnType<typeof recordEntryInTransaction>,preview='';const phases:string[]=[]
 const proposal:ReplayMemoryProposal={schemaVersion:1,proposalId:'fixture',revision:1,source:{workspace,taskId:'previous-test-preference',sessionId:'previous-test-session',traces:[]},
  request:{text:keywords.join(' '),evidenceRefs:['fixture:human-preference']},languages:[],attempts:[],findings:[{kind:'key_point',text:body,basis:'user_corrected',evidenceRefs:['fixture:human-preference']}],tags:keywords,keywords}
 const result=await reviewCompletedReplay({completed:true,taskId:proposal.source.taskId,sessionId:proposal.source.sessionId,workspace,extract:async()=>proposal,
  ask:async question=>{phases.push(question.phase);if(question.phase==='review')preview=question.text;return{questionId:question.id,choice:question.phase==='organize'?'organize':'approve'}},
  save:async(shown,key)=>{assert.ok(preview.includes(JSON.stringify(shown,null,2)));createApprovedReplayMemoryStore(db,workspace,value=>entry=recordEntryInTransaction(db,{workspace,kind:'reference',title:keywords.join(' '),body:JSON.stringify(value),scope:{visibility:'project'},provenance:{type:'user_approved_replay',reference:key},trustLevel:'untrusted'})).save(shown,key)}})
 assert.equal(result.status,'saved');assert.deepEqual(phases,['organize','review']);return entry
}
