import assert from 'node:assert/strict'
import test from 'node:test'
import { projectRuntimeContextMessages } from '../../../src/dsh/harness/runtime-context.js'

const snapshot = (text: string) => Object.freeze({ role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] })
test('legacy accumulated snapshots project only the latest without mutating audit input or other sources', () => {
  const human = { role: 'user', source: { kind: 'user' }, content: 'A' }
  const foreign = { role: 'user', source: { kind: 'plugin:other' }, content: 'A' }
  const evidence = { role: 'tool', content: 'historical result' }
  const states = Array.from({ length: 50 }, (_, i) => snapshot(`fixed instruction\nstate ${i}`))
  const latest = snapshot('fixed instruction\nstate 0')
  const messages = Object.freeze([human, states[0], foreign, ...states.slice(1), evidence, latest])
  assert.deepEqual(projectRuntimeContextMessages(messages), [human, foreign, evidence, latest])
  assert.equal(messages.length, 54)
  assert.equal(projectRuntimeContextMessages(messages).at(-1), latest)
  const cleared = snapshot('Current runtime context: none. Earlier runtime-context snapshots no longer apply.')
  assert.deepEqual(projectRuntimeContextMessages([...messages, cleared]), [human, foreign, evidence, cleared])
  assert.deepEqual(projectRuntimeContextMessages([human, evidence]), [human, evidence])
  assert.deepEqual(projectRuntimeContextMessages([]), [])
})

import { retireLegacyRuntimeContexts, isRuntimeContextMarker } from '../../../src/dsh/harness/runtime-context.js'
import { requestSize } from '../../../src/dsh/efficiency.js'
for (const size of [50, 1000, 5000]) for (const interleaved of [false, true]) {
  test(`retire ${size} ${interleaved ? 'interleaved' : 'adjacent'} snapshots without losing evidence`, () => {
    const events: any[] = [], nodes: number[] = []
    const appendOriginal = (data: any) => { nodes.push(events.length); events.push({seq:events.length,type:'user/message',data}) }
    for(let i=0;i<size;i++) {
      appendOriginal(snapshot(`state ${i}`))
      if(interleaved) appendOriginal({role:'user',source:{kind:'user'},content:[{type:'text',text:`human ${i}`}]})
    }
    const original=structuredClone(events)
    const session: any = {surface:{nodes},eventAt:(seq:number)=>events[seq],append(type:string,data:unknown,options:any){
      const start=nodes.indexOf(options.surfaceOp.startSeq),end=nodes.indexOf(options.surfaceOp.endSeq)
      assert.ok(start>=0 && end>=start)
      assert.deepEqual(nodes.slice(start,end+1),options.sourceEventSeqs)
      const seq=events.length; events.push({seq,type,data,...options});nodes.splice(start,end-start+1,seq)
    }}
    retireLegacyRuntimeContexts(session)
    const messages=nodes.map(seq=>events[seq].data),metrics=requestSize({messages})
    assert.equal(metrics.runtimeContextCopies,1)
    assert.equal(metrics.runtimeContextMarkerCopies,interleaved?size-1:1)
    assert.equal(messages.filter(isRuntimeContextMarker).length,interleaved?size-1:1)
    assert.deepEqual(events.slice(0,original.length),original)
    assert.equal(messages.filter(m=>m.source.kind==='user').length,interleaved?size:0)
    const count=events.length
    for(let i=0;i<3;i++)retireLegacyRuntimeContexts(session)
    assert.equal(events.length,count)
  })
}
