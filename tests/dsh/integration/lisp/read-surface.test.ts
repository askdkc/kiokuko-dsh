import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, type LispOwner } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { resolveProjectWorkspace } from '../../../../src/memory/workspaces.js'
import { recordEntry } from '../../../../src/memory/entries.js'
import { CoreTasks } from '../../../../src/dsh/core/tasks.js'
import { mountMemoryApplication } from '../../../../src/dsh/memory-application.js'
import { memoryApplicationStatus } from '../../../../src/memory/application.js'
import { LISP_ASSEMBLY_SERVICE } from '../../../../src/dsh/lisp/request-surface.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
for (const placement of ['global', 'agent', 'preset', 'mixed', 'restricted-preset'] as const) test(`Lisp preserves native reads and Skill loading (${placement} tools) without granting mutations`, {
  skip: packages ? false : 'requires pinned native DSH', timeout: 15000,
}, async t => {
  const [cordis, prompt, tools, scope, fsTools, skillTools] = await Promise.all(
    ['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-tool-fs', 'dsh-tool-skill']
      .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-reads-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  migrateDatabase(db)
  await mkdir(join(base, '.git'))
  await writeFile(join(base, 'PLAN.md'), 'PLAN fixture')
  const runtime = { withDatabase: async (fn: (db: NodeSqliteAdapter) => unknown) => fn(db) } as unknown as DshRuntime
  const project = (await resolveProjectWorkspace(db, base))!
  recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'code migration expectations',
    body: 'Review code migration expectations against current sources.', createdBy: 'fixture' })
  const tasks = new CoreTasks(runtime)
  const task = await tasks.prepare({ requestId: 'review-request', sessionId: 'parent', turn: 1,
    task: 'Review code migration expectations', cwd: base,
    capabilities: ['kiokuko-soul', 'memory-reasoning'].map(name => ({ kind: 'skill', name })),
    profileHints: { taskType: 'review', target: 'code migration expectations', expected: 'Review current code', constraints: 'Read-only' },
    signal: new AbortController().signal })
  const identity = { runId: task.runId, workspace: task.workspace, sessionId: task.sessionId, repositoryRoot: base }
  const status = () => memoryApplicationStatus(db, task.runId)
  const ctx = new cordis.Context(), fibers: any[] = [], scopes: any[] = [], commands = new Map<string, any>()
  const parent: any = { id: 'parent', session: { id: 'parent', header: { cwd: base } } }
  const child: any = { id: 'child', session: { id: 'child', header: { cwd: base, parentSession: 'parent' } } }
  const agents = new Map([parent, child].map(agent => [agent.id, agent]))
  const skill = { name: 'kiokuko-single-purpose-functions', provider: 'fixture', description: 'code contract', content: 'Fixture Skill body',
    invocation: { modelInvocable: true, userInvocable: true } }
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined, disposeMemory: (() => void) | undefined, reads = 0, mutations = 0
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
    const removeObservation = toolContext.get('tools').register(define('observation_read', async () => ({ text: 'old handle original' })))
    toolContext.get('tools').register(define('bash', async () => ++mutations))
    if (placement === 'restricted-preset') parent.ctx.get('tools').restrict({ deny: ['grep'] })
    disposeMemory = mountMemoryApplication(ctx, { runtime,
      resolve: execution => execution.agent === parent ? identity : undefined,
      refresh: async (_execution, query) => tasks.refresh(task, query, new AbortController().signal) })
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true }))
    t.mock.method(surface.manager, 'enable', async (owner: LispOwner) => {
      await new LispStore(fn => runtime.withDatabase(fn)).enable(owner)
      surface!.manager.enabled.set(owner.sessionId, owner.root)
      return { state: 'READY' }
    })
    const command = (rawInput: string) => commands.get('kioku-lisp').handler({ rawInput, agent: parent, signal: new AbortController().signal })
    assert.equal((await command('enable')).kind, 'success')
    const pending = status()
    assert.equal(pending.ready, false)
    // A first call can already be queued when Lisp replaces the model surface.
    const firstRead = await call('read', { file_path: 'skills/one-shot-software-completion/SKILL.md' })
    assert.equal(firstRead.isError, false, JSON.stringify(firstRead))
    const admittedReads = placement === 'restricted-preset' ? ['read', 'glob', 'skill', 'observation_read'] : ['read', 'glob', 'grep', 'skill', 'observation_read']
    for (const name of admittedReads) assert.ok(ctx.tools.schemas(parent).some((s: any) => s.name === name), name)
    const projected = ctx.get(LISP_ASSEMBLY_SERVICE).project(parent, { sections: [], variables: {}, tools: [] })
    assert.ok(projected.tools.some((s: any) => s.name === 'task_memory_review'), 'memory recovery must reach the model in Lisp mode')
    assert.equal((await call('lisp_status')).isError, false, 'host diagnostics remain available before memory review')
    const unresolved = await call('task_memory_review', { action: 'status' })
    assert.equal(unresolved.isError, false, JSON.stringify(unresolved))
    assert.equal(unresolved.value.pending[0].problem, 'decision_missing')
    assert.match(JSON.stringify(await call('lisp_eval', { operationId: 'unreviewed', code: '(+ 1 2)' })), /resolve memory decisions/)
    if (placement === 'restricted-preset') {
      assert.equal(ctx.tools.schemas(parent).some((s: any) => s.name === 'grep'), false)
      assert.equal((await call('grep')).isError, true, 'pre-existing restrictions must remain effective')
    }
    for (const nested of [false, true]) {
      const result = await call('read', { file_path: 'PLAN.md' }, parent, nested)
      assert.equal(result.isError, false, JSON.stringify(result)); assert.match(JSON.stringify(result), /PLAN fixture/)
      assert.equal((await call('observation_read', { handle: 'old-handle' }, parent, nested)).isError, false)
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
    assert.deepEqual(status(), pending, 'reads and diagnostics cannot satisfy or invalidate memory decisions')
    for (const item of unresolved.value.pending) {
      const reviewed = await call('task_memory_review', { action: 'review', review: {
        generation: unresolved.value.generation, entryId: item.entryId, entryRevision: item.revision,
        expectedRevision: item.reviewRevision, decision: 'not_applicable', paths: ['PLAN.md'],
        basis: 'PLAN.md contains only a fixed fixture; this task does not review migration code.' } })
      assert.equal(reviewed.isError, false, JSON.stringify(reviewed))
    }
    assert.equal(status().ready, true, 'the real review tool resolves the pending decision')
    let evaluations = 0
    t.mock.method(surface.manager, 'execute', async () => { evaluations++; return { ok: true, state: 'SUCCEEDED', value: 3 } })
    const evaluated = await call('lisp_eval', { operationId: 'reviewed', code: '(+ 1 2)' })
    assert.equal(evaluated.isError, false, JSON.stringify(evaluated))
    assert.equal(evaluated.value.ok, true, JSON.stringify(evaluated))
    assert.equal(evaluations, 1)
    for (const [agent, nested] of [[child, false], [parent, true]] as const) {
      assert.equal((await call('task_memory_review', { action: 'status' }, agent, nested)).isError, true,
        'child or nested calls cannot borrow the parent memory binding')
    }
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    for (const agent of [parent, child]) for (const nested of [false, true]) {
      for (const [name, args] of [['bash', {}], ['write', { file_path: 'keep.txt', content: 'replace' }],
        ['edit', { file_path: 'keep.txt', old_string: 'keep', new_string: 'replace' }]] as const) {
        assert.equal((await call(name, args, agent, nested)).isError, true, `${name} must remain blocked`)
      }
    }
    assert.equal((await call('read', { file_path: 'PLAN.md' }, child)).isError, true)
    if (placement === 'agent') { removeObservation(); await readPlugin.dispose(); await skillPlugin.dispose() }
    for (const name of ['read', 'skill', 'observation_read', 'task_memory_review']) {
      const undo = parent.ctx.get('tools').register(define(name, async () => ++mutations))
      assert.equal((await call(name)).isError, true, 'same-name replacements must not inherit permission')
      undo()
    }
    assert.equal(mutations, 0)
    surface.stop(); await surface.dispose()
    assert.equal((await call('read', { file_path: 'PLAN.md' })).isError, true, 'unload retains the fence')
    assert.equal((await call('task_memory_review', { action: 'status' })).isError, true, 'unload retains the control fence')
  } finally {
    surface?.stop(); await surface?.dispose()
    disposeMemory?.()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    for (const local of scopes.reverse()) await local.dispose()
    db.close(); await rm(base, { recursive: true, force: true })
  }
})
