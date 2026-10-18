import test from 'node:test'
import assert from 'node:assert/strict'
import { serializeModelMemoryContext, normalizeStoredModelContext } from '../../../src/context/model-memory.js'
import { DeepConfigurationSchema, DEEP_ROLES } from '../../../src/deep-thinker/core/contracts.js'
import { initialDeepState } from '../../../src/deep-thinker/initial-state.js'
import { jobFor } from '../../../src/deep-thinker/prompts.js'
import { packRelationDelivery } from '../../../src/memory/relation-delivery.js'

test('Deep preserves 16000 Unicode characters and typed links beyond the old 32768 UTF-16 cutoff', () => {
  const ids = ['a'.repeat(100), 'b'.repeat(100)]
  const items = [{ workspace: 'project:test', entryId: ids[0]!, title: 'A', summary: null, bodyPreview: '😀'.repeat(15990) },
    { workspace: 'project:test', entryId: ids[1]!, title: 'B', summary: null, bodyPreview: 'tiny' }]
  const relationDelivery = packRelationDelivery(['supports', 'contradicts', 'derived_from', 'related_to'].map(relation => ({ kind: 'edge',
    from_id: ids[0]!, from_workspace: 'project:test', to_id: ids[1]!, to_workspace: 'project:test', relation })))
  const context = serializeModelMemoryContext({ items, relationDelivery })
  assert.ok(context.length > 32768)
  assert.equal(JSON.parse(context).relationDelivery.edges.length, 4)
  assert.ok(JSON.parse(context).items[0].text.endsWith('😀'.repeat(15990)))
  const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, {provider: 'test', model: role}])) })
  const state = initialDeepState({revision: 0, startId: 'start', runId: null, workspace: 'project:test', sessionId: 'session', rootPath: '/repo',
    commandId: 'command', messageId: 'message', task: 'Inspect the problem', status: 'pending', configuration, messages: [], problem: ''}, 'run', context)
  const job = jobFor(state, state.nodes[0]!, 'planner', [])
  assert.ok(job.prompt.includes('😀'.repeat(15990)))
  assert.ok(job.prompt.includes('contradicts'))
})
test('old or cut Deep snapshots explicitly report omitted legacy relations', () => {
  for (const context of ['', '{"items":[', '{}']) assert.equal(JSON.parse(normalizeStoredModelContext(context)).relationDelivery.status, 'omitted_legacy')
})

test('Deep replay preserves explicit relation limits above the defaults', () => {
  const items = Array.from({length: 18}, (_,i) => ({workspace:'project:test',entryId:`entry-${i}-${'x'.repeat(90)}`,title:'Fact',summary:null,bodyPreview:'body'}))
  const rows = Array.from({length: 140}, (_,i) => ({kind:'edge',from_id:items[Math.floor(i/18)]!.entryId,from_workspace:'project:test',to_id:items[i%18]!.entryId,to_workspace:'project:test',relation:'supports'}))
  const limits={relationCharacterBudget:60000,relationEdgeCap:160}
  const relationDelivery=packRelationDelivery(rows,limits)
  assert.equal(relationDelivery.status,'complete')
  assert.ok(Array.from(JSON.stringify(relationDelivery)).length>8000)
  const context=serializeModelMemoryContext({items,relationDelivery,...limits})
  const replay=JSON.parse(normalizeStoredModelContext(context))
  assert.deepEqual(replay.relationDelivery,relationDelivery)
  assert.equal(replay.relationCharacterBudget,60000)
  assert.equal(replay.relationEdgeCap,160)
})
