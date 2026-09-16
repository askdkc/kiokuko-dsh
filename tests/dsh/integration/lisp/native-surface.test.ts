import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('real DSH registry: session tools, nested/child/late-tool denial, unload fence and safe disable', {
  skip: !packages || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires pinned native DSH and protected SBCL' : false, timeout: 120000,
}, async () => {
  const [cordis, prompt, tools, scope, questions] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-user-questions']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ls-'))), workspace = join(base, 'work')
  await mkdir(workspace)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], scopes: any[] = [], commands = new Map<string, any>()
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, effects = 0, failRegistration = false
  const parent: any = { id: 'parent', session: { id: 'parent', header: { cwd: workspace } } }
  const child: any = { id: 'child', session: { id: 'child', header: { cwd: workspace, parentSession: 'parent' } } }
  const outsider: any = { id: 'outsider', session: { id: 'outsider', header: { cwd: workspace } } }
  const agentMap = new Map([parent, child, outsider].map(agent => [agent.id, agent]))
  const config = LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 })
  const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent: parent, signal: new AbortController().signal })
  const call = (name: string, agent = parent, nested = false, args = {}) => ctx.tools.execute({ callId: `call-${randomUUID()}`, name, arguments: args, agent,
    signal: new AbortController().signal, ...(nested ? { parent: Symbol('parent'), rootCallId: 'root' } : {}) })
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); fibers.push(await ctx.plugin(tools.default, { mode: 'native' }))
    fibers.push(await ctx.plugin({ name: 'lisp-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => agentMap.get(id), roots: () => [parent, outsider] })
      c.provide('sessions', { get: (id: string) => agentMap.get(id)?.session })
      c.provide('commands', { register: (d: any) => { if (failRegistration) throw new Error('fixture registration unavailable'); commands.set(d.name, d); return () => commands.delete(d.name) } })
    } }))
    fibers.push(await ctx.plugin(questions.default, {}))
    for (const agent of [parent, child, outsider]) { const s = scope.createScope(ctx, agent, agent === child ? { parent } : undefined); scopes.push(s); agent.ctx = s.ctx }
    let asked = 0
    parent.ctx.on('user-questions/request', async (request: any) => {
      assert.equal(request.agent, parent); asked++
      return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }] }
    })
    const define = (name: string) => tools.defineTool({ name, description: 'effect counter', parameters: {}, output: { schema: { type: 'integer' }, render: () => [] }, execute: async () => ++effects })
    ctx.tools.register(define('fixture_write'))
    assert.equal((await call('fixture_write')).isError, false)
    surface = await mountLispSurface(ctx, runtime, config)
    const enabled = await command('enable'); assert.equal(enabled.kind, 'success', enabled.text)
    const computed = await call('lisp_eval', parent, false, { operationId: 'calc', code: '(+ 10 20)' })
    assert.equal(computed.isError, false, JSON.stringify(computed)); assert.match(JSON.stringify(computed), /30/)
    await writeFile(join(workspace, 'keep.txt'), 'keep')
    const denied = await call('lisp_eval', parent, false, {operationId:'deny-delete',code:'(kioku.files:propose-delete "keep.txt")'})
    assert.equal(asked, 1, 'must reach native human question service with the actual live agent')
    assert.match(JSON.stringify(denied), /NOT_APPLIED/); assert.equal(await readFile(join(workspace,'keep.txt'),'utf8'), 'keep')
    const bridge = await call('lisp_eval', parent, false, { operationId: 'bridge', code: '(kioku.tools:call-tool "lisp_status")' })
    assert.equal(bridge.isError, false); assert.match(JSON.stringify(bridge), /EVALUATING/)
    const cycle = await call('lisp_eval', parent, false, { operationId: 'cycle', code: '(kioku.tools:call-tool "lisp_eval")' })
    assert.equal(cycle.isError, false); assert.match(JSON.stringify(cycle), /false/)
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    ctx.tools.register(define('late_write'))
    for (const agent of [parent, child]) for (const name of ['fixture_write', 'late_write']) for (const nested of [false, true]) assert.equal((await call(name, agent, nested)).isError, true)
    assert.equal(effects, 1)
    assert.equal((await call('fixture_write', outsider)).isError, false)
    surface.stop(); await surface.dispose()
    assert.equal((await call('fixture_write')).isError, true, 'unload must not reopen unrestricted execution')
    failRegistration = true
    await assert.rejects(mountLispSurface(ctx, runtime, config), /fixture registration unavailable/)
    failRegistration = false
    surface = await mountLispSurface(ctx, runtime, config)
    assert.match((await command('status')).text, /RECOVERY_REQUIRED/)
    assert.equal((await call('fixture_write')).isError, true)
    assert.equal((await command('recover')).kind, 'success')
    assert.equal((await command('disable')).kind, 'success')
    assert.equal((await call('fixture_write')).isError, false, 'human disable restores native tools only after confirmed stop')
  } finally {
    surface?.stop(); await surface?.dispose()
    for (const s of scopes.reverse()) await s.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close()
  }
})
