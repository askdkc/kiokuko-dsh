import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DshModules, type DshModule, type ModuleBinding } from '../../../src/dsh/core/modules.js'
import { CURRENT_MIGRATION_SNAPSHOT } from '../../fixtures/current-migrations.js'

test('module compatibility allowlist includes the complete current migration history', () => {
  const compatibility = JSON.parse(readFileSync(new URL('../../../scripts/module-compatibility-assets.json', import.meta.url), 'utf8'))
  assert.deepEqual(compatibility.migrations, CURRENT_MIGRATION_SNAPSHOT.migrations.map(migration => `migrations/${migration.name}`),
    'Update the explicit module compatibility allowlist when adding a migration')
})

const empty: DshModule<string[]> = { id: 'writing', coreVersion: 1, requires: [], configure: value => { if (value !== undefined) throw new Error('invalid config'); return undefined } }
const binding = (moduleId: string): ModuleBinding => ({ moduleId, version: 1, requestId: 'request', sessionId: 'session', workspace: 'workspace' })
function feature(id: string): DshModule<string[]> {
  return { ...empty, id, async mount({ host, defer }) {
    host.push(`mount:${id}`); defer(() => { host.push(`release:${id}`) })
    return { stopIngress() { host.push(`stop:${id}`) }, async drain() { host.push(`drain:${id}`) }, async dispose() { host.push(`dispose:${id}`) } }
  } }
}
test('module registration rejects duplicate IDs, incompatible contracts, unavailable capabilities and invalid config before mount', () => {
  for (const registrations of [[{ module: empty }, { module: empty }], [{ module: { ...empty, coreVersion: 2 } }], [{ module: { ...empty, requires: ['network'] } }], [{ module: empty, configuration: true }]]) assert.throws(() => new DshModules(registrations, []))
  const resource = { name: 'writing', relativePath: 'SKILL.md', load: async () => 'text' }
  assert.throws(() => new DshModules([{ module: { ...empty, resources: [resource, resource] } }], []))
})
test('noncoding feature and resource-only Skill mount without core router changes; request identity and exclusions stay host-owned', async () => {
  const events: string[] = []
  const registry = new DshModules([{ module: feature('writing') }, { module: { ...empty, id: 'organizing', conflicts: ['writing'], resources: [{ name: 'organizing', relativePath: 'SKILL.md', load: async () => 'organize' }] } }], [])
  await registry.mount(events)
  assert.deepEqual(registry.ids(), ['writing', 'organizing'])
  assert.equal(await registry.resources()[0]!.load(), 'organize')
  registry.admit([binding('writing')])
  assert.throws(() => registry.admit([binding('missing')]), /unavailable/)
  assert.throws(() => registry.admit([binding('writing'), binding('organizing')]), /Conflicting/)
  assert.throws(() => registry.admit([binding('writing'), { ...binding('organizing'), sessionId: 'other' }]), /identity/)
  assert.throws(() => registry.admit([{ ...binding('writing'), version: 2 }]), /unavailable/)
  await registry.dispose()
  assert.throws(() => registry.require(binding('writing')), /stopped/)
  await assert.rejects(registry.mount(events), /restarted/)
})
test('shutdown stops every ingress before draining and releases resources once, in reverse order', async () => {
  const events: string[] = []
  const registry = new DshModules([{ module: feature('first') }, { module: feature('second') }], [])
  await Promise.all([registry.mount(events), registry.mount(events)])
  registry.stopIngress()
  await Promise.all([registry.dispose(), registry.dispose()])
  assert.deepEqual(events, ['mount:first', 'mount:second', 'stop:second', 'stop:first', 'drain:second', 'drain:first', 'dispose:second', 'release:second', 'dispose:first', 'release:first'])
})
test('partial mount failure releases acquired resources and mounted siblings without hiding the primary error', async () => {
  const events: string[] = [], failure = new Error('partial')
  const registry = new DshModules([{ module: feature('first') }, { module: { ...empty, id: 'broken', async mount({ defer }) { events.push('acquire:broken'); defer(() => { events.push('release:broken') }); throw failure } } }], [])
  await assert.rejects(registry.mount(events), error => error === failure)
  assert.deepEqual(events, ['mount:first', 'acquire:broken', 'release:broken', 'stop:first', 'drain:first', 'dispose:first', 'release:first'])
  await assert.rejects(registry.dispose(), error => error === failure)
})
test('failed drain preserves resources and reports failure instead of pretending unload is safe', async () => {
  const events: string[] = [], failure = new Error('UNKNOWN operation')
  const registry = new DshModules([{ module: { ...feature('worker'), async mount({ defer }) { defer(() => { events.push('release') }); return { stopIngress() { events.push('fence-retained') }, async drain() { throw failure }, async dispose() { events.push('dispose') } } } } }], [])
  await registry.mount(events)
  await assert.rejects(registry.dispose(), error => error === failure)
  assert.deepEqual(events, ['fence-retained'])
})
test('failed partial rollback preserves shared resources and both failure identities', async () => {
  const primary = new Error('mount failed'), cleanup = new Error('worker stop unconfirmed')
  const registry = new DshModules([{ module: { ...empty, async mount({ defer }) { defer(() => { throw cleanup }); throw primary } } }], [])
  await assert.rejects(registry.mount([]), error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup)
  assert.equal(registry.drained, false)
})
test('stop during asynchronous mount also stops the just-created handle and disposes it once', async () => {
  const events: string[] = []
  let ready!: () => void
  const pause = new Promise<void>(resolve => { ready = resolve })
  const registry = new DshModules([{ module: { ...empty, async mount() { await pause; return { stopIngress() { events.push('stop') }, async drain() { events.push('drain') }, async dispose() { events.push('dispose') } } } } }], [])
  const mounting = registry.mount(events)
  registry.stopIngress(); ready()
  await assert.rejects(mounting, /stopped/)
  assert.deepEqual(events, ['stop', 'drain', 'dispose'])
})
