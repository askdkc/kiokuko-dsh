import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('enabled development Lisp routes shell execution through Lisp until explicitly disabled', {
  skip: packages ? false : 'requires native DSH', timeout: 30000,
}, async () => {
  const load = (name: string) => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope'].map(load))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lisp-shell-routing-')))
  const db = new NodeSqliteAdapter(join(root, 'state.db'), new DatabaseSync(join(root, 'state.db')))
  migrateDatabase(db)
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string, any>()
  const agent: any = { id: 'selected', session: { id: 'selected', header: { cwd: root }, snapshotEvents: () => [] } }
  const other: any = { id: 'ordinary', session: { id: 'ordinary', header: { cwd: root } } }
  const agents = new Map([[agent.id, agent], [other.id, other]])
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, local: any, otherLocal: any, shellEffects = 0
  const call = (name: string, target = agent, nested = false) => executeNativeTool(ctx, packages!, {
    name, callId: `call-${shellEffects}`, arguments: {}, agent: target, signal: new AbortController().signal,
    ...(nested ? { parent: Symbol('untrusted-child') } : {}),
  })
  try {
    fibers.push(await ctx.plugin(prompt.default, {}))
    await mountNativeTools(ctx, tools, packages!, fibers)
    fibers.push(await ctx.plugin({ name: 'routing-host', apply(c: any) {
      c.provide('agents', { get: (id: string) => agents.get(id) })
      c.provide('sessions', { get: (id: string) => agents.get(id)?.session })
      c.provide('commands', { register(d: any) { commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    for (const name of ['bash', 'zsh', 'pwsh']) ctx.tools.register({ name, description: name, parameters: {},
      output: { schema: {}, render: () => [] }, execute: () => ++shellEffects })
    ctx.tools.register({ name: 'read', description: 'read', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => 'contents' })
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    otherLocal = scope.createScope(ctx, other); other.ctx = otherLocal.ctx
    const mount = () => mountLispSurface(ctx, { withDatabase: async (fn: any) => fn(db) } as any, LispConfig.parse({ enabled: true }))
    surface = await mount()
    const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent, signal: new AbortController().signal })
    assert.equal((await call('bash')).isError, false)
    assert.equal((await command('enable-task')).kind, 'success')
    for (const name of ['bash', 'zsh', 'pwsh']) for (const nested of [false, true]) {
      const result = await call(name, agent, nested)
      assert.equal(result.isError, true, `${name} must not bypass the selected Lisp route`)
      assert.match(JSON.stringify(result), /LISP_ROUTE_REQUIRED/)
    }
    assert.equal(shellEffects, 1, 'rejected shell calls must have no effects')
    assert.equal((await call('read')).isError, false)
    assert.equal((await call('lisp_status')).isError, false)
    assert.equal((await call('bash', other)).isError, false, 'another session keeps its own route')
    surface.stop(); await surface.dispose()
    assert.equal((await call('bash')).isError, true, 'unload must not silently change the selected route')
    surface = await mount()
    assert.equal((await call('bash')).isError, true, 'restored enabled sessions retain their route')
    assert.equal((await command('disable')).kind, 'success')
    assert.equal((await call('bash')).isError, false)
    assert.equal(shellEffects, 3)
  } finally {
    surface?.stop(); await surface?.dispose(); await otherLocal?.dispose(); await local?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
  }
})
