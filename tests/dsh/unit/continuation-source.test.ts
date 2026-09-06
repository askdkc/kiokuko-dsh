import assert from 'node:assert/strict'
import test from 'node:test'
import { eventContinuationId, pluginContinuationId } from '../../../src/dsh/host-adapter.js'

const continuationId = 'a'.repeat(64)

function message(source: Record<string, unknown>, id = continuationId): Record<string, unknown> {
  return { id, role: 'user', content: [{ type: 'text', text: 'continue' }], source }
}

test('recognizes schema-safe continuation messages by their 64-hex message id', () => {
  const value = message({ kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' })
  assert.equal(pluginContinuationId(value), continuationId)
  assert.equal(eventContinuationId({ message: value }), continuationId)
})

test('salvages legacy continuation source deliveryId without accepting unrelated sources', () => {
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'continuation', deliveryId: continuationId,
  }, 'legacy-message-id')), continuationId)
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'loop-recovery', deliveryId: continuationId,
  }, 'legacy-recovery-id')), continuationId)
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'other-plugin', form: 'instructions',
  })), undefined)
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions',
  }, 'not-a-continuation')), undefined)
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'snapshot', sections: [],
  })), undefined)
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions',
  }, '550e8400-e29b-41d4-a716-446655440000')), undefined)
  assert.equal(pluginContinuationId(message({
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions',
  }, 'kiokuko-memory-finalization:run-1')), undefined)
})
