import { mountNativeTools, mountToolExecutor, executeNativeTool } from '../helpers/native-tools.js'
/** SQLite host service and native tool dispatch; the Skill inventory is a fixture,
 * not evidence about a model provider or the full plugin startup. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { DshTaskWorkflow, TASK_OPERATION_TOOL, TaskModelOperationSchema, type TaskNativeAgent } from '../../../src/dsh/task-state-host.js'
import { taskWorkflowCommand, mountTaskWorkflowSurface } from '../../../src/dsh/task-state-surface.js'
import { createRequestIntentContext, requestIntentMessageRefs, unresolvedRequestIntent } from '../../../src/dsh/decisions/request-intent.js'
import { OnDemandIntake } from '../../../src/dsh/on-demand-intake.js'
import { captureTaskLease, authorizeTaskLease, readTaskSnapshot, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import { mountOwnedExecution, OwnedExecutionService } from '../../../src/dsh/owned-execution.js'
import { TASK_TYPES } from '../../../src/akinator/types.js'
import { z } from 'zod'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { KiokukoModelsService } from '../../../src/dsh/models/service.js'
import { ModelsConfigStore } from '../../../src/dsh/models/config-store.js'
import { CredentialFile } from '../../../src/dsh/models/vendor/credentials.js'

const signal = () => new AbortController().signal
async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'task-workflow-')))
  execFileSync('git', ['init', '--quiet', root], { stdio: ['ignore', 'pipe', 'pipe'] })
  const runtime = new DshCoreRuntime({ repositoryRoot: root, autoRegisterRepository: true, databasePath: join(root, 'state.sqlite3'),
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  await runtime.start()
  const agents = new Map<string, TaskNativeAgent>(), sessions = new Map<string, TaskNativeAgent['session']>()
  const agent = { id: 'primary', session: { id: 'primary-session', seq: 0, header: { cwd: root }, snapshotEvents: () => [] }, status: 'idle', async whenIdle() {} }
  agents.set(agent.id, agent); sessions.set(agent.session.id, agent.session)
  const changes: TaskSnapshot[] = [], waiters: Array<(task: TaskSnapshot) => void> = []
  const options = { runtime, agents, sessions, skills: { async snapshot() { return { complete: true, skills: [] } } }, tools: { schemas: () => [] },
    emit(task: TaskSnapshot) { changes.push(task); for (const waiter of [...waiters]) waiter(task) } }
  const service = new DshTaskWorkflow(options)
  const until = (predicate: (task: TaskSnapshot) => boolean) => new Promise<TaskSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(onChange), 1); reject(new Error('Task transition timed out')) }, 5000)
    const onChange = (task: TaskSnapshot) => { if (predicate(task)) { clearTimeout(timer); waiters.splice(waiters.indexOf(onChange), 1); resolve(task) } }
    waiters.push(onChange)
  })
  return { root, runtime, service, options, agent, agents, sessions, changes, until,
    async cleanup() { service.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }) } }
}

test('explicit command creates every task type in its existing ledger/intake and consumes failed operations', async () => {
  const f = await fixture(), command = taskWorkflowCommand(f.service)
  const run = (rawInput: string) => command.handler({ agent: f.agent, rawInput, signal: signal() })
  try {
    assert.equal((await f.service.snapshot(f.agent)).task, null)
    assert.equal(command.recordInput, false)
    for (const type of TASK_TYPES) {
      const created = await run(`create ${type} Verify the original request for ${type}; do not modify files.`)
      assert.equal(created.kind, 'success', created.text)
      const task = JSON.parse(created.text!) as TaskSnapshot
      assert.equal(task.state, 'ToDo'); assert.equal(task.type, type); assert.equal(task.taskId, task.runId)
      const started = await run('start'); assert.equal(started.kind, 'success', started.text)
      assert.equal(JSON.parse(started.text!).state, 'Working')
      const changed = f.until(value => value.taskId === task.taskId && value.state === 'Ignore')
      assert.equal((await run('ignore --reason The user ended this verification task.')).kind, 'success'); await changed
    }
    await f.runtime.withDatabase(db => {
      assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n, TASK_TYPES.length)
      assert.equal(db.prepare('SELECT count(*) n FROM run_intakes').get()!.n, TASK_TYPES.length)
      assert.equal(db.prepare('SELECT count(*) n FROM dsh_coding_workflows').get()!.n, 0)
    })
    const before = await f.service.snapshot(f.agent)
    for (const input of ['unknown', 'start extra more', 'create unknown text', 'complete', 'ignore']) assert.equal((await run(input)).kind, 'error')
    assert.deepEqual(await f.service.snapshot(f.agent), before)
    await assert.rejects(f.service.snapshot({ ...f.agent }), /exact current/)
  } finally { await f.cleanup() }
})

test('structured stop returns durable pending state without awaiting its own native turn; evidence and CAS remain authoritative', async () => {
  const f = await fixture()
  let release!: () => void
  try {
    const created = await f.service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect the current repository only.' }, signal())
    const working = await f.service.operate(f.agent, { operation: 'start', expected: created }, signal())
    const lease = await f.runtime.withDatabase(db => captureTaskLease(db, working))
    f.agent.status = 'running'; f.agent.whenIdle = () => new Promise<void>(resolve => { release = resolve })
    let concluded = 0
    const stopping = await f.service.modelOperation(f.agent, { operation: 'wait', taskId: working.taskId,
      expectedRevision: working.revision, expectedGeneration: working.generation, reason: 'Wait for external information', evidence: [] },
    { callId: 'model-wait', signal: signal(), concludeTurn: () => { concluded++ } })
    assert.equal(concluded, 1); assert.equal(stopping.state, 'Working'); assert.equal(stopping.pendingStop?.operation, 'wait')
    await assert.rejects(f.runtime.withDatabase(db => authorizeTaskLease(db, lease)), /stale|stopped/)
    const pendingEvent = f.until(value => value.state === 'Pending')
    while (!release) await new Promise(resolve => setImmediate(resolve))
    f.agent.status = 'idle'; release()
    const pending = await pendingEvent
    assert.ok(pending.evidence.some(ref => ref.startsWith('stopped:')))
    await assert.rejects(f.service.operate(f.agent, { operation: 'resume', expected: working }, signal()), /changed/)
    const resumed = await f.service.operate(f.agent, { operation: 'resume', expected: pending }, signal())
    assert.equal(resumed.state, 'Working')
    await assert.rejects(f.service.modelOperation(f.agent, { operation: 'complete', taskId: resumed.taskId,
      expectedRevision: resumed.revision, expectedGeneration: resumed.generation, reason: 'Model says done', evidence: ['fake-verification'] },
    { callId: 'false-complete', signal: signal() }), /host-observed verification/)
    assert.equal((await f.service.snapshot(f.agent)).task!.state, 'Working')
  } finally { release?.(); await f.cleanup() }
})

test('trusted primary handoff transfers only current ownership and invalidates old leases', async () => {
  const f = await fixture()
  try {
    const created = await f.service.operate(f.agent, { operation: 'create', taskType: 'analysis', request: 'Analyze this exact repository.' }, signal())
    const working = await f.service.operate(f.agent, { operation: 'start' }, signal())
    const lease = await f.runtime.withDatabase(db => captureTaskLease(db, working))
    const target = { id: 'continuation', session: { id: 'continuation-session', header: { cwd: f.root, parentSession: f.agent.session.id } }, status: 'idle' }
    f.agents.set(target.id, target); f.sessions.set(target.session.id, target.session)
    await assert.rejects(f.service.handoff(f.agent, { ...target }, working, signal()), /exact current/)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(f.service.handoff(f.agent, target, working, aborted.signal))
    assert.equal((await f.service.snapshot(f.agent)).task!.revision, working.revision)
    const transferred = await f.service.handoff(f.agent, target, working, signal())
    assert.equal(transferred.taskId, created.taskId); assert.equal(transferred.sessionId, target.session.id)
    assert.equal(transferred.sourceSessionId, f.agent.session.id)
    assert.equal((await f.service.snapshot(f.agent)).task, null)
    await assert.rejects(f.runtime.withDatabase(db => authorizeTaskLease(db, lease)), /owner/)
    assert.equal((await f.service.snapshot(target)).task!.taskId, created.taskId)
  } finally { await f.cleanup() }
})

for (const staleRequest of ['handoff', 'stop-callback'] as const) test(`${staleRequest}: stale requests cannot cancel a resumed task generation`, async () => {
  const f = await fixture()
  let stopCalls = 0, currentWork: AbortController | undefined
  const stopTask = async () => { stopCalls++; currentWork?.abort() }
  const service = new DshTaskWorkflow({ ...f.options, lisp: () => ({ stopTask }) })
  try {
    await service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect this exact repository.' }, signal())
    const working = await service.operate(f.agent, { operation: 'start' }, signal())
    const pendingEvent = f.until(task => task.state === 'Pending')
    const stopping = await service.operate(f.agent, { operation: 'wait' }, signal())
    const pending = await pendingEvent
    const resumed = await service.operate(f.agent, { operation: 'resume', expected: pending }, signal())
    currentWork = new AbortController()
    const stoppedBeforeStaleRequests = stopCalls
    if (staleRequest === 'handoff') {
      const target = { id: 'continuation', session: { id: 'continuation-session', header: { cwd: f.root, parentSession: f.agent.session.id } }, status: 'idle' }
      f.agents.set(target.id, target); f.sessions.set(target.session.id, target.session)
      await assert.rejects(service.handoff(f.agent, target, working, signal()), /changed before handoff/)
    } else {
      // Wait for a real database observation rather than sleeping for a callback.
      let observed!: () => void
      const inspected = new Promise<void>(resolve => { observed = resolve })
      const oldRuntime = { async withDatabase(operation: any) {
        try { return await f.runtime.withDatabase(operation) } finally { observed() }
      } } as unknown as DshCoreRuntime
      const old = new DshTaskWorkflow({ ...f.options, runtime: oldRuntime, lisp: () => ({ stopTask }) })
      try { old.finishStop(f.agent, stopping); await inspected } finally { old.dispose() }
    }
    assert.equal(currentWork.signal.aborted, false, 'the newer generation must keep running after the stale request')
    assert.equal(stopCalls, stoppedBeforeStaleRequests, 'stale CAS must fail before cancelling any work')
    assert.deepEqual((await service.snapshot(f.agent)).task, resumed)
  } finally { service.dispose(); await f.cleanup() }
})

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const available = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) throw new Error('Configured native DSH runtime is required')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
test('native task schema streams through the managed OpenCode Go route while host validation stays operation-specific', { skip: !available }, async t => {
  const f = await fixture(), [cordis, tools, prompt] = await Promise.all(['cordis', 'dsh-tools', 'dsh-system-prompt'].map(load))
  const ctx = new cordis.Context(), fibers: any[] = []
  let disposeSurface: (() => void) | undefined, models: KiokukoModelsService | undefined
  const intake = new OnDemandIntake({ validate: async () => {}, existing: async () => false, classify: async () => ({ deferInference: true }),
    prepare: async () => { throw new Error('Schema probe must not prepare a task') }, ready: () => false })
  try {
    fibers.push(await ctx.plugin(prompt.default, {}))
    await mountNativeTools(ctx, tools, packages, fibers)
    disposeSurface = mountTaskWorkflowSurface(ctx, new DshTaskWorkflow({ ...f.options, demand: intake }), intake)
    const schema = ctx.tools.schemas(f.agent).find((value: any) => value.name === TASK_OPERATION_TOOL)!
    assert.ok(schema)
    const publicInput = z.fromJSONSchema(schema.parameters)
    const advertisedStart = { operation: 'start', taskId: 'task-fixture', expectedRevision: 1, expectedGeneration: 1 }
    assert.equal(publicInput.safeParse(advertisedStart).success, false, 'the advertised start operation must require its reason')
    assert.equal(publicInput.safeParse({ ...advertisedStart, reason: 'Start the current task' }).success, true)
    assert.equal(publicInput.safeParse({ operation: 'create', taskType: 'research' }).success, true)
    assert.equal(publicInput.safeParse({ operation: 'create', taskType: 'research', reason: 'Not a create field' }).success, false)
    const credentials = new CredentialFile(join(f.root, 'unused-credentials.json'))
    t.mock.method(credentials, 'read', async (provider: string) => {
      assert.equal(provider, 'opencode-go')
      return { type: 'api_key', key: 'offline-fixture' }
    })
    const config = new ModelsConfigStore(join(f.root, 'unused-models.json'))
    const id = 'kiokuko-opencode-go-fixture', model = 'deepseek-v4.1-flash'
    t.mock.method(config, 'read', async () => ({ version: 1, revision: 0, connections: [{ id, kind: 'opencode-go',
      name: 'Offline Go', baseURL: 'https://opencode.ai/zen/go/v1', protocol: 'chat-completions', serviceTier: 'standard', models: [] }] }))
    let adapter!: LlmAdapter
    models = new KiokukoModelsService({ credentials, config, llm: {
      registerAdapter: (_ids: string[], value: LlmAdapter) => { adapter = value; return () => {} },
      resolveCallConfig: async () => { throw new Error('Unexpected resolution') }, discoverModels: async () => [],
    } as any })
    await models.start()
    const requests: any[] = []
    t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
      assert.equal(String(input), 'https://opencode.ai/zen/go/v1/chat/completions')
      assert.equal(new Headers(init.headers).get('x-opencode-session'), 'offline-task-schema')
      const body = JSON.parse(init.body); requests.push(body)
      if (body.tools.some((tool: any) => tool.function.parameters.type !== 'object')) {
        return Response.json({ error: { message: 'Tool parameters require a root object' } }, { status: 400 })
      }
      const events = [{ id: 'offline', choices: [{ index: 0, delta: { content: 'SCHEMA CONNECTED' }, finish_reason: null }] },
        { id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    })
    const options: GenerateOptions = { provider: id, model, sessionId: SessionId('offline-task-schema'), reasoningEffort: ReasoningEffortId('high'),
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })], tools: [schema] }
    const collect = async (source: AsyncIterable<any>) => { const chunks = []; for await (const chunk of source) chunks.push(chunk); return chunks }
    // The strict provider fixture rejects the pre-fix union through the same serializer.
    await assert.rejects(collect(adapter.stream({ ...options, tools: [{ ...schema,
      parameters: JSON.parse(JSON.stringify(z.toJSONSchema(TaskModelOperationSchema))) }] })), /HTTP 400/)
    const chunks = await collect(adapter.stream(options))
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'SCHEMA CONNECTED'))
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(requests[1].model, model)
    assert.equal(requests[1].reasoning_effort, 'high')
    assert.equal(requests[1].tools[0].function.parameters.type, 'object')
    assert.equal(publicInput.safeParse({ ...advertisedStart, reason: 'Start the current task', unexpected: true }).success, false)
    assert.equal(TaskModelOperationSchema.safeParse({ operation: 'create', taskType: 'research' }).success, true)
    const start = { operation: 'start', taskId: 'task-fixture', expectedRevision: 1, expectedGeneration: 1, reason: 'Start requested work' }
    assert.equal(TaskModelOperationSchema.safeParse(start).success, true)
    for (const invalid of [{ ...start, expectedRevision: undefined }, { ...start, expectedGeneration: 0 },
      { ...start, taskType: 'research' }, { operation: 'create', taskType: 'research', request: 'Rewritten request' }]) {
      assert.equal(TaskModelOperationSchema.safeParse(invalid).success, false)
    }
  } finally { await models?.close(); disposeSurface?.(); await intake.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await f.cleanup() }
})

for (const mode of ['native', 'ptc'] as const) test(`${mode}: actual task control executor crosses ToDo/Pending while native denial and spoofed tools cannot`, { skip: !available, timeout: 30_000 }, async () => {
  const f = await fixture(), [cordis, tools, prompt] = await Promise.all(['cordis', 'dsh-tools', 'dsh-system-prompt'].map(load))
  const ctx = new cordis.Context(), fibers: any[] = []
  let disposeSurface: (() => void) | undefined, disposeOwned: (() => Promise<void>) | undefined, restoreRuntime: (() => void) | undefined
  let intake: OnDemandIntake | undefined, programs = 0, writes = 0
  try {
    fibers.push(await ctx.plugin(prompt.default, {}))
    if (mode === 'ptc') {
      for (const name of ['dsh-session-projection', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-ptc-runtime-node']) {
        const plugin = await load(name), config = name === 'dsh-fs-local' ? { cwd: f.root } : name === 'dsh-working-directory' ? { defaultDirectory: f.root }
          : name === 'dsh-sandbox-policy' ? { mode: 'read-only', workspaceRoot: f.root } : name === 'dsh-ptc-runtime-node' ? { timeoutMs: 10000 } : {}
        fibers.push(await ctx.plugin(plugin.default, config))
      }
      const runtime = ctx.get('ptcRuntime', false), original = runtime.run
      runtime.run = function (...args: any[]) { programs++; return original.apply(this, args) }; restoreRuntime = () => { runtime.run = original }
    }
    await mountToolExecutor(ctx, tools, packages, mode, fibers)
    const nativeScope = (await load('dsh-scope')).createScope(ctx, f.agent)
    ;(f.agent as any).ctx = nativeScope.ctx
    fibers.push(nativeScope)
    let taskForIntent: TaskSnapshot | undefined
    intake = new OnDemandIntake({ validate: async () => {}, existing: async () => false, classify: async () => ({ deferInference: true }),
      interpret: async (_input, task) => {
        const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), ...(taskForIntent ? { activeTask: taskForIntent } : {}) })!
        return { context, decision: unresolvedRequestIntent(context, 'decision_service_disabled') }
      },
      prepare: async () => { throw new Error('Task control must not prepare a new execution run') }, ready: () => false })
    const service = new DshTaskWorkflow({ ...f.options, demand: intake })
    disposeSurface = mountTaskWorkflowSurface(ctx, service, intake)
    await ctx.tools.schemas(f.agent) // Native lossless schema projection, as used before real model requests.
    const created = await service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Keep the original scope.' }, signal())
    taskForIntent = created
    const identity = await f.runtime.withDatabase(db => ({ runId: created.runId, sessionId: created.sessionId,
      repositoryRoot: f.root, workspace: db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<any>(created.runId)!.workspace,
      generation: 'fixture-host-generation', agent: f.agent }))
    disposeOwned = mountOwnedExecution({ tools: ctx.tools, on: ctx.on.bind(ctx) }, { runtime: f.runtime,
      resolve: execution => execution.agent === f.agent ? identity : undefined, isTaskControl: execution => service.isControl(execution) })
    intake.mount(ctx, ctx.tools)
    await intake.capture({ agent: f.agent, messages: [{ id: 'human', role: 'user', content: 'Inspect original scope; no source edits.' }], turn: 1, step: 0, signal: signal() })
    let calls = 0
    const invoke = (operation: string, task: TaskSnapshot, evidence: string[] = []) => {
      const args = { operation, taskId: task.taskId, expectedRevision: task.revision, expectedGeneration: task.generation, reason: 'Explicit structured operation', evidence }
      return executeNativeTool(ctx, packages, { callId: `control-${++calls}`, name: mode === 'ptc' ? 'run_code' : TASK_OPERATION_TOOL,
        arguments: mode === 'ptc' ? { description: 'Task operation only', code: `return await tools.task_operation(${JSON.stringify(args)})` } : args,
        agent: f.agent, signal: signal() })
    }
    const deny = ctx.tools.guard(() => 'Native permission denied')
    assert.equal((await invoke('start', created)).isError, true); deny()
    assert.equal((await service.snapshot(f.agent)).task!.state, 'ToDo')
    const started = await invoke('start', created)
    assert.equal(started.isError, false, JSON.stringify(started))
    const working = (await service.snapshot(f.agent)).task!
    assert.equal(working.state, 'Working')
    assert.equal(intake.snapshot(f.agent.session.id)!.requestIntent!.evidence.taskRevision, working.revision, 'Control success refreshes exact refs for the next model step')
    assert.equal(intake.snapshot(f.agent.session.id)!.task, 'Inspect original scope; no source edits.')
    assert.equal((await invoke('start', created)).isError, true)
    const pendingEvent = f.until(task => task.state === 'Pending')
    assert.equal((await invoke('wait', working)).isError, false)
    const pending = await pendingEvent
    assert.equal((await invoke('complete', pending, ['fake'])).isError, true)
    assert.equal(programs, 0, 'The canonical control carrier never evaluates code')
    disposeSurface(); disposeSurface = undefined
    const releaseSpoof = ctx.tools.register({ name: TASK_OPERATION_TOOL, parameters: {}, output: { schema: {}, render: () => [] }, execute() { writes++; return 'spoof' } })
    const result = await executeNativeTool(ctx, packages, { callId: 'spoof', name: mode === 'ptc' ? 'run_code' : TASK_OPERATION_TOOL,
      arguments: mode === 'ptc' ? { description: 'spoof', code: 'return await tools.task_operation({})' } : {}, agent: f.agent, signal: signal() })
    assert.equal(result.isError, true); assert.equal(writes, 0); assert.equal(programs, 0); releaseSpoof()
    assert.equal((await f.runtime.withDatabase(db => readTaskSnapshot(db, pending))).state, 'Pending')
  } finally { disposeSurface?.(); await intake?.dispose(); await disposeOwned?.(); restoreRuntime?.(); for (const fiber of fibers.reverse()) await fiber.dispose(); await f.cleanup() }
})

test('Lisp drain and reload precede stop confirmation; missing enabled service cannot prove idle', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const draining = new DshTaskWorkflow({ ...f.options, lisp: () => ({ async stopTask(agent) {
    assert.equal(agent, f.agent); entered(); await new Promise<void>(resolve => { release = resolve })
  } }) })
  let restored: DshTaskWorkflow | undefined
  try {
    const created = await f.service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect local evidence.' }, signal())
    const working = await f.service.operate(f.agent, { operation: 'start' }, signal())
    await f.runtime.withDatabase(db => db.prepare('INSERT INTO dsh_lisp_sessions VALUES(?,?,?,?,?)').run(f.agent.session.id, f.root, 1, 'epoch', new Date().toISOString()))
    const stopping = await draining.operate(f.agent, { operation: 'wait', expected: working }, signal())
    await enteredPromise
    assert.equal(stopping.state, 'Working'); assert.ok(stopping.pendingStop)
    assert.equal((await f.service.snapshot(f.agent)).task!.state, 'Working')
    draining.dispose(); release()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await f.service.snapshot(f.agent)).task!.state, 'Working')
    const target = { id: 'target', session: { id: 'target-session', header: { cwd: f.root, parentSession: f.agent.session.id } }, status: 'idle' }
    f.agents.set(target.id, target); f.sessions.set(target.session.id, target.session)
    await assert.rejects(f.service.handoff(f.agent, target, stopping, signal()), /stop is unresolved/)
    restored = new DshTaskWorkflow({ ...f.options, lisp: () => ({ async stopTask() {} }) })
    const pending = f.until(task => task.state === 'Pending')
    restored.finishStop(f.agent, (await restored.snapshot(f.agent)).task!)
    assert.equal((await pending).taskId, created.taskId)
  } finally { release?.(); draining.dispose(); restored?.dispose(); await f.cleanup() }
})

test('surface reload resumes durable pending work for existing native agents and cleans up partial registration', async () => {
  const f = await fixture()
  let dispose: (() => void) | undefined
  try {
    const created = await f.service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect local evidence.' }, signal())
    await f.service.operate(f.agent, { operation: 'start' }, signal())
    await f.runtime.withDatabase(db => db.prepare('INSERT INTO dsh_lisp_sessions VALUES(?,?,?,?,?)').run(f.agent.session.id, f.root, 1, 'epoch', new Date().toISOString()))
    await f.service.operate(f.agent, { operation: 'wait' }, signal())
    await new Promise(resolve => setImmediate(resolve))
    const service = new DshTaskWorkflow({ ...f.options, lisp: () => ({ async stopTask() {} }) })
    let registrations = 0
    const ctx = { provide() { registrations++; return () => { registrations-- } }, get(name: string) { return name === 'agents' ? { list: () => [f.agent] } : undefined },
      on() { registrations++; return () => { registrations-- } } }
    const pending = f.until(task => task.state === 'Pending')
    dispose = mountTaskWorkflowSurface(ctx as any, service)
    assert.equal((await pending).taskId, created.taskId)
    dispose(); dispose(); assert.equal(registrations, 0)
    const failure = new DshTaskWorkflow(f.options)
    const broken = { ...ctx, get(name: string) { return name === 'commands' ? { register() { throw new Error('Command collision') } } : undefined } }
    assert.throws(() => mountTaskWorkflowSurface(broken as any, failure), /Command collision/)
    assert.equal(registrations, 0)
    await assert.rejects(failure.snapshot(f.agent), /exact current/)
  } finally { dispose?.(); await f.cleanup() }
})

for (const failure of ['control', 'second-event', 'third-event'] as const) test(`partial task surface mount releases every prior registration when ${failure} registration throws`, () => {
  const registered = new Set<string>(), released: string[] = []
  let serviceDisposed = 0, eventCount = 0
  const register = (name: string) => {
    assert.equal(registered.has(name), false)
    registered.add(name)
    return () => { assert.equal(registered.delete(name), true); released.push(name) }
  }
  const service = { dispose() { serviceDisposed++ } } as unknown as DshTaskWorkflow
  const ctx = {
    provide() { return register('service') },
    get(name: string) {
      if (name === 'commands') return { register() { return register('command') } }
      if (name === 'tools') return { register() { return register('tool') } }
      return undefined
    },
    on(name: string) {
      eventCount++
      if (eventCount === (failure === 'second-event' ? 2 : 3)) throw new Error(`registration failure: ${failure}`)
      return register(name)
    },
  }
  const demand = { registerControlTool() {
    if (failure === 'control') throw new Error('registration failure: control')
    return register('control')
  } } as unknown as OnDemandIntake
  assert.throws(() => mountTaskWorkflowSurface(ctx as any, service, demand), /registration failure/)
  assert.equal(serviceDisposed, 1)
  assert.deepEqual([...registered], [], 'Earlier successful tool and event registrations must not survive a later exception')
  assert.ok(released.includes('tool'))
  if (failure !== 'control') assert.ok(released.includes('agent/idle'))
  if (failure === 'third-event') assert.ok(released.includes('agent/created'))
})

test('a delayed old lifecycle close cannot terminalize an explicitly resumed generation', async () => {
  const { createLifecycle } = await import('../../../src/dsh/host-adapter/lifecycle.js')
  const f = await fixture()
  const no = () => {}
  const lifecycle = createLifecycle({ runtime: f.runtime, sessions: {}, sessionMirror: {}, memoryFinalizer: {},
    autoReview: { worker: { abort: no } }, answerReview: {}, ennoController: {}, ennoMemory: {}, executionSupport: {}, gate: {},
    turnState: { allTurns: () => [], releaseRun: no }, getSelection: () => undefined, currentSession: () => undefined,
    currentForAgentEvent: () => undefined, stateForRun: () => ({}), deliverCompletionReport: async () => {}, reviewBinding: no,
    evolutionConfig: { mode: 'off' }, clearToolRun: no, sessionEventSource: no } as any)
  try {
    await f.service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect the exact current repository.' }, signal())
    const first = await f.service.operate(f.agent, { operation: 'start' }, signal())
    const oldAuthority = await f.runtime.withDatabase(db => captureTaskLease(db, first))
    const pending = f.until(task => task.state === 'Pending')
    await f.service.operate(f.agent, { operation: 'wait', expected: first }, signal()); await pending
    const second = await f.service.operate(f.agent, { operation: 'resume' }, signal())
    const authority = await f.runtime.withDatabase(db => captureTaskLease(db, second))
    await lifecycle.runLifecycle.closeTurn({ runId: first.runId, status: 'cancelled', authority: oldAuthority })
    await lifecycle.runLifecycle.closeTurn({ runId: first.runId, status: 'cancelled' })
    assert.equal((await f.service.snapshot(f.agent)).task!.runStatus, 'active')
    assert.equal((await f.service.snapshot(f.agent)).task!.revision, second.revision)
    await lifecycle.runLifecycle.closeTurn({ runId: second.runId, status: 'cancelled', authority })
    assert.equal((await f.service.snapshot(f.agent)).task!.runStatus, 'cancelled')
    const third = await f.service.operate(f.agent, { operation: 'resume' }, signal())
    const latest = await f.runtime.withDatabase(db => captureTaskLease(db, third))
    await lifecycle.runLifecycle.closeTurn({ runId: third.runId, status: 'failed', authority: latest })
    assert.equal((await f.service.snapshot(f.agent)).task!.runStatus, 'failed', 'Lifecycle idempotency is scoped to generation')
  } finally { await lifecycle.runLifecycle.dispose(); await f.cleanup() }
})

for (const type of ['research', 'writing'] as const) test(`${type}: explicit completion validates actual current owned receipt provenance`, async () => {
  const f = await fixture()
  let owned: OwnedExecutionService | undefined
  try {
    await writeFile(join(f.root, 'report.txt'), 'Observed current repository facts. No unrelated changes.')
    await f.service.operate(f.agent, { operation: 'create', taskType: type, request: 'Produce a report grounded in the current repository.' }, signal())
    const task = await f.service.operate(f.agent, { operation: 'start' }, signal())
    const workspace = await f.runtime.withDatabase(db => db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<any>(task.taskId)!.workspace)
    owned = new OwnedExecutionService({ runtime: f.runtime, resolve: execution => execution.agent === f.agent ? {
      runId: task.runId, sessionId: task.sessionId, repositoryRoot: task.repositoryRoot, workspace, agent: f.agent, generation: 'fixture-native-owner' } : undefined })
    let calls = 0
    const read = () => owned!.execute('kioku_read', { path: 'report.txt' }, { name: 'kioku_read', arguments: { path: 'report.txt' }, callId: `read-${++calls}`, agent: f.agent, signal: signal() }) as Promise<any>
    const command = taskWorkflowCommand(f.service), complete = (refs: string[]) => command.handler({ agent: f.agent,
      rawInput: `complete ${task.taskId}${refs.map(ref => ` --evidence ${ref}`).join('')}`, signal: signal() })
    assert.equal((await complete([])).kind, 'error')
    assert.equal((await complete(['owned:' + 'a'.repeat(64)])).kind, 'error')
    const actual = await read(); assert.match(actual.content, /Observed current repository facts/)
    const oldRef = actual.receipt.evidenceRef
    const pending = f.until(value => value.state === 'Pending')
    await f.service.operate(f.agent, { operation: 'wait' }, signal()); await pending
    await f.service.operate(f.agent, { operation: 'resume' }, signal())
    assert.equal((await complete([oldRef])).kind, 'error', 'Old generation observations do not authorize Done')
    const current = await read()
    if (type === 'research') {
      const args = { command: 'sleep 30', background: true, timeoutMs: 30000 }
      const running: any = await owned.execute('kioku_exec', args, { name: 'kioku_exec', arguments: args, callId: 'still-running', agent: f.agent, signal: signal() })
      const refused = await complete([current.receipt.evidenceRef])
      assert.equal(refused.kind, 'error'); assert.match(refused.text!, /running owned work/)
      assert.equal((await f.service.snapshot(f.agent)).task!.state, 'Working')
      await owned.execute('kioku_result', { operationId: running.receipt.operationId, cancel: true }, { name: 'kioku_result', callId: 'stop-job', agent: f.agent, signal: signal() })
      for (let i = 0; i < 100; i++) {
        const terminal: any = await owned.execute('kioku_result', { operationId: running.receipt.operationId }, { name: 'kioku_result', callId: 'terminal-job', agent: f.agent, signal: signal() })
        if (terminal.receipt.state !== 'started') break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    } else {
      let latestIdle = false
      const guarded = new DshTaskWorkflow({ ...f.options, lisp: () => ({ async taskJobsIdle() { return true }, taskJobsIdleSync() { return latestIdle } }) })
      try {
        await assert.rejects(guarded.operate(f.agent, { operation: 'complete', evidence: [current.receipt.evidenceRef] }, signal()), /running or unconfirmed Lisp/)
        assert.equal((await f.service.snapshot(f.agent)).task!.state, 'Working', 'A job starting after the async observation cannot cross the transaction')
        latestIdle = true
      } finally { guarded.dispose() }
    }
    const result = await complete([current.receipt.evidenceRef])
    assert.equal(result.kind, 'success', result.text)
    const done = JSON.parse(result.text!) as TaskSnapshot
    assert.equal(done.state, 'Done'); assert.equal(done.type, type)
    assert.ok(done.evidence.includes(current.receipt.evidenceRef))
    const modelResume = { operation: 'resume', taskId: done.taskId, expectedRevision: done.revision, expectedGeneration: done.generation, reason: 'Model cannot resume terminal work', evidence: [] }
    await assert.rejects(f.service.modelOperation(f.agent, modelResume, { callId: 'resume-forbidden', signal: signal() }), /explicit resume/)
    assert.equal((await f.service.operate(f.agent, { operation: 'resume', expected: done }, signal())).state, 'Working')
  } finally { await owned?.close(); await f.cleanup() }
})

for (const operation of ['wait', 'ignore'] as const) test(`${operation}: confirmed native stop checkpoints its source without automatic memory jobs`, async () => {
  const f = await fixture()
  let kicked = 0
  const service = new DshTaskWorkflow({ ...f.options, checkpointSource: async () => { f.agent.session.seq = 13 }, kickFinalizer: () => { kicked++ } })
  try {
    await service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect local source.' }, signal())
    const task = await service.operate(f.agent, { operation: 'start' }, signal())
    await f.runtime.withDatabase(db => {
      const workspace = db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<any>(task.runId)!.workspace
      const now = new Date().toISOString()
      db.prepare('INSERT INTO dsh_run_log_boundaries(run_id,workspace,dsh_session_id,source_start_seq,source_start_turn,created_at,updated_at) VALUES(?,?,?,2,1,?,?)')
        .run(task.runId, workspace, task.sessionId, now, now)
    })
    const event = f.until(value => value.state === (operation === 'wait' ? 'Pending' : 'Ignore'))
    await service.operate(f.agent, { operation, reason: 'The user explicitly stopped this task.' }, signal())
    const stopped = await event
    assert.equal(stopped.runStatus, 'active')
    await f.runtime.withDatabase(db => {
      const job = db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get<any>(task.runId)!
      assert.equal(job, undefined); assert.equal(f.agent.session.seq, 13); assert.equal(kicked, 0)
      assert.equal(db.prepare('SELECT source_start_seq FROM dsh_run_log_boundaries WHERE run_id=?').get<any>(task.runId)!.source_start_seq, 2)
    })
  } finally { service.dispose(); await f.cleanup() }
})

for (const resumeBeforeIdle of [false, true]) test(`Done source waits for final native answer and rejects obsolete idle callbacks (resume=${resumeBeforeIdle})`, async () => {
  const f = await fixture()
  let release!: () => void, checked!: () => void, completed = 0, kicked = 0
  const checkedPromise = new Promise<void>(resolve => { checked = resolve })
  const service = new DshTaskWorkflow({ ...f.options, checkpointSource: async () => { f.agent.session.seq = 21; checked() },
    onCompleted: () => { completed++ }, kickFinalizer: () => { kicked++ } })
  let owned: OwnedExecutionService | undefined
  try {
    await writeFile(join(f.root, 'evidence.txt'), 'Observed evidence supporting this explicit completion.')
    await service.operate(f.agent, { operation: 'create', taskType: 'research', request: 'Inspect local source.' }, signal())
    const task = await service.operate(f.agent, { operation: 'start' }, signal())
    const workspace = await f.runtime.withDatabase(db => {
      const workspace = db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<any>(task.runId)!.workspace
      const now = new Date().toISOString()
      db.prepare('INSERT INTO dsh_run_log_boundaries(run_id,workspace,dsh_session_id,source_start_seq,source_start_turn,created_at,updated_at) VALUES(?,?,?,2,1,?,?)')
        .run(task.runId, workspace, task.sessionId, now, now)
      return workspace
    })
    owned = new OwnedExecutionService({ runtime: f.runtime, resolve: execution => execution.agent === f.agent ? {
      runId: task.runId, sessionId: task.sessionId, repositoryRoot: task.repositoryRoot, workspace, agent: f.agent, generation: 'native-fixture' } : undefined })
    const observed: any = await owned.execute('kioku_read', { path: 'evidence.txt' }, { name: 'kioku_read', callId: 'evidence', agent: f.agent, signal: signal() })
    f.agent.status = 'running'; f.agent.session.seq = 8
    f.agent.whenIdle = () => new Promise<void>(resolve => { release = resolve })
    const done = await service.operate(f.agent, { operation: 'complete', evidence: [observed.receipt.evidenceRef] }, signal())
    assert.equal(done.state, 'Done')
    assert.equal(await f.runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM dsh_memory_finalizations').get<any>()!.n), 0)
    if (resumeBeforeIdle) await service.operate(f.agent, { operation: 'resume', expected: done }, signal())
    f.agent.status = 'idle'; release(); await checkedPromise
    // Let the database continuation complete; no model/provider timing is involved.
    for (let i = 0; i < 20 && !completed && !resumeBeforeIdle; i++) await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    await f.runtime.withDatabase(db => {
      const job = db.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id=?').get<any>(task.runId)
      if (resumeBeforeIdle) { assert.equal(job, undefined); assert.equal(completed, 0); assert.equal(kicked, 0) }
      else { assert.equal(job, undefined); assert.equal(f.agent.session.seq, 21); assert.equal(completed, 1); assert.equal(kicked, 0) }
    })
  } finally { release?.(); service.dispose(); await owned?.close(); await f.cleanup() }
})
