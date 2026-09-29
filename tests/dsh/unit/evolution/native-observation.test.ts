import test from 'node:test'
import assert from 'node:assert/strict'
import { executionObservation, observationMatchesResult, EVOLUTION_OBSERVATION_EVENT } from '../../../../src/dsh/evolution-observation.js'
import { episodeEvidenceForEvent, reduceDshFinalizationLog, type DshLogEvent } from '../../../../src/dsh/session-memory-finalizer.js'
import { digest } from '../../../../src/memory/evolution/contracts.js'

test('native execution values distinguish timeout/cancellation from a passing exit code', () => {
  const identity={runId:'r',workspace:'project:p',sessionId:'s'}
  const result={isError:false,content:[{type:'text',text:'Output'}],value:{exitCode:0}}
  assert.equal(executionObservation(identity,'c',4,result)?.failed,false)
  assert.equal(executionObservation(identity,'c',4,{...result,value:{exitCode:0,timedOut:true}})?.failed,true)
  assert.equal(executionObservation(identity,'c',4,{...result,value:{exitCode:0,aborted:true}})?.failed,true)
  assert.equal(executionObservation(identity,'c',4,{...result,value:{kind:'background',exitCode:0}}),undefined)
  assert.equal(executionObservation(identity,'c',4,{...result,value:'Tests passed'}),undefined)
  assert.equal(executionObservation(identity,'c',4,{...result,value:{exitCode:null,signal:'SIGTERM'}})?.failed,true)
})
test('native proof requires exact run, workspace, call event and final rendered result', async () => {
  const identity={runId:'r',workspace:'project:p',sessionId:'s'}
  const result={isError:false,content:[{type:'text',text:'Output'}],value:{exitCode:0}}
  const proof=executionObservation(identity,'c',4,result)!
  const data={message:{role:'user',source:{kind:'tool',callId:'c'},content:[{type:'tool-result',toolCallId:'c',content:result.content,isError:false}]}}
  assert.equal(observationMatchesResult(proof,data),true)
  assert.equal(observationMatchesResult(proof,{...data,meta:{changed:true}}),false)
  const current={message:{role:'tool',source:{kind:'tool',callId:'c'},toolCallId:'c',content:result.content,isError:false}}
  assert.equal(observationMatchesResult(proof,current),true)
  assert.equal(observationMatchesResult(proof,{...current,message:{...current.message,toolCallId:'other'}}),false)
  for(const changed of [{}, {runId:'other'}, {workspace:'project:other'}, {callSeq:99}, {exitCode:1,failed:false}, {presentationHash:'0'.repeat(64)}]) {
    async function* stream():AsyncIterable<DshLogEvent> {
      yield {seq:1,time:1,type:'turn/start'}
      yield {seq:2,time:2,type:'request/header',data:{header:{config:{provider:'p',model:'m'}}}}
      yield {seq:3,time:3,type:'request/context',data:{contextWindow:100000}}
      yield {seq:4,time:4,type:'tool/call',data:{callId:'c',name:'bash',arguments:'test'}}
      yield {seq:5,time:5,type:EVOLUTION_OBSERVATION_EVENT,data:{...proof,...changed}}
      yield {seq:6,time:6,type:'tool/result',data}
      yield {seq:7,time:7,type:'turn/end'}
    }
    const prepared=await reduceDshFinalizationLog(stream(),1,7,'prefix_reuse',identity)
    assert.equal(prepared.episodeEvidence!.find(e=>e.seq===6)?.outcome,Object.keys(changed).length?'unknown':'passed')
  }
})


test('sidecar proof uses the same result binding and missing proof stays unknown', async () => {
  const identity = { runId: 'r', workspace: 'project:p', sessionId: 's' }
  const result = { isError: false, content: [{ type: 'text', text: 'Output' }], value: { exitCode: 0 } }
  const proof = executionObservation(identity, 'c', 4, result)!
  for (const value of [undefined, proof, { ...proof, sessionId: 'other' }, { ...proof, presentationHash: 'changed' }]) {
    async function* events(): AsyncIterable<DshLogEvent> {
      yield { seq: 1, time: 1, type: 'turn/start' }
      yield { seq: 2, time: 2, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } }
      yield { seq: 3, time: 3, type: 'request/context', data: { contextWindow: 100000 } }
      yield { seq: 4, time: 4, type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: 'test' } }
      yield { seq: 5, time: 5, type: 'tool/result', data: { message: { role: 'user', source: { kind: 'tool', callId: 'c' }, content: [
        { type: 'tool-result', toolCallId: 'c', content: result.content, isError: false },
      ] } } }
      yield { seq: 6, time: 6, type: 'turn/end' }
    }
    const prepared = await reduceDshFinalizationLog(events(), 1, 6, 'prefix_reuse', identity, 2, async seq => {
      assert.equal(seq, 4)
      return value
    })
    assert.equal(prepared.episodeEvidence!.find(e => e.seq === 5)?.outcome, value === proof ? 'passed' : 'unknown')
  }
})

test('occurred proof binds epoch-millisecond native time to session, sequence and event digest', () => {
  const event: DshLogEvent = { seq: 7, time: Date.parse('2026-09-10T12:34:56.789Z'), type: 'user/message',
    data: { source: 'user', content: [{ type: 'text', text: 'Fix the migration lock' }] } }
  const evidence = episodeEvidenceForEvent(event, undefined, undefined, 'session-native')!
  assert.deepEqual(evidence.occurred, { version: 1, timeMs: event.time, sessionId: 'session-native',
    nativeSequence: event.seq, sourceDigest: digest(event) })
  const unbound = episodeEvidenceForEvent(event)
  assert.ok(unbound)
  assert.equal(unbound.occurred, undefined)
  // Legacy streams accept finite fractional timestamps; they stay stored as
  // legacy evidence, but cannot establish a verified epoch-millisecond basis.
  const unverifiedTime = episodeEvidenceForEvent({ ...event, time: event.time + 0.5 }, undefined, undefined, 'session-native')!
  assert.equal(unverifiedTime.occurred, undefined)
})

test('finite legacy timestamps remain accepted but do not establish occurred time', async () => {
  const identity = { runId: 'legacy-time', workspace: 'project:p', sessionId: 'session-legacy-time' }
  async function* events(): AsyncIterable<DshLogEvent> {
    yield { seq: 1, time: 1.5, type: 'turn/start' }
    yield { seq: 2, time: 2.5, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } }
    yield { seq: 3, time: 3.5, type: 'request/context', data: { contextWindow: 100_000 } }
    yield { seq: 4, time: 4.5, type: 'user/message', data: { source: 'user', content: [{ type: 'text', text: 'Keep the legacy record' }] } }
    yield { seq: 5, time: 5.5, type: 'turn/end' }
  }
  const prepared = await reduceDshFinalizationLog(events(), 1, 5, 'prefix_reuse', identity)
  const evidence = prepared.episodeEvidence?.find(item => item.seq === 4)
  assert.ok(evidence)
  assert.equal(evidence.occurred, undefined)
})
