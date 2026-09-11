import test from 'node:test'
import assert from 'node:assert/strict'
import { executionObservation, observationMatchesResult, EVOLUTION_OBSERVATION_EVENT } from '../../../../src/dsh/evolution-observation.js'
import { reduceDshFinalizationLog, type DshLogEvent } from '../../../../src/dsh/session-memory-finalizer.js'

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
