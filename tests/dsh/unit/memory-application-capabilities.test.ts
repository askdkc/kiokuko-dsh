import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCapabilityCatalog, memoryReasoningCapabilityAvailability, deriveMemoryPolicy, MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS } from '../../../src/akinator/capabilities.js'
import { bindCapabilityCatalog, assertCapabilityCatalogBinding } from '../../../src/akinator/capability-binding.js'

test('201+ capabilities and oversized descriptions cannot hide a later memory Skill', () => {
  const items = Array.from({ length: 230 }, (_, index) => ({ kind: 'tool', name: `tool-${index}`, description: 'x'.repeat(65_000) }))
  const all = [...items, { kind: 'skill', name: 'memory-reasoning' }]
  const result = normalizeCapabilityCatalog(all)
  assert.equal(result.availability, 'known-nonempty')
  assert.equal(result.diagnostics.accepted, 231)
  assert.equal(result.diagnostics.dropped, 0)
  assert.equal(memoryReasoningCapabilityAvailability(all), 'available')
  assert.equal(result.diagnostics.truncated, 230)
  assert.equal(items[0]?.description.length, 65000, 'normalization does not mutate the native inventory')
  const binding = bindCapabilityCatalog({}, all)
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(binding, all))
  assert.throws(() => assertCapabilityCatalogBinding(binding, [...all, { kind: 'tool', name: 'added' }]), /differs/)
})

test('identity exhaustion and malformed descriptors remain explicitly incomplete', () => {
  const items = Array.from({ length: Math.ceil(MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS / 300) + 10 }, (_, index) => ({ kind: 'tool', name: `${index}`.padEnd(300, 'x') }))
  const result = normalizeCapabilityCatalog(items)
  assert.equal(result.availability, 'unknown'); assert.equal(result.budgetExceeded, true)
  assert.ok(result.diagnostics.dropped > 0)
  assert.equal(normalizeCapabilityCatalog([{ kind: 'tool', name: 'valid' }, { kind: 'tool', name: 'broken', description: 7 }]).availability, 'unknown')
})

test('code plans and code reviews require memory reasoning, ordinary prose remains lightweight', () => {
  for (const taskType of ['review', 'analysis', 'writing'] as const) {
    const policy = deriveMemoryPolicy({ taskType, target: 'TypeScript migration code', expected: 'Review implementation plan' }, 'actionable', [])
    assert.equal(policy.memoryReasoningRequired, true)
    assert.equal(policy.contextWithheld, true)
    assert.equal(policy.withheldReason, 'memory_reasoning_missing')
  }
  assert.equal(deriveMemoryPolicy({ taskType: 'writing', target: 'short prose' }, 'actionable', []).memoryReasoningRequired, false)
})
