/** Public/saved configuration contracts. Native loop behavior is covered separately. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import * as publicPlugin from '../../../src/index.js'
import * as dshPlugin from '../../../src/dsh/index.js'
import { Config as CoreConfig, createConfiguredPlugin } from '../../../src/dsh/core/index.js'
import { ennoModule } from '../../../src/dsh/modules/enno.js'
import { DshToolPolicy } from '../../../src/dsh/tool-policy.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()

test('default intake: root, DSH, core and configured-module exports agree without activation', () => {
  assert.equal(publicPlugin.Config, dshPlugin.Config)
  for (const schema of [publicPlugin.Config, dshPlugin.Config, CoreConfig,
    createConfiguredPlugin([]).Config, createConfiguredPlugin([{ module: ennoModule }]).Config]) {
    assert.equal(schema.parse({}).intakeMode, 'on-demand')
    assert.equal(schema.parse({ enabled: true }).intakeMode, 'on-demand')
    assert.equal(schema.parse({ intakeMode: undefined }).intakeMode, 'on-demand')
    assert.equal(schema.parse({ intakeMode: 'eager' }).intakeMode, 'eager')
    assert.equal(schema.parse({ intakeMode: 'on-demand' }).intakeMode, 'on-demand')
    assert.throws(() => schema.parse({ intakeMode: 'automatic' }))
    assert.throws(() => schema.parse({ intakeMode: null }))
  }
})

test('default intake: saved configurations missing the new field preserve all unrelated choices', () => {
  const saved = JSON.parse('{"enabled":true,"lisp":{"enabled":false},"orca":{"enabled":false},"typedDecisions":{"mode":"off"},"memoryReuse":{"mode":"off"},"memoryRetrieval":{"mode":"off"},"modelAutoMode":{"mode":"off"}}')
  assert.equal(Object.hasOwn(saved, 'intakeMode'), false)
  const parsed = dshPlugin.Config.parse(saved)
  assert.equal(parsed.intakeMode, 'on-demand')
  assert.equal(parsed.lisp.enabled, false)
  assert.equal(parsed.orca.enabled, false)
  assert.equal(parsed.typedDecisions.mode, 'off')
  assert.equal(parsed.memoryReuse.mode, 'off')
  assert.equal(parsed.memoryRetrieval.mode, 'off')
  assert.equal(parsed.modelAutoMode.mode, 'off')
  assert.equal(Object.hasOwn(saved, 'intakeMode'), false, 'loading does not rewrite the user-supplied configuration')
  const optedOut = JSON.parse(JSON.stringify({ ...saved, intakeMode: 'eager' }))
  assert.equal(dshPlugin.Config.parse(optedOut).intakeMode, 'eager')
})

test('default intake: the shipped bundle resolves the same default without a hidden activation flag', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
  const patches = YAML.parse(await readFile(join(process.cwd(), manifest.dsh.bundle.patch), 'utf8')) as any[]
  const row = patches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'kiokuko-dsh')
  assert.ok(row)
  assert.equal(dshPlugin.Config.parse(row.config).intakeMode, 'on-demand')
  const oldSavedRow = structuredClone(row.config)
  delete oldSavedRow.intakeMode
  assert.equal(dshPlugin.Config.parse(oldSavedRow).intakeMode, 'on-demand')
  assert.equal(dshPlugin.Config.parse({ ...oldSavedRow, intakeMode: 'eager' }).intakeMode, 'eager')
})

test('default intake: an explicit prompt-only host still deploys its Skill provider without execution capabilities', async t => {
  const ctx = new Context()
  let mounted = 0, released = 0
  const host = ctx.plugin({ name: 'default-prompt-only-host', apply(context: Context) {
    return context.provide('kiokukoDsh', { skills: { registerProvider() { mounted++; return () => { released++ } } } })
  } })
  await host
  t.after(() => host.dispose())
  const plugin = ctx.plugin(dshPlugin, {})
  t.after(() => plugin.dispose())
  await plugin
  assert.equal(mounted, 1, 'a host with no execution ingress does not need an execution-intake adapter')
  await plugin.dispose()
  assert.equal(released, 1)
})

test('default intake: unsupported custom execution hosts fail explicitly and eager remains a deliberate opt-out', async t => {
  let registered = 0
  const host = {
    tools: { register() { registered++; return () => { registered-- } }, guard() { return () => {} } },
    toolHost: { bind: () => undefined, execute: async () => ({}) },
    toolPolicy: new DshToolPolicy({ phase: 'normal', runId: 'fixture-run', workspace: 'fixture-workspace', orchestrationId: 'fixture-orchestration', revision: 1, routeEpoch: 0 }),
  }
  // Use the real public apply entry, with a minimal effect owner so its rejection
  // is observable without Cordis deliberately containing a failed plugin fiber.
  const cleanups: Array<() => unknown> = []
  const ctx = new Context()
  ctx.provide('kiokukoDsh', host)
  const effectOwner = Object.create(ctx) as Context
  Object.defineProperty(effectOwner, 'effect', { value: async (setup: () => Promise<unknown>) => {
    const cleanup = await setup()
    if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
    return cleanup
  } })
  t.mock.method(console, 'error', () => {})
  await assert.rejects(publicPlugin.apply(effectOwner, {}), /(?:custom|explicit).*host.*(?:on-demand|onDemandIntake)/iu)
  assert.equal(registered, 0, 'unsupported execution hosts are not silently mounted on the eager path')
  await publicPlugin.apply(effectOwner, { intakeMode: 'eager' })
  assert.ok(registered > 0, 'explicit legacy behavior still mounts the custom host tools')
  for (const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(registered, 0)
})

test('default intake: a history-only native adapter retains export access without execution services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-default-history-'))
  const ctx = new Context()
  ctx.provide('sessions', { get: () => undefined, flush: async () => {} })
  let adapter: ReturnType<typeof createDshHostAdapter> | undefined
  try {
    adapter = createDshHostAdapter(ctx, {
      repositoryRoot: directory, databasePath: join(directory, 'memory.sqlite3'), orca: { enabled: false },
      sessionQuery: { async readSession() { throw new Error('No historical ID was requested by this construction test') } },
    })
    assert.ok(adapter.host.sessionExport, 'no-tool history clients retain their existing read/export API')
    assert.equal(ctx.get('tools', false), undefined)
    assert.equal(ctx.get('agents', false), undefined)
  } finally { await adapter?.dispose(); await rm(directory, { recursive: true, force: true }) }
})
