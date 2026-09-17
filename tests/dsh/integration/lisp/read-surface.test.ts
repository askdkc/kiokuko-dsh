import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
for (const placement of ['global', 'agent', 'preset', 'mixed', 'restricted-preset'] as const) test(`Lisp preserves native reads and Skill loading (${placement} tools) without granting mutations`, {
  skip: packages ? false : 'requires pinned native DSH', timeout: 15000,
}, async t => {
  const [cordis, prompt, tools, scope, fsTools, skillTools] = await Promise.all(
    ['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-tool-fs', 'dsh-tool-skill']
      .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-reads-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], scopes: any[] = [], commands = new Map<string, any>()
  const parent: any = { id: 'parent', session: { id: 'parent', header: { cwd: base } } }
  const child: any = { id: 'child', session: { id: 'child', header: { cwd: base, parentSession: 'parent' } } }
  const agents = new Map([parent, child].map(agent => [agent.id, agent]))
  const skill = { name: 'kiokuko-single-purpose-functions', provider: 'fixture', description: 'code contract', content: 'Fixture Skill body',
    invocation: { modelInvocable: true, userInvocable: true } }
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, reads = 0, mutations = 0
  const call = (name: string, args = {}, agent = parent, nested = false) => ctx.tools.execute({
    callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal,
    ...(nested ? { parent: Symbol('nested-read'), rootCallId: 'root' } : {}),
  })
  try {
    fibers.push(await ctx.plugin(prompt.default, {}), await ctx.plugin(tools.default, { mode: 'native' }))
    fibers.push(await ctx.plugin({ name: 'read-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => agents.get(id) })
      c.provide('sessions', { get: (id: string) => agents.get(id)?.session })
      c.provide('commands', { register: (d: any) => { commands.set(d.name, d); return () => commands.delete(d.name) } })
      c.provide('skills', { list: async () => [skill], get: async () => skill })
      c.provide('fs', {
        resolve: async (path: string) => ({ displayPath: path }),
        stat: async () => ({ type: 'file', size: 10, version: 'fixture-v1' }),
        readText: async () => { reads++; return 'PLAN fixture' },
        writeText: async () => { mutations++; throw new Error('must not write') },
        editText: async () => { mutations++; throw new Error('must not edit') },
      })
    } }))
    const preset = { agentPreset: 'fixture' }
    const presetScope = scope.createScope(ctx, preset)
    scopes.push(presetScope)
    const inheritsPreset = ['preset', 'mixed', 'restricted-preset'].includes(placement)
    for (const agent of [parent, child]) {
      const local = scope.createScope(ctx, agent, agent === child ? { parent } : inheritsPreset ? { parent: preset } : undefined)
      scopes.push(local); agent.ctx = local.ctx
    }
    const toolContext = placement === 'global' ? ctx : inheritsPreset ? presetScope.ctx : parent.ctx
    const readPlugin = await toolContext.plugin(fsTools, {}), skillPlugin = await toolContext.plugin(skillTools, {})
    fibers.push(readPlugin, skillPlugin)
    const define = (name: string, execute: () => Promise<unknown>) => tools.defineTool({ name, description: 'fixture', parameters: {},
      output: { schema: { type: 'json' }, render: () => [] }, execute })
    const searchContext = placement === 'mixed' ? parent.ctx : toolContext
    for (const name of ['glob', 'grep']) searchContext.get('tools').register(define(name, async () => ['PLAN.md']))
    toolContext.get('tools').register(define('bash', async () => ++mutations))
    if (placement === 'restricted-preset') parent.ctx.get('tools').restrict({ deny: ['grep'] })
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true }))
    t.mock.method(surface.manager, 'enable', async (owner: LispOwner) => {
      surface!.manager.enabled.set(owner.sessionId, owner.root)
      return { state: 'READY' }
    })
    const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent: parent, signal: new AbortController().signal })
    assert.equal((await command('enable')).kind, 'success')
    // A first call can already be queued when Lisp replaces the model surface.
    const firstRead = await call('read', { file_path: 'skills/one-shot-software-completion/SKILL.md' })
    assert.equal(firstRead.isError, false, JSON.stringify(firstRead))
    const admittedReads = placement === 'restricted-preset' ? ['read', 'glob', 'skill'] : ['read', 'glob', 'grep', 'skill']
    for (const name of admittedReads) assert.ok(ctx.tools.schemas(parent).some((s: any) => s.name === name), name)
    if (placement === 'restricted-preset') {
      assert.equal(ctx.tools.schemas(parent).some((s: any) => s.name === 'grep'), false)
      assert.equal((await call('grep')).isError, true, 'pre-existing restrictions must remain effective')
    }
    for (const nested of [false, true]) {
      const result = await call('read', { file_path: 'PLAN.md' }, parent, nested)
      assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result), /PLAN fixture/)
      const loaded = await call('skill', { name: skill.name }, parent, nested)
      assert.equal(loaded.isError, false, JSON.stringify(loaded)); assert.match(JSON.stringify(loaded), /Fixture Skill body/)
    }
    for (const name of admittedReads.filter(name => name === 'glob' || name === 'grep')) assert.equal((await call(name)).isError, false)
    assert.equal((await call('skill', { name: 'unknown-skill' })).isError, true)
    const removeDenial = ctx.tools.guard((exec: any) => exec.name === 'read' ? 'NATIVE_READ_DENIED' : undefined)
    const before = reads
    assert.match(JSON.stringify(await call('read', { file_path: 'private.txt' })), /NATIVE_READ_DENIED/)
    assert.equal(reads, before, 'native denial must prevent filesystem access')
    removeDenial()
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    for (const agent of [parent, child]) for (const nested of [false, true]) {
      for (const [name, args] of [['bash', {}], ['write', { file_path: 'keep.txt', content: 'replace' }],
        ['edit', { file_path: 'keep.txt', old_string: 'keep', new_string: 'replace' }]] as const) {
        assert.equal((await call(name, args, agent, nested)).isError, true, `${name} must remain blocked`)
      }
    }
    assert.equal((await call('read', { file_path: 'PLAN.md' }, child)).isError, true)
    if (placement === 'agent') { await readPlugin.dispose(); await skillPlugin.dispose() }
    for (const name of ['read', 'skill']) {
      const undo = parent.ctx.get('tools').register(define(name, async () => ++mutations))
      assert.equal((await call(name)).isError, true, 'same-name replacements must not inherit permission')
      undo()
    }
    assert.equal(mutations, 0)
    surface.stop(); await surface.dispose()
    assert.equal((await call('read', { file_path: 'PLAN.md' })).isError, true, 'unload retains the fence')
  } finally {
    surface?.stop(); await surface?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    for (const local of scopes.reverse()) await local.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})
