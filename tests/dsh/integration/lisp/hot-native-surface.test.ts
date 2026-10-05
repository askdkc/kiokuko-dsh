import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT

test('native DSH surface exposes hot tools only after task admission and preserves schema fences', {
  skip: !packages || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires pinned native DSH and protected SBCL' : false,
  timeout: 180000,
}, async () => {
  const [cordis, prompt, tools, scope, questions] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-user-questions']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-hot-native-')))
  const workspace = join(base, 'workspace'); await mkdir(workspace)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const ctx = new cordis.Context(), fibers: any[] = [], scopes: any[] = [], commands = new Map<string, any>()
  const agent: any = { id: 'hot-native-agent', session: { id: 'hot-native-session', header: { cwd: workspace } } }
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined
  try {
    fibers.push(await ctx.plugin(prompt.default, {}))
    fibers.push(await ctx.plugin(tools.default, { mode: 'native' }))
    fibers.push(await ctx.plugin(questions.default, {}))
    fibers.push(await ctx.plugin({ name: 'hot-native-fixture', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined, roots: () => [agent] })
      c.provide('sessions', { get: (id: string) => id === agent.session.id ? agent.session : undefined })
      c.provide('commands', { register: (definition: any) => { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
    } }))
    const agentScope = scope.createScope(ctx, agent); scopes.push(agentScope); agent.ctx = agentScope.ctx
    agent.ctx.on('user-questions/request', async (request: any) => {
      const question = request.questions[0]
      assert.ok(question.options?.length >= 2)
      return { answers: [{ id: question.id, selected: [question.options[1].label] }] }
    })
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }))
    assert.equal(ctx.tools.get('lisp_hot_contract', agent), undefined, 'task tools stay hidden before enable-task')
    const command = commands.get('kioku-lisp')
    assert.ok(command)
    const enabled = await command.handler({ rawInput: 'enable-task', agent, signal: new AbortController().signal })
    assert.equal(enabled.kind, 'success', enabled.text)
    const schemas = ctx.tools.schemas(agent).filter((schema: any) => schema.name.startsWith('lisp_hot_'))
    assert.deepEqual(schemas.map((schema: any) => schema.name).sort(), ['lisp_hot_call', 'lisp_hot_contract', 'lisp_hot_deactivate', 'lisp_hot_install', 'lisp_hot_status'])
    const contractSchema: any = ctx.tools.get('lisp_hot_contract', agent)
    assert.equal(contractSchema.parameters?.properties?.operationId?.type, 'string')
    assert.equal(contractSchema.parameters?.properties?.properties?.maxItems, 32)
    const call = (name: string, args: Record<string, unknown>) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent, signal: new AbortController().signal })
    const contract = await call('lisp_hot_contract', { operationId: 'native-contract', name: 'native-add-one', description: 'Native add one', inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] })
    assert.equal(contract.isError, false, JSON.stringify(contract))
    const text = contract.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
    const parsed = JSON.parse(text)
    assert.match(parsed.contractRef, /^[0-9a-f-]{36}$/u)
    const installed = await call('lisp_hot_install', { operationId: 'native-install', name: 'native-add-one', contractRef: parsed.contractRef, expectedRevision: 0, source: '(lambda (input) (+ input 1))' })
    assert.equal(installed.isError, false, JSON.stringify(installed))
    const installText = installed.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
    assert.equal(JSON.parse(installText).revision, 1)
    const status = await call('lisp_hot_status', {})
    assert.equal(status.isError, false, JSON.stringify(status))
    assert.match(status.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''), /native-add-one/u)
  } finally {
    surface?.stop(); await surface?.dispose()
    for (const local of scopes.reverse()) await local.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})
