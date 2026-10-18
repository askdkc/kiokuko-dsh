import test from 'node:test'
import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import { fixture } from '../integration/evolution/fixture.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { retrieveFederatedMemory } from '../../../src/memory/federated-retrieval.js'
import { RELATION_TYPES, readRelationDelivery, packRelationDelivery, filterRelationDelivery, legacyRelationDelivery, validateRelationDelivery, relationDeliveryCharacterCount } from '../../../src/memory/relation-delivery.js'

const row = (relation = 'contradicts') => ({ kind: 'edge', from_id: '😀a', from_workspace: 'project:test', to_id: 'b', to_workspace: 'global', relation })
test('stored typed links retain direction and cover only the exact provided identities', () => {
  const { db } = fixture()
  try {
    const entries = ['a', 'b', 'outside'].map(title => recordEntry(db, { workspace: 'project:test', kind: 'reference', title, body: title, createdBy: 'test' }))
    for (const [index, relation] of RELATION_TYPES.entries()) db.prepare('INSERT INTO entry_links VALUES(?,?,?,?,?)').run(entries[index % 2]!.id, entries[1 - index % 2]!.id, relation, '2026-10-18T00:00:00.000Z', 'test')
    db.prepare('INSERT INTO entry_links VALUES(?,?,?,?,?)').run(entries[0]!.id, entries[2]!.id, 'contradicts', '2026-10-18T00:00:00.000Z', 'test')
    const result = readRelationDelivery(db, entries.slice(0, 2).map(entry => ({ entryId: entry.id, workspace: entry.workspace, revision: entry.revision })))
    assert.equal(result.status, 'complete'); assert.equal(result.edges.length, 4)
    assert.deepEqual(new Set(result.edges.map(edge => edge.type)), new Set(RELATION_TYPES))
    assert.equal(result.edges.find(edge => edge.type === 'contradicts')?.from.entryId, entries[1]!.id)
    assert.ok(result.edges.every(edge => edge.from.workspace === 'project:test' && edge.to.entryId !== entries[2]!.id))
    assert.throws(() => readRelationDelivery(db, [{ entryId: entries[0]!.id, workspace: 'project:foreign' }]))
  } finally { db.close() }
})
test('relation JSON uses a separate Unicode budget with exact threshold and all-or-none omissions', () => {
  const complete = packRelationDelivery([row()])
  const count = Array.from(JSON.stringify({relationDelivery:complete})).length
  assert.ok(count < JSON.stringify({relationDelivery:complete}).length)
  assert.equal(packRelationDelivery([row()], { relationCharacterBudget: count }).status, 'complete')
  const omitted = packRelationDelivery([row()], { relationCharacterBudget: count - 1 })
  assert.equal(omitted.status, 'omitted_budget'); assert.deepEqual(omitted.edges, [])
  assert.equal(packRelationDelivery([row(), row('supports')], { relationEdgeCap: 1 }).status, 'omitted_edge_cap')
  assert.equal(packRelationDelivery([row('future_kind')]).status, 'omitted_unknown_type')
  assert.throws(() => packRelationDelivery([], { relationCharacterBudget: 1 }), /explicit delivery status/)
})
test('final filters restrict complete snapshots, retain omissions and never upgrade omitted or legacy relations', () => {
  const complete = packRelationDelivery([row()], { selectionOmissions: ['body_budget'] })
  const selected = [{ workspace: 'project:test', entryId: '😀a' }]
  const filtered = filterRelationDelivery(complete, selected, { finalFilter: true })
  assert.equal(filtered.status, 'complete'); assert.deepEqual(filtered.edges, [])
  assert.deepEqual(filtered.selectionOmissions, ['body_budget', 'final_filter'])
  for (const original of [packRelationDelivery([row()], { relationCharacterBudget: 160 }), legacyRelationDelivery()]) {
    assert.notEqual(original.status, 'complete')
    assert.equal(filterRelationDelivery(original, [], { finalFilter: true }).status, original.status)
  }
  assert.equal(filterRelationDelivery(undefined, []).status, 'omitted_legacy')
})
test('invalid or partial relation envelopes cannot claim complete delivery', () => {
  const complete = packRelationDelivery([row()])
  assert.throws(() => validateRelationDelivery({ ...complete, status: 'omitted_edge_cap' }))
  assert.throws(() => validateRelationDelivery({ ...complete, scope: 'all_memory' }))
  assert.throws(() => validateRelationDelivery({ ...complete, edges: [{ ...complete.edges[0], type: 'invented' }] }))
  assert.throws(() => validateRelationDelivery({ ...complete, extra: true }))
  assert.throws(() => validateRelationDelivery({ ...complete, selectionOmissions: ['complete'] }))
})

test('explicit relation limits override environment defaults through the federated project lane', async () => {
  const {db}=fixture(),previous=process.env.KIOKUKO_RELATION_CHARACTER_BUDGET
  try {
    process.env.KIOKUKO_RELATION_CHARACTER_BUDGET='1'
    const result=await retrieveFederatedMemory(db,{query:'missing',scope:'project',project:{workspace:'project:test',repositoryId:'repo',repositoryRoot:'/repo',name:'test'} as any,
      relationCharacterBudget:8000,relationEdgeCap:128})
    assert.equal(result.project?.memory.relationDelivery?.status,'complete')
  } finally { if(previous===undefined)delete process.env.KIOKUKO_RELATION_CHARACTER_BUDGET;else process.env.KIOKUKO_RELATION_CHARACTER_BUDGET=previous;db.close() }
})

test('shared serialized envelope fixture counts the outer key and Unicode code points at the exact boundary', () => {
  const fixture=JSON.parse(readFileSync(new URL('../../fixtures/memory-relation-envelope.json',import.meta.url),'utf8'))
  for(const item of fixture.cases){
    assert.equal(JSON.stringify({relationDelivery:item.relationDelivery}),item.serializedEnvelope)
    assert.equal(Array.from(item.serializedEnvelope).length,item.codePoints)
    assert.equal(item.serializedEnvelope.length,item.utf16CodeUnits)
    assert.equal(Buffer.byteLength(item.serializedEnvelope),item.utf8Bytes)
    assert.equal(relationDeliveryCharacterCount(item.relationDelivery),item.codePoints)
  }
  const {rows,exactBudget,underBudget}=fixture.packingBoundary
  assert.equal(packRelationDelivery(rows,{relationCharacterBudget:exactBudget}).status,'complete')
  assert.equal(packRelationDelivery(rows,{relationCharacterBudget:underBudget}).status,'omitted_budget')
})
