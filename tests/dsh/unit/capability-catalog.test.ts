import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshCapabilityCatalog, assertCompleteDshCapabilityCatalog, assertDshCapabilityCatalogStable } from '../../../src/dsh/capability-catalog.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { dshTurnRequestId, resolveGroundedIntakeProfile } from '../../../src/dsh/intake-profile-resolver.js'
import { MAX_RAW_CAPABILITY_DESCRIPTION_CHARS } from '../../../src/akinator/capabilities.js'
import { assertCapabilityCatalogBinding, bindCapabilityCatalog } from '../../../src/akinator/capability-binding.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'

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

test('dsh capability descriptions accept native multiline text within the raw catalog bound', async () => {
  const skills = await standardSnapshot()
  const description = `First paragraph.\n\nSecond paragraph.\tIndented.\r\n${'x'.repeat(2_000)}`
  const catalog = createDshCapabilityCatalog({
    skills,
    tools: [{ kind: 'tool', name: 'native-tool', description }],
  })
  assert.equal(catalog.tools[0]?.description, description)
  assert.throws(() => createDshCapabilityCatalog({
    skills,
    tools: [{ kind: 'tool', name: 'unsafe-tool', description: 'before\u0000after' }],
  }), /description is invalid/u)
  assert.throws(() => createDshCapabilityCatalog({
    skills,
    tools: [{ kind: 'tool', name: 'oversized-tool', description: 'x'.repeat(MAX_RAW_CAPABILITY_DESCRIPTION_CHARS + 1) }],
  }), /description is invalid/u)
})

test('grounded profile and dsh turn request identity are deterministic', () => {
  const profile = resolveGroundedIntakeProfile({ task: 'Implement the feature', cwd: '/repo', evidence: ['verified repository root'] })
  assert.equal(profile.profileHints.taskType, 'build')
  assert.equal(profile.profileHints.target, '/repo')
  assert.equal(profile.profileHints.expected, 'Implement the feature')
  const long = resolveGroundedIntakeProfile({ task: `Implement ${'x'.repeat(5_000)}`, cwd: '/repo' })
  assert.equal(long.profileHints.expected, 'Complete the requested work and verify the result against the full task.')
  assert.equal(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }), dshTurnRequestId({ dshSessionId: 'session', turn: 1 }))
  assert.notEqual(dshTurnRequestId({ dshSessionId: 'session', turn: 1 }), dshTurnRequestId({ dshSessionId: 'session', turn: 2 }))
  assert.throws(() => resolveGroundedIntakeProfile({ task: 'task', cwd: 'relative' }), /absolute/u)
})

test('new run bindings use v2 while a migrated active DSH run can read its v1 tool digest', () => {
  const current = [
    { kind: 'skill' as const, name: 'kiokuko-soul' },
    { kind: 'tool' as const, name: 'enno_plan_submit' },
  ]
  const bound = bindCapabilityCatalog({}, current)
  assert.equal((bound.kiokukoCapabilityCatalogBinding as { version: number }).version, 2)
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(bound, current))

  const legacyDigest = canonicalContentHash({
    version: 1,
    supplied: true,
    availability: 'known-nonempty',
    diagnostics: { received: 2, accepted: 2, truncated: 0, dropped: 0 },
    budgetExceeded: false,
    skills: [{ kind: 'skill', name: 'kiokuko-soul' }],
    tools: [{ kind: 'mcp_tool', name: 'enno_plan_submit' }],
  })
  const migrated = { kiokukoCapabilityCatalogBinding: { version: 1, digest: legacyDigest } }
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(migrated, current))
  assert.throws(
    () => assertCapabilityCatalogBinding(migrated, [...current, { kind: 'tool', name: 'enno_finish' }]),
    /catalog differs/u,
  )
})
