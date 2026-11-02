import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshToolDefinitions } from '../../../src/dsh/tools.js'

function fixture() {
  const bound: unknown[] = [], executed: unknown[] = []
  const definitions = createDshToolDefinitions({
    bind(execution) { bound.push(execution.arguments); return { runId: 'run', workspace: 'workspace', orchestrationId: 'orch', revision: 1 } },
    async execute(_name, args) { executed.push(args); return { kind: 'retry', reason: 'business validation' } },
  })
  const definition = definitions.find(tool => tool.name === 'curator_check')!
  const invoke = (args: unknown, signal = new AbortController().signal) => definition.execute(args, { name: definition.name, callId: 'call', arguments: {}, signal })
  return { definitions, bound, executed, invoke }
}

test('transport rejects nested wrong shapes before binding and business execution', async () => {
  for (const args of [null, [], '', { limit: 'many' }, { includeUnready: 1 }]) {
    const f = fixture()
    await assert.rejects(f.invoke(args), { code: 'VALIDATION_ERROR' })
    assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
  }
})

test('host identity rejection precedes transport validation and binding', async () => {
  const f = fixture()
  await assert.rejects(f.invoke({ workspace: 'forged' }), { code: 'SECURITY_REJECTION' })
  assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
})

test('host receives detached snapshot and accessors never run', async () => {
  const f = fixture(); let reads = 0
  const hostile = { get limit() { reads++; return -1 } }
  await assert.rejects(f.invoke(hostile), { code: 'VALIDATION_ERROR' })
  assert.equal(reads, 0)
})

test('all raw definitions validate their published root shape before effects', async () => {
  const f = fixture()
  for (const definition of f.definitions) {
    for (const args of [null, [], 3, 'encoded']) {
      await assert.rejects(definition.execute(args, { name: definition.name, callId: 'call', arguments: {}, signal: new AbortController().signal }), { code: 'VALIDATION_ERROR' })
    }
  }
  assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
})

test('non-JSON values and pre-cancelled direct calls cannot bind or execute', async () => {
  const f = fixture(), cycle: any = {}; cycle.self = cycle
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), cycle, { x: undefined }]) {
    await assert.rejects(f.invoke({ unknown: value }), { code: 'VALIDATION_ERROR' })
  }
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(f.invoke({ query: 'status' }, controller.signal), /cancelled/)
  assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
})
