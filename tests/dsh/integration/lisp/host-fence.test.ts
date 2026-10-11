import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, LISP_TOOLS, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../../../../src/dsh/lisp/coding-choice.js'
import { mountLispSurface as sourceSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

const mountLispSurface: typeof sourceSurface = process.env.KIOKUKO_LISP_FENCE_ENTRY
  ? (await import(pathToFileURL(process.env.KIOKUKO_LISP_FENCE_ENTRY).href)).mountLispSurface : sourceSurface

for (const outcome of ['ready', 'startup-failure', 'disabled-config'] as const) test(`host-mediated Lisp fence: ${outcome}`, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-host-fence-')))
  const path = join(base, 'db.sqlite3')
  const db = new NodeSqliteAdapter(path, new DatabaseSync(path))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new Context(), definitions = new Map<string, any>(), commands = new Map<string, any>()
  const tools = {
    guard: () => { throw new Error('plugin root effects are forbidden') },
    presentAs: () => () => {}, restrict: () => () => {},
    register: (definition: any) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    get: (name: string) => definitions.get(name), execute: async () => {},
  }
  const agent = { id: 'agent', session: { id: 'session', header: { cwd: base } },
    ctx: { get: (name: string) => name === 'tools' ? tools : undefined } }
  const child = { id: 'child-agent', session: { id: 'child-session', header: { cwd: base, parentSession: agent.session.id } }, ctx: agent.ctx }
  const agents = new Map([[agent.id, agent], [child.id, child]])
  const sessions = new Map([[agent.session.id, agent.session], [child.session.id, child.session]])
  const protectedSessions = new Set<string>()
  let request: any, attaches = 0, asked = 0
  const services = ctx.plugin({ name: 'host-fence-services', apply(c) {
    c.provide('tools', tools)
    c.provide('agents', { get: (id: string) => agents.get(id) })
    c.provide('sessions', { get: (id: string) => sessions.get(id) })
    c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
    c.provide('executionFences', { attach(input: any) {
      attaches++; request = input
      return { protect(id: string) { protectedSessions.add(id) }, release(id: string) { protectedSessions.delete(id) } }
    } })
    c.provide('userQuestions', { ask: async (input: any) => {
      asked++
      assert.equal(protectedSessions.size, 0, 'answer precedes mode protection')
      return { answers: [{ id: input.questions[0].id, selected: ['Lispモードを使う（通常実行）'] }] }
    } })
  } })
  await services
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined
  try {
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ executionMode: 'protected', enabled: outcome !== 'disabled-config', sbclPath: join(base, 'missing-sbcl') }))
    assert.equal(attaches, 1)
    assert.deepEqual(request.tools, LISP_TOOLS)
    for (const name of ['lsp', 'lsp_extra']) assert.ok(!request.tools.includes(name), `${name} is not a Lisp-owned tool`)
    const invocation = { rawInput: 'enable', agent, signal: new AbortController().signal }
    if (outcome === 'disabled-config') {
      assert.equal((await commands.get('kioku-lisp').handler(invocation)).kind, 'error')
      assert.equal(protectedSessions.size, 0, 'failure before admission releases temporary protection')
      return
    }
    if (outcome === 'ready') t.mock.method(surface.manager, 'enable', async (owner: LispOwner) => {
      assert.ok(protectedSessions.has(owner.sessionId), 'protection precedes worker startup')
      assert.equal(typeof request.check({ name: 'bash', agent }), 'string', 'startup cannot admit native effects')
      surface!.manager.enabled.set(owner.sessionId, owner.root)
      return { state: 'READY' }
    })
    const service = ctx.get(LISP_CODING_SERVICE) as LispCodingService
    const input = { agent, turn: 1, task: 'Implement src/index.ts', taskType: 'build' as const, signal: invocation.signal }
    if (outcome === 'startup-failure') await assert.rejects(service.prepare(input), /SBCL|sbcl|ENOENT/u)
    else await service.prepare(input)
    assert.equal(asked, 1)
    assert.ok(protectedSessions.has(agent.session.id))
    assert.equal(request.check({ name: 'lisp_status', agent }), undefined)
    assert.equal(typeof request.check({ name: 'bash', agent }), 'string')
    for (const name of ['lsp', 'lsp_extra']) {
      assert.equal(typeof request.check({ name, agent }), 'string', `${name} cannot bypass the code bridge`)
      assert.equal(typeof request.check({ name, agent: child }), 'string', `${name} cannot bypass parent protection through a child`)
    }
    assert.equal(typeof request.check({ name: 'lisp_status', agent: child }), 'string', 'a child cannot reuse parent Lisp admission')
    assert.equal(await request.beforeStep(child), false)
    assert.equal((await commands.get('kioku-lisp').handler({ ...invocation, rawInput: 'disable' })).kind, 'success')
    assert.equal(protectedSessions.size, 0, 'successful disable explicitly releases protection')
    await commands.get('kioku-lisp').handler(invocation)
    assert.ok(protectedSessions.has(agent.session.id))
    surface.stop()
    assert.ok(protectedSessions.has(agent.session.id), 'stop never releases protection')
    assert.equal(typeof request.check({ name: 'bash', agent }), 'string')
    for (const caller of [agent, child]) for (const name of ['lsp', 'lsp_extra'])
      assert.equal(typeof request.check({ name, agent: caller }), 'string', `${name} remains denied after stop`)
    assert.equal(await request.beforeStep(agent), false)
  } finally {
    surface?.stop(); await surface?.dispose()
    await services.dispose(); db.close()
    await rm(base, { recursive: true, force: true })
  }
})
