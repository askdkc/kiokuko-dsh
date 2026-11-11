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
