import assert from 'node:assert/strict'
import test from 'node:test'
import { isNativeSubagent } from '../../../src/dsh/native-subagent.js'

test('main conversation lineage is not native delegation', () => {
  assert.equal(isNativeSubagent({}), false)
  assert.equal(isNativeSubagent({ session: { header: {} } }), false)
  // Model changes and rewinds preserve parentSession for the session tree.
  assert.equal(isNativeSubagent({ session: { header: { parentSession: 'previous-main-session' } } }), false)
  assert.equal(isNativeSubagent({ session: { header: { parentSession: 'previous-main-session', delegationDepth: 0 } } }), false)
})

test('explicit native delegation remains a child with or without a parent ID', () => {
  for (const header of [
    { origin: 'subagent' },
    { delegationDepth: 1 },
    { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
    { parentSession: 'parent', delegationDepth: 2 },
  ]) assert.equal(isNativeSubagent({ session: { header } }), true)
})
