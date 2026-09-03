import assert from 'node:assert/strict'
import test from 'node:test'
import { DshPonytailModes, dshPonytailOwnerKey, executeDshPonytailCommand, mountDshPonytailCommand } from '../../../src/dsh/commands.js'

test('Ponytail modes are request-local and command registration uses the active request', () => {
  const modes = new DshPonytailModes()
  modes.begin('request-1')
  const definitions: any[] = []
  const dispose = mountDshPonytailCommand({ commands: { register: (definition: any) => { definitions.push(definition); return () => undefined } } }, modes)
  const definition = definitions[0]!
  assert.equal(definition.name, 'ponytail')
  const invoke = (args: readonly string[], owner?: string) => definition.handler({
    rawInput: args.join(' '),
    agent: owner === undefined ? undefined : { id: 'agent-1', session: { id: owner } },
    signal: new AbortController().signal,
  })
  assert.deepEqual(invoke(['lite']), { kind: 'success', text: 'Ponytail mode set to lite for the active request.' })
  assert.equal(modes.mode('request-1'), 'lite')
  assert.deepEqual(invoke(['broken', 'full']), { kind: 'error', text: 'ponytail requires exactly one mode: lite, full, or ultra' })
  modes.end('request-1')
  assert.equal(modes.mode('request-1'), undefined)
  assert.throws(() => executeDshPonytailCommand(modes, 'request-1', ['ultra']), /active logical request/u)
  dispose()
})

test('Ponytail modes isolate concurrent requests', () => {
  const modes = new DshPonytailModes()
  modes.begin('request-1', 'owner-1')
  modes.set('request-1', 'full')
  modes.begin('request-2', 'owner-2')
  assert.equal(modes.mode('request-1'), 'full')
  assert.equal(modes.mode('request-2'), undefined)
  assert.throws(() => modes.execute(['lite']), /current request scope/u)
  assert.equal(modes.execute(['ultra'], 'owner-2'), 'Ponytail mode set to ultra for the active request.')
  assert.equal(modes.mode('request-1'), 'full')
  assert.equal(modes.mode('request-2'), 'ultra')
  modes.end('request-1')
  assert.equal(modes.mode('request-1'), undefined)
  assert.equal(modes.mode('request-2'), 'ultra')
  modes.begin('request-3', 'owner-2')
  assert.equal(modes.isActive('request-2'), false)
  assert.equal(modes.isActive('request-3'), true)
  assert.equal(modes.mode('request-3'), undefined)
})

test('native Ponytail command updates only its invoking conversation', async () => {
  const modes = new DshPonytailModes()
  modes.begin('request-1', dshPonytailOwnerKey('agent-1', 'session-1'))
  modes.begin('request-2', dshPonytailOwnerKey('agent-2', 'session-2'))
  const definitions: any[] = []
  const dispose = mountDshPonytailCommand({ commands: {
    register(definition: any) { definitions.push(definition); return () => undefined },
  } }, modes)
  const result = await definitions[0]!.handler({
    rawInput: 'lite',
    agent: { id: 'agent-2', session: { id: 'session-2' } },
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { kind: 'success', text: 'Ponytail mode set to lite for the active request.' })
  assert.equal(modes.mode('request-1'), undefined)
  assert.equal(modes.mode('request-2'), 'lite')
  dispose()
})
