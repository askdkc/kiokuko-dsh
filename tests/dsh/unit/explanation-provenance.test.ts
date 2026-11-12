import assert from 'node:assert/strict'
import test from 'node:test'
import { explanationProof, ownedExplanationCalls } from '../../../src/dsh/explanation-provenance.js'

function fixture() {
  const events: any[] = [{seq: 0, type: 'tool/call', data: {callId:'same', name:'memory_explain'}}]
  const session = {header:{id:'session-a',createdAt:1},snapshotEvents:()=>events}
  const proof = explanationProof(session,'same','registration-a')
  events.push({seq:1,type:'tool/result',data:{message:{source:{callId:'same'}},meta:{kiokukoExplanation:proof}}})
  return { session, events }
}
test('owned result is recognized from persisted metadata without a database', () => {
  const {session,events}=fixture()
  const reopened = {header:structuredClone(session.header), snapshotEvents:()=>structuredClone(events)}
  assert.deepEqual([...ownedExplanationCalls(reopened)],['same'])
})
test('foreign tools, legacy results, transplanted receipts and duplicate IDs are retained', () => {
  for (const mutation of ['legacy','session','call','registration','collision']) {
    const {session,events}=fixture()
    if(mutation==='legacy')delete events[1].data.meta
    if(mutation==='session')session.header.id='session-b'
    if(mutation==='call')events[1].data.meta.kiokukoExplanation.callSeq=5
    if(mutation==='registration')events[1].data.meta.kiokukoExplanation.registration=''
    if(mutation==='collision')events.push({seq:2,type:'tool/call',data:{callId:'same',name:'memory_explain'}})
    assert.equal(ownedExplanationCalls(session).size,0,mutation)
  }
})
