import assert from 'node:assert/strict'
import test from 'node:test'
import { DshPonytailModes, executeDshPonytailCommand, mountDshPonytailCommand } from '../../../src/dsh/commands.js'

test('Ponytail modes are request-local and command registration uses the active request', () => {
  const modes = new DshPonytailModes()
  modes.begin('request-1')
  const registered: ((args: readonly string[]) => string)[] = []
  const dispose = mountDshPonytailCommand({ commands: { register: (_name, handler) => { registered.push(handler); return () => undefined } } }, modes)
  assert.equal(registered[0]!(['lite']), 'Ponytail mode set to lite for the active request.')
  assert.equal(modes.mode('request-1'), 'lite')
  assert.throws(() => registered[0]!(['broken']), /exactly one mode/u)
  modes.end('request-1')
  assert.equal(modes.mode('request-1'), undefined)
  assert.throws(() => executeDshPonytailCommand(modes, 'request-1', ['ultra']), /active logical request/u)
  dispose()
})

test('Ponytail mode cannot leak into another request', () => {
  const modes = new DshPonytailModes()
  modes.begin('request-1')
  modes.set('request-1', 'full')
  assert.throws(() => modes.begin('request-2'), /another logical request/u)
  modes.end('request-1')
  modes.begin('request-2')
  assert.equal(modes.mode('request-2'), undefined)
})
