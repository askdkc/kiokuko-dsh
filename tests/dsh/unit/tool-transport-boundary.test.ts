import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshToolDefinitions } from '../../../src/dsh/tools.js'

function fixture() {
  const bound: unknown[] = [], executed: unknown[] = []
  const definitions = createDshToolDefinitions({
    bind(execution) { bound.push(execution.arguments); return { runId: 'run', workspace: 'workspace', orchestrationId: 'orch', revision: 1, routeEpoch: 0, workUnitId: 'work', leaseToken: 'lease' } },
    async execute(_name, args) { executed.push(args); return { kind: 'retry', reason: 'business validation' } },
  })
  const definition = definitions.find(tool => tool.name === 'enno_work_report')!
  const invoke = (args: unknown, signal = new AbortController().signal) => definition.execute(args, { name: definition.name, callId: 'call', arguments: {}, signal })
  return { definitions, bound, executed, invoke }
}

test('transport rejects nested wrong shapes before binding and business execution', async () => {
  for (const args of [null, [], '', { result: '{}' }, { result: { mutated: 'false' } }, { result: { changedPaths: '[]' } }, { result: { changedPaths: [1] } }]) {
    const f = fixture()
    await assert.rejects(f.invoke(args), { code: 'VALIDATION_ERROR' })
    assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
  }
})

test('host identity rejection precedes transport validation and binding', async () => {
  const f = fixture()
  await assert.rejects(f.invoke({ result: '{}', workspace: 'forged' }), { code: 'SECURITY_REJECTION' })
  assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
})

test('missing fields, enums, and unknown fields remain business validation with lossless values', async () => {
  for (const args of [{}, { result: { outcome: 'not-an-enum', changedPaths: [], custom: { x: -0 } }, unknown: [null, true, 'x'] }]) {
    const f = fixture()
    assert.equal((await f.invoke(args) as any).kind, 'retry')
    assert.deepEqual(JSON.parse(JSON.stringify(f.executed[0])), JSON.parse(JSON.stringify(args)))
    if ('result' in args) assert.ok(Object.is((f.executed[0] as any).result.custom.x, -0))
  }
})

test('host receives detached snapshot and accessors never run', async () => {
  const f = fixture(); let reads = 0
  const hostile = { get result() { reads++; return {} } }
  await assert.rejects(f.invoke(hostile), { code: 'VALIDATION_ERROR' })
  assert.equal(reads, 0); assert.deepEqual(f.bound, [])
  const args = { result: { changedPaths: ['old'] } }
  await f.invoke(args)
  args.result.changedPaths[0] = 'new'
  assert.equal((f.executed[0] as any).result.changedPaths[0], 'old')
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
  await assert.rejects(f.invoke({}, controller.signal), /cancelled/)
  assert.deepEqual(f.bound, []); assert.deepEqual(f.executed, [])
})
