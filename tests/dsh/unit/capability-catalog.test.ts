import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshCapabilityCatalog, assertCompleteDshCapabilityCatalog, assertDshCapabilityCatalogStable } from '../../../src/dsh/capability-catalog.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { dshTurnRequestId, resolveGroundedIntakeProfile } from '../../../src/dsh/intake-profile-resolver.js'

async function standardSnapshot(): Promise<unknown[]> {
  const provider = createStandardSkillProvider()
  try {
    const result = await provider.list({})
    const candidates = 'complete' in result ? result.candidates : result
    return candidates.map(({ name, description }) => ({ kind: 'skill', name, description }))
  } finally {
    provider.dispose()
  }
}

test('dsh capability catalog is complete, immutable, and order-bound', async () => {
  const catalog = createDshCapabilityCatalog(await standardSnapshot())
  assert.equal(catalog.complete, true)
  assert.equal(catalog.skills.length, 6)
  assert.match(catalog.digest, /^[0-9a-f]{64}$/u)
  assert.doesNotThrow(() => assertCompleteDshCapabilityCatalog(catalog))
  assert.throws(() => createDshCapabilityCatalog([...catalog.skills].reverse()), /reordered|incomplete/u)
  assert.throws(() => createDshCapabilityCatalog([...catalog.skills, catalog.skills[0]!]), /Duplicate/u)
  assert.throws(() => createDshCapabilityCatalog([...catalog.skills, { kind: 'unknown', name: 'bad' }]), /snapshot|descriptor/u)
  assert.throws(() => assertCompleteDshCapabilityCatalog({ ...catalog, complete: false }), /incomplete/u)
  assert.throws(() => assertDshCapabilityCatalogStable(catalog, { ...catalog, digest: '0'.repeat(64) }), /changed/u)
})

test('grounded profile and dsh turn request identity are deterministic', () => {
  const profile = resolveGroundedIntakeProfile({ task: 'Implement the feature', cwd: '/repo', evidence: ['verified repository root'] })
  assert.equal(profile.profileHints.taskType, 'build')
  assert.equal(profile.profileHints.target, null)
  assert.equal(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }), dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))
  assert.notEqual(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }), dshTurnRequestId({ dshSessionId: 'session', turn: 2 }))
  assert.throws(() => resolveGroundedIntakeProfile({ task: 'task', cwd: 'relative' }), /absolute/u)
})
