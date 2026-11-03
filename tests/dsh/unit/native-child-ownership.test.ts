import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeChildOwnership } from '../../../src/dsh/lisp/native-child-ownership.js'

for (const flat of [false, true]) test(`native ownership binds concurrent ${flat ? 'current' : 'legacy'} launches to their exact parents`, async () => {
  const parents = ['a', 'b'].map(id => ({ id, session: { id, header: {} } }))
  const agents = new Map(parents.map(parent => [parent.id, parent]))
  let ownership: NativeChildOwnership
  const backend = { async startActivation(spec: any) {
    await new Promise(resolve => setImmediate(resolve))
    const parent = spec.parent ?? spec.request.parent
    const child = { id: spec.childId, session: { id: spec.childId, header: { parentSession: parent.id } } }
    agents.set(child.id, child)
    ownership.created(child)
    assert.equal(ownership.owns(child, parent), true, 'owned before activation publication')
    assert.equal(ownership.owns(child, parents.find(candidate => candidate !== parent)!), false)
    if (spec.fail) throw new Error('launch failed')
    return { childId: child.id }
  } }
  const original = backend.startActivation
  ownership = new NativeChildOwnership(backend, agents)
  try {
    await Promise.all(parents.map(parent => backend.startActivation({ provider: 'spawn', childId: `${parent.id}-child`, ...(flat ? { parent } : { request: { parent } }) })))
    const forged = { id: 'forged', session: { id: 'forged', header: { parentSession: 'a' } } }
    agents.set(forged.id, forged); ownership.created(forged)
    assert.equal(ownership.owns(forged, parents[0]!), false, 'matching metadata is not launch authority')
    await assert.rejects(backend.startActivation({ provider: 'spawn', parent: parents[0], childId: 'failed', fail: true }), /launch failed/)
    assert.equal(ownership.owns(agents.get('failed')!, parents[0]!), false, 'rejected launch revokes its captured proof')
    agents.set('a', { id: 'a', session: { id: 'a', header: {} } })
    assert.equal(ownership.owns(agents.get('a-child')!, parents[0]!), false, 'replaced parent is no longer live')
  } finally { ownership.dispose() }
  assert.equal(backend.startActivation, original)
})
