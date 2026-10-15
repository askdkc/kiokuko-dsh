import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
async function projection(){ assert.ok(existsSync(new URL('../../../src/dsh/replay-memory-extract.ts',import.meta.url)),'Replay evidence projection must be installed');return (await import('../../../src/dsh/replay-memory-extract.js')).projectReplayObservations }
const input={runId:'trace',workspace:'project',taskId:'task',sessionId:'session',request:{text:'Inspect request',evidenceRefs:['native:session:1']}}
const row=(seq,type,attrs={},payload={},causes=undefined)=>({event:{seq,type,attrs,...(causes?{causes}:{})},payload,payloadHash:'a'.repeat(64),ref:`agenticreplay:trace:${seq}`})
test('control: exact unique attempt and causal result preserve observed completion',async()=>{
 const projectReplayObservations=await projection()
 const result=projectReplayObservations([row(1,'tool.call',{name:'bash',attemptId:'one'},{command:'printf first'}),row(2,'tool.result',{attemptId:'one',process_result:{exitCode:0}},{content:[]},[1])],input)
 assert.equal(result.attempts[0].outcome,'succeeded');assert.equal(result.attempts[0].execution,'completed')
})
test('unbound denial note cannot deny unrelated identifier-less tool calls',async()=>{
 const projectReplayObservations=await projection()
 const result=projectReplayObservations([row(1,'tool.call',{name:'bash'},{command:'printf first'}),row(2,'tool.call',{name:'bash'},{command:'printf second'}),row(3,'tool.result',{process_result:{exitCode:0}},{content:[]},[1]),row(4,'note',{decision:'deny'})],input)
 assert.equal(result.attempts[0].outcome,'succeeded');assert.equal(result.attempts[0].execution,'completed');assert.equal(result.attempts[1].execution,'unknown')
})
test('reused attempt identity without causal link cannot attribute one result to two calls',async()=>{
 const projectReplayObservations=await projection()
 const result=projectReplayObservations([row(1,'tool.call',{name:'bash',attemptId:'shared'},{command:'printf first'}),row(2,'tool.call',{name:'bash',attemptId:'shared'},{command:'printf second'}),row(3,'tool.result',{attemptId:'shared',process_result:{exitCode:0}},{content:[]})],input)
 assert.equal(result.attempts[0].outcome,'unknown');assert.equal(result.attempts[1].outcome,'unknown');assert.equal(result.attempts[0].resultRef,undefined);assert.equal(result.attempts[1].resultRef,undefined)
})

test('host native call sequence distinguishes a reused model call ID across requests',async()=>{
 const projectReplayObservations=await projection()
 const result=projectReplayObservations([row(1,'tool.call',{name:'bash',callId:'reused',nativeCallSeq:10,attemptId:'old'},{command:'printf old'}),row(2,'tool.result',{attemptId:'old',process_result:{exitCode:0}},{content:[]},[1]),row(3,'tool.call',{name:'bash',callId:'reused',nativeCallSeq:30,attemptId:'new'},{command:'printf current'}),row(4,'tool.result',{attemptId:'new',process_result:{exitCode:0}},{content:[]},[3])],{...input,nativeCalls:[{callId:'reused',sessionSeq:30}]})
 assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].command,'printf current');assert.equal(result.attempts[0].taskId,'task');assert.equal(result.attempts[0].outcome,'succeeded')
})
