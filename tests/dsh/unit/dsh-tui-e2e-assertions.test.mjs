import test from 'node:test'
import assert from 'node:assert/strict'
import { assertKiokukoInstalled, assertRemoved, assertExpectedPatchWarning, parseRows } from '../../../scripts/dsh-tui-e2e-assertions.mjs'

const valid = [{ id: 'dsh-tui' }, { id: 'kiokuko-dsh', name: 'kiokuko-dsh', inject: ['skills', 'systemPrompt', 'tools', 'commands', 'sessions', 'sessionQuery', 'sessionPersistence', 'agents', 'subagents'], config: { enabled: true, orca: { enabled: true } } }]

test('config assertion rejects duplicate, disabled and incomplete Kiokuko entries', () => {
  assert.doesNotThrow(() => assertKiokukoInstalled(valid))
  for (const broken of [[...valid, valid[1]], [valid[0], { ...valid[1], disabled: true }], [valid[0], { ...valid[1], inject: ['skills'] }]]) {
    assert.throws(() => assertKiokukoInstalled(broken))
  }
})

test('config assertion rejects malformed YAML and incomplete removal', () => {
  assert.throws(() => parseRows('- id: [\n'))
  assert.doesNotThrow(() => assertRemoved([valid[0]], [valid[0]]))
  assert.throws(() => assertRemoved([valid[0]], valid))
})

test('only the known missing Web patch warning is accepted', () => {
  assert.doesNotThrow(() => assertExpectedPatchWarning('dsh: [kiokuko-dsh] patch: entry "session-log-download" not found\n'))
  assert.throws(() => assertExpectedPatchWarning('dsh: [other] patch: entry "unexpected" not found\n'))
  assert.throws(() => assertExpectedPatchWarning('dsh: [kiokuko-dsh] patch: entry "session-log-download" not found\ndsh: warning: another plugin failed\n'))
})
