import assert from 'node:assert/strict'
import test from 'node:test'
import { continuationMessage, recoveryMessage } from '../../../src/dsh/host-adapter.js'
import { KIOKUKO_DSH_SOURCE_KIND } from '../../../src/dsh/plugin-source.js'

function assertV4ProducerSource(source: unknown): void {
  assert.equal(typeof source, 'object')
  assert.notEqual(source, null)
  const record = source as Record<string, unknown>
  assert.equal(record['kind'], KIOKUKO_DSH_SOURCE_KIND)
  assert.equal(Object.hasOwn(record, 'plugin'), false)
  assert.equal(Object.hasOwn(record, 'deliveryId'), false)
  assert.equal(record['form'], 'instructions')
}

const continuationId = 'a'.repeat(64)
assert.match(continuationId, /^[0-9a-f]{64}$/u)

test('automatic continuation messages carry a V4 producer source without deliveryId', () => {
  for (const nextAction of ['submit_plan', 'execute_work_unit', 'complete'] as const) {
    const message = continuationMessage(continuationId, nextAction) as Record<string, unknown>
    assert.equal(message['id'], continuationId)
    assert.equal(message['role'], 'user')
    assertV4ProducerSource((message as { source: unknown }).source)
  }
})

test('user recovery messages carry a V4 producer source without deliveryId', () => {
  const message = recoveryMessage(continuationId, 'answer') as Record<string, unknown>
  assert.equal(message['id'], continuationId)
  assert.equal(message['role'], 'user')
  assert.match(JSON.stringify(message), /answer/u)
  assertV4ProducerSource((message as { source: unknown }).source)
})
