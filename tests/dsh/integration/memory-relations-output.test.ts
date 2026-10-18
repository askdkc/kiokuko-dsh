import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './enno-memory/fixture.js'
import { recordEntry, updateCandidateEntry } from '../../../src/memory/entries.js'
import { queryScopedContextGated } from '../../../src/context/scoped-broker.js'
import { injectDshContext } from '../../../src/dsh/context-injection.js'
import { currentRequestMemory, rebuildRequestMemory } from '../../../src/dsh/request-memory.js'
import { KIOKUKO_DSH_SOURCE_KIND } from '../../../src/dsh/plugin-source.js'
import { readContextDelivery } from '../../../src/context/delivery.js'
import { RELATION_TYPES } from '../../../src/memory/relation-delivery.js'

const envelope = (text: string) => JSON.parse(text.slice(text.indexOf('{')))
for (const relationEdgeCap of [128, 1]) test(`relations reach final model content and survive final filtering honestly (cap ${relationEdgeCap})`, async () => {
  const f = await fixture()
  try {
    const entries = ['A', 'B'].map(title => recordEntry(f.db, { workspace: f.prepared.project.workspace, kind: 'lesson',
      title: 'E_LOCK_TIMEOUT ' + title, body: 'E_LOCK_TIMEOUT procedure ' + title, createdBy: 'fixture', scope: { visibility: 'project' } }))
    for (const [i, type] of RELATION_TYPES.entries()) f.db.prepare('INSERT INTO entry_links VALUES(?,?,?,?,?)').run(entries[i % 2]!.id,
      entries[1 - i % 2]!.id, type, '2026-10-18T00:00:00.000Z', 'fixture')
    const { context } = await queryScopedContextGated(f.db, { project: f.prepared.project, task: 'E_LOCK_TIMEOUT',
      taskProfile: f.prepared.intake.profile, recommendedTags: f.prepared.intake.recommendedTags, runId: f.prepared.run.runId,
      relationEdgeCap }, () => ({ persist: true, value: true }))
    assert.ok(context?.deliveryId)
    const prepared = { ...f.prepared, context }
    const stored = readContextDelivery(f.db, { workspace: f.prepared.project.workspace, deliveryId: context!.deliveryId! })
    assert.deepEqual(stored.relationDelivery, context!.relationDelivery)
    const messages = await injectDshContext({ prepared, task: 'E_LOCK_TIMEOUT', runtime: f.runtime })
    const relationText = messages.find(message => message.source === 'memory' && message.name === 'relations')!.content
    const supplied = messages.filter(message => message.source === 'memory' && message.name.startsWith('memory:')).map(message => JSON.parse(message.content))
    assert.ok(supplied.some(item => item.entryId === entries[0]!.id && item.workspace === f.prepared.project.workspace))
    assert.ok(supplied.some(item => item.entryId === entries[1]!.id && item.workspace === f.prepared.project.workspace))
    const delivery = envelope(relationText)
    assert.equal(delivery.status, relationEdgeCap === 128 ? 'complete' : 'omitted_edge_cap')
    assert.equal(delivery.edges.length, relationEdgeCap === 128 ? 4 : 0)
    if (delivery.status === 'complete') assert.deepEqual(new Set(delivery.edges.map((edge: any) => edge.type)), new Set(RELATION_TYPES))
    const native = messages.map(message => ({ role: 'user', content: [{ type: 'text', text: message.content }],
      source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'snapshot', sections: [{ name: message.source + ':' + message.name, text: message.content }] } }))
    const changed = entries[1]!
    updateCandidateEntry(f.db, { workspace: changed.workspace, entryId: changed.id, expectedRevision: changed.revision,
      kind: changed.kind, title: changed.title, body: 'Changed after selection', createdBy: 'fixture', scope: { visibility: 'project' } })
    const allowed = currentRequestMemory(f.db, prepared)
    const request = rebuildRequestMemory(native, allowed) as typeof native
    assert.ok(!JSON.stringify(request).includes(changed.id), 'neither old body nor dangling relation endpoint reaches the model')
    const finalRelations = envelope(request.flatMap(message => message.source.sections).find(section => section.name === 'memory:relations')!.text)
    assert.equal(finalRelations.status, relationEdgeCap === 128 ? 'complete' : 'omitted_edge_cap')
    assert.deepEqual(finalRelations.edges, [])
    assert.ok(finalRelations.selectionOmissions.includes('final_filter'))
  } finally { await f.close() }
})
