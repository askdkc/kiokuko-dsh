import { mountNativeTools, executeNativeTool } from '../../helpers/native-tools.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { mountLispSurface as sourceSurface } from '../../../../src/dsh/lisp/surface.js'
import { LISP_ASSEMBLY_SERVICE } from '../../../../src/dsh/lisp/request-surface.js'
import { nativeMock } from '../../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (!packages && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Native Plan acceptance requires a DSH fixture')
const mountLispSurface: typeof sourceSurface = process.env.KIOKUKO_LISP_PLAN_ENTRY
  ? (await import(pathToFileURL(process.env.KIOKUKO_LISP_PLAN_ENTRY).href)).mountLispSurface : sourceSurface

for (const mode of ['persistent', 'task'] as const) test(`Lisp ${mode}: native questions and Plan review preserve protected effects`, {
  skip: packages ? false : 'requires pinned native DSH', timeout: 30000,
}, async t => {
  const names = ['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'commands', 'user-questions', 'tool-ask-user', 'plan-mode']
  const [cordis, llm, session, projections, prompt, tools, agents, loop, commands, questions, ask, plan] = await Promise.all(names.map(name =>
    import(pathToFileURL(join(packages!, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lisp-plan-')))
  const db = new NodeSqliteAdapter(join(root, 'state.sqlite3'), new DatabaseSync(join(root, 'state.sqlite3')))
  migrateDatabase(db)
  const runtime: any = { withDatabase: async (fn: any) => fn(db) }
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  let surface: Awaited<ReturnType<typeof mountLispSurface>> | undefined
  const handles: any[] = []
  try {
    for (const [plugin, config] of [[llm.default], [session.default], [projections.default], [prompt.default, { persona: '' }], [tools.default], [agents.default], [commands.default], [loop.default, { agents: [] }], [questions.default], [ask], [plan.default, { section: 'Use exit_plan_mode to submit the complete plan.' }]] as any[]) {
      if (plugin === tools.default) { await mountNativeTools(ctx, tools, packages!, fibers); continue }
      const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber
    }
    const responses: any[] = [mock.textResponse('Plan ready')], model = new mock.MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], model)
    const handle = await ctx.agents.create({ sessionId: session.SessionId('plan-parent'), agentOptions: { provider: 'mock', model: 'qwen3-coder' }, meta: { cwd: root } }); handles.push(handle)
    const agent = handle.agent
    let effects = 0
    ctx.tools.register({ name: 'bash', description: 'forbidden effect', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++effects })
    const call = async (name: string, args: any = {}, signal = new AbortController().signal) => {
      // Current DSH conditionally admits Plan tools at step preparation. Use its
      // real selection rather than pretending an out-of-step call is admitted.
      const toolSet = typeof ctx.tools.resolve === 'function' ? await ctx.tools.resolve({
        agent, modelSelection: { provider: 'mock', model: 'qwen3-coder' }, signal: new AbortController().signal,
      }) : undefined
      try { return await executeNativeTool(ctx, packages!, { name, arguments: args, callId: randomUUID(), agent, signal, toolSet }) }
      finally { toolSet?.dispose() }
    }
    assert.equal((await call('exit_plan_mode', { plan: '# Test plan' })).isError, true, 'inactive Plan mode retains native rejection')
    assert.equal((await call('bash')).isError, false, 'Lisp disabled preserves native effects')
    effects = 0
    surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ executionMode: 'protected', enabled: true }))
    if (mode === 'persistent') t.mock.method(surface.manager, 'enable', async (owner: any) => {
      await new LispStore(fn => runtime.withDatabase(fn)).enable(owner)
      surface!.manager.enabled.set(owner.sessionId, owner.root)
      return { state: 'READY' }
    })
    const enabled = (await ctx.commands.execute(agent, `/kioku-lisp ${mode === 'task' ? 'enable-task' : 'enable'}`, [], new AbortController().signal)).result
    assert.equal(enabled.kind, 'success', enabled.text)
    ctx.planMode.set(agent, true)
    for (const name of ['exit_plan_mode', 'ask_user_question']) {
      assert.ok(ctx.tools.schemas(agent).some((s: any) => s.name === name), name)
      assert.ok((await ctx.get(LISP_ASSEMBLY_SERVICE).project(agent, { sections: [], variables: {}, tools: ctx.tools.schemas(agent) })).tools.some((s: any) => s.name === name), 'request projection retains ' + name)
    }
    const childHandle = await ctx.agents.create({ sessionId: session.SessionId('plan-child'), agentOptions: { provider: 'mock', model: 'qwen3-coder' }, meta: { cwd: root, parentSession: agent.session.id } }); handles.push(childHandle)
    const child = childHandle.agent
    for (const name of ['exit_plan_mode', 'ask_user_question']) {
      const blocked = await executeNativeTool(ctx, packages!, { name, arguments: {}, callId: randomUUID(), agent: child, signal: new AbortController().signal })
      assert.equal(blocked.isError, true, 'child cannot borrow the parent control surface')
    }
    ctx.planMode.set(agent, true)
    if (mode === 'persistent') t.mock.method(surface.manager, 'prepare', async () => ({ state: 'READY', generation: 'fixture' }))
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Prepare the plan.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.equal(model.requests.length, 1)
    for (const name of ['exit_plan_mode', 'ask_user_question']) assert.ok(model.requests[0].tools.some((s: any) => s.name === name), 'final model request retains ' + name)
    let choice = 'Keep planning', requests: any[] = []
    const answerer = agent.ctx.on('user-questions/request', async (request: any) => {
      requests.push(request)
      return { answers: request.questions.map((q: any) => ({ id: q.id, selected: [q.intent ? choice : 'Yes'] })) }
    })
    assert.equal((await call('ask_user_question', { questions: [{ id: 'preference', question: 'Choose?', options: [{ label: 'Yes' }] }] })).isError, false)
    assert.equal(ctx.planMode.get(agent).active, true, 'question answers do not approve a plan')
    const markdown = '# Test plan\n\nPreserve the protected effects.'
    const declined = await call('exit_plan_mode', { plan: markdown })
    assert.equal(declined.isError, true)
    assert.equal(ctx.planMode.get(agent).active, true)
    assert.equal(requests.at(-1).questions[0].detail, markdown, JSON.stringify(declined))
    assert.equal(requests.at(-1).questions[0].intent.kind, 'plan-review')
    assert.equal((await call('bash')).isError, true)
    choice = 'Approve'
    const approved = await call('exit_plan_mode', { plan: markdown })
    assert.equal(approved.isError, false, JSON.stringify(approved))
    assert.deepEqual(approved.value, { approved: true })
    responses.push(mock.textResponse('Plan approved'))
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Continue from the approved plan.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.equal(ctx.planMode.get(agent).active, false)
    assert.equal((await call('bash')).isError, true, 'Plan approval does not remove Lisp protection')
    ctx.planMode.set(agent, true)
    answerer()
    assert.equal((await call('exit_plan_mode', { plan: markdown })).isError, true, 'no answerer cannot approve')
    const cancelled = new AbortController(); cancelled.abort()
    assert.equal((await call('exit_plan_mode', { plan: markdown }, cancelled.signal)).isError, true)
    assert.equal(ctx.planMode.get(agent).active, true)
    const deny = ctx.tools.guard((execution: any) => execution.name === 'exit_plan_mode' ? 'HOST_DENIED' : undefined)
    assert.match(JSON.stringify(await call('exit_plan_mode', { plan: markdown })), /HOST_DENIED/); deny()
    for (const name of ['exit_plan_mode', 'ask_user_question']) {
      const undo = agent.ctx.get('tools').register({ name, description: 'replacement', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => ++effects })
      assert.equal((await call(name)).isError, true, 'same-name replacement cannot inherit permission'); undo()
    }
    surface.stop(); await surface.dispose()
    assert.equal((await call('exit_plan_mode', { plan: markdown })).isError, true, 'unload retains protection')
    assert.equal(effects, 0)
  } finally {
    surface?.stop(); await surface?.dispose()
    for (const handle of handles.reverse()) await handle.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
  }
})
