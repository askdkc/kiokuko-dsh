import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from '../integration/evolution/fixture.js'
import {approveFixtureMemory} from '../helpers/approved-fixture-memory.js'
import {createApprovedReplayMemoryStore} from '../../../src/memory/replay-store.js'
import {serializeApprovedReplayContext} from '../../../src/context/replay-model-memory.js'

test('approved replay delivers valid whole JSON beyond 12000 UTF-16 units with existing indexed IDs', async () => {
  const {db}=fixture()
  try {
    const entry=await approveFixtureMemory(db,'project:test','😀'.repeat(12000),['replay'])
    const linked=await approveFixtureMemory(db,'project:test','Linked replay evidence',['replay'])
    for(const type of ['supports','contradicts','derived_from','related_to']) db.prepare('INSERT INTO entry_links VALUES(?,?,?,?,?)').run(entry.id,linked.id,type,'2026-10-18T00:00:00.000Z','fixture')
    const replay=createApprovedReplayMemoryStore(db,'project:test').query('replay')
    const text=serializeApprovedReplayContext(db,replay),payload=JSON.parse(text)
    assert.ok(text.length>24000)
    assert.equal(payload.items.length,2)
    assert.ok(payload.items.some((item:any)=>item.entryId===entry.id))
    assert.equal(payload.items[0].workspace,'project:test')
    assert.ok(payload.items.some((item:any)=>item.text.includes('😀'.repeat(12000))))
    assert.equal(payload.relationDelivery.status,'complete')
    assert.equal(payload.relationDelivery.edges.length,4)
  }finally{db.close()}
})
test('oversized replay bodies are omitted whole with a separate explicit status frame', async () => {
  const {db}=fixture()
  try {
    await approveFixtureMemory(db,'project:test','界'.repeat(20000),['replay'])
    const replay=createApprovedReplayMemoryStore(db,'project:test').query('replay')
    const payload=JSON.parse(serializeApprovedReplayContext(db,replay))
    assert.deepEqual(payload.items,[])
    assert.ok(payload.relationDelivery.selectionOmissions.includes('body_budget'))
    const legacy=JSON.parse(serializeApprovedReplayContext(db,[{...replay[0]!,proposalId:'unindexed-old-proposal'}]))
    assert.deepEqual(legacy.items,[])
    assert.equal(legacy.relationDelivery.status,'omitted_legacy')
  }finally{db.close()}
})
