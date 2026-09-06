import assert from 'node:assert/strict'
import test from 'node:test'
import { continuationMessage, recoveryMessage } from '../../../src/dsh/host-adapter.js'

// Mirror of the frozen DSH v0 plugin-source schema in
// session-format-v0-to-v1 payload-validation.ts pluginSourceValue:
// required `kind: 'plugin'`, `plugin`, optional `form|sections|summary`,
// and the exact released v0 `form` literals. `deliveryId` is never allowed.
const V0_PLUGIN_SOURCE_MEMBERS = new Set(['kind', 'plugin', 'form', 'sections', 'summary'])
const V0_PLUGIN_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])

function assertReleasedV0PluginSource(source: unknown): void {
  assert.equal(typeof source, 'object')
  assert.notEqual(source, null)
  const record = source as Record<string, unknown>
  assert.equal(record['kind'], 'plugin')
  assert.equal(typeof record['plugin'], 'string')
  for (const key of Object.keys(record)) {
    assert.equal(V0_PLUGIN_SOURCE_MEMBERS.has(key), true, `unexpected source member: ${key}`)
  }
  assert.equal(Object.hasOwn(record, 'deliveryId'), false)
  if (Object.hasOwn(record, 'form')) {
    assert.equal(V0_PLUGIN_FORMS.has(record['form'] as string), true, `retired form literal: ${String(record['form'])}`)
  }
}

const continuationId = 'a'.repeat(64)
assert.match(continuationId, /^[0-9a-f]{64}$/u)

test('automatic continuation messages carry a released v0 plugin source without deliveryId', () => {
  for (const nextAction of ['submit_plan', 'execute_work_unit', 'complete'] as const) {
    const message = continuationMessage(continuationId, nextAction) as Record<string, unknown>
    assert.equal(message['id'], continuationId)
    assert.equal(message['role'], 'user')
    assertReleasedV0PluginSource((message as { source: unknown }).source)
  }
})

test('user recovery messages carry a released v0 plugin source without deliveryId', () => {
  const message = recoveryMessage(continuationId, 'answer') as Record<string, unknown>
  assert.equal(message['id'], continuationId)
  assert.equal(message['role'], 'user')
  assert.match(JSON.stringify(message), /answer/u)
  assertReleasedV0PluginSource((message as { source: unknown }).source)
})
