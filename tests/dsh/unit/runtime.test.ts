import assert from 'node:assert/strict'
import test from 'node:test'
import { DshAgentStateRegistry, dshAgentKey, dshSessionEventSourceId } from '../../../src/dsh/agent-state.js'

test('agent state is unique and scoped by dsh session plus turn', () => {
  const registry = new DshAgentStateRegistry()
  const first = registry.open({ dshSessionId: 'session-a', turn: 1 }, 'repo-a', 'workspace-a', '2026-09-01T00:00:00.000Z')
  assert.equal(first.key, 'session-a\u00001')
  assert.throws(
    () => registry.open({ dshSessionId: 'session-a', turn: 1 }, 'repo-a', 'workspace-a'),
    /already has an active runtime state/u,
  )
  registry.open({ dshSessionId: 'session-b', turn: 1 }, 'repo-a', 'workspace-a')
  assert.equal(registry.size, 2)
  assert.equal(registry.close({ dshSessionId: 'session-a', turn: 1 }), true)
  assert.equal(registry.size, 1)
})

test('identity boundaries reject invisible format controls', () => {
  assert.throws(() => dshAgentKey({ dshSessionId: 'session\u200b', turn: 1 }), /bounded non-empty string/u)
  assert.throws(() => dshSessionEventSourceId('session', 1, 'run\u200b'), /Invalid dsh session event identity/u)
})
