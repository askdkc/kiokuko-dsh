import assert from 'node:assert/strict'
import test from 'node:test'
import { isLispNativeCommand, isLispNativeCommandFence, withLispNativeCommand } from '../../../../src/dsh/lisp-tool-identity.js'

test('CLI fence projection retains Lisp route without granting an unrelated native call', async () => {
  const controller = new AbortController(), agent = {}, execute = () => {}, args = { command: 'git status --short' }
  const execution = { name: 'bash', callId: 'lisp-command', parent: Symbol('lisp'), arguments: args, agent, signal: controller.signal }
  const projection = Object.freeze({ name: execution.name, arguments: args, agent })
  let current = true
  assert.equal(isLispNativeCommandFence(projection, execute), false)
  await withLispNativeCommand(execution, execute, { current: () => current }, async () => {
    assert.equal(isLispNativeCommandFence(projection, execute), true)
    assert.equal(isLispNativeCommand(execution, execute), true)
    assert.equal(isLispNativeCommand({ ...execution, callId: 'unrelated' }, execute), false)
    assert.equal(isLispNativeCommandFence({ ...projection, agent: {} }, execute), false)
    assert.equal(isLispNativeCommandFence({ ...projection, name: 'zsh' }, execute), false)
    assert.equal(isLispNativeCommandFence({ ...projection, arguments: { command: 'other' } }, execute), false)
    assert.equal(isLispNativeCommandFence(projection, () => {}), false)
    current = false
    assert.equal(isLispNativeCommandFence(projection, execute), false)
    current = true; controller.abort()
    assert.equal(isLispNativeCommandFence(projection, execute), false)
  })
  assert.equal(isLispNativeCommandFence(projection, execute), false)
})
