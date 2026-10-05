import assert from 'node:assert/strict'
import test from 'node:test'
import { boundedJson, parseHotBundle, parseHotContract } from '../../../../src/dsh/lisp/hot-contracts.js'

const integer = { type: 'integer' as const }
const contract = (extra: Record<string, unknown> = {}) => ({
  name: 'add-one', description: 'Adds one', inputSchema: integer, outputSchema: integer,
  properties: [{ input: 1, expected: 2 }], ...extra,
})

test('hot contracts validate schemas and finite input/expected cases', () => {
  assert.deepEqual(parseHotContract(contract()).properties, [{ input: 1, expected: 2 }])
  assert.throws(() => parseHotContract(contract({ properties: [{ input: 'one', expected: 2 }] })), (error: any) => error.code === 'TASK_SCHEMA_MISMATCH')
  assert.throws(() => parseHotContract(contract({ inputSchema: { type: 'object', properties: {} } })), (error: any) => error.code === 'TASK_SCHEMA_INVALID')
  assert.throws(() => parseHotContract(contract({ expectedContractRef: 'not-a-uuid' })), (error: any) => error instanceof Error)
})

test('hot JSON rejects undefined, accessors, prototypes and cycles', () => {
  assert.throws(() => boundedJson(undefined, 100), (error: any) => error.code === 'HOT_JSON_INVALID')
  assert.throws(() => boundedJson({ value: undefined }, 100), (error: any) => error.code === 'HOT_JSON_INVALID')
  const accessor = {}
  Object.defineProperty(accessor, 'value', { get: () => 1, enumerable: true })
  assert.throws(() => boundedJson(accessor, 100), (error: any) => error.code === 'HOT_JSON_INVALID')
  assert.throws(() => boundedJson(Object.create({ value: 1 }), 100), (error: any) => error.code === 'HOT_JSON_INVALID')
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  assert.throws(() => boundedJson(cycle, 100), (error: any) => error.code === 'HOT_JSON_INVALID')
  const withToJson: unknown[] = [1]; Object.defineProperty(withToJson, 'toJSON', { value: () => 'forged' })
  assert.equal(boundedJson(withToJson, 100), '[1]', 'serialization must not execute toJSON')
})

test('hot JSON and source limits are bounded before persistence', () => {
  assert.throws(() => boundedJson('x'.repeat(101), 100), (error: any) => error.code === 'HOT_JSON_LIMIT')
  assert.throws(() => parseHotBundle({ name: 'add-one', contractRef: crypto.randomUUID(), source: 'x'.repeat(262145), inputSchema: integer, outputSchema: integer }), (error: any) => error.code === 'HOT_SOURCE_LIMIT' || error instanceof Error)
})
