import { mountNativeTools, mountToolExecutor, executeNativeTool } from '../helpers/native-tools.js'
/** Real native/PTC dispatch, DecisionService validation and SQLite CoreTasks admission.
 * Decision answers, Skill inventory and intake answers are deterministic doubles;
 * this does not exercise a paid model, the full plugin startup, or a deployed host. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { CoreTasks, type CoreTask } from '../../../src/dsh/core/tasks.js'
import { DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { readTaskSnapshot, TASK_AUTHORITY } from '../../../src/dsh/task-state.js'
import { OwnedExecutionService } from '../../../src/dsh/owned-execution.js'
import { OnDemandIntake, TASK_PREPARE_TOOL, type DemandInput } from '../../../src/dsh/on-demand-intake.js'
import { bindMainModelRequestIntent, classifyRequestIntent, createRequestIntentContext, requestIntentMessageRefs,
  requestIntentReferenceIds, type RequestIntentContext, type RequestIntentDecision } from '../../../src/dsh/decisions/request-intent.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const available = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) {
  throw new Error('Request-intent advisory tests require the configured native DSH package root')
}
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const signal = () => new AbortController().signal
const resultText = (result: any) => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')

for (const mode of ['native', 'ptc'] as const) for (const action of ['verify', 'change', 'unknown'] as const) {
  test(`${mode}: uncertain optional operation preserves ${action} and exact-task admission boundaries`,
    { skip: !available, timeout: 30_000 }, async () => {
    const [cordis, tools, prompt, sessions] = await Promise.all(['cordis', 'dsh-tools', 'dsh-system-prompt', 'dsh-session'].map(load))
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'request-intent-advisory-')))
    const ctx = new cordis.Context(), fibers: any[] = []
    const runtime = new DshCoreRuntime({ repositoryRoot: root, databasePath: join(root, 'state.sqlite3'), autoRegisterRepository: true,
      embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
    let workflow: DshTaskWorkflow | undefined, intake: OnDemandIntake | undefined, restoreRuntime: (() => void) | undefined
    let coreTask: CoreTask | undefined, providerCalls = 0, runtimePrograms = 0, effects = 0, calls = 0
    let hostAllowsAdmission = true, ready = false
    const admissions: Array<{ input: DemandInput; taskType: string; intent?: RequestIntentDecision; context?: RequestIntentContext }> = []
    const taskType = action === 'change' ? 'writing' : 'research'
    const requestedType = action === 'change' ? 'writing' : 'review'
    const task = action === 'change'
      ? 'Update only the prose summary in PLAN.md. Target: PLAN.md. Expected: a concise summary. Preserve factual accuracy.'
      : 'Verify the current contents of PLAN.md. Target: PLAN.md. Expected: a concise explanation. Do not modify files.'
    const capabilities = [{ kind: 'skill' as const, name: 'kiokuko-soul' }]
    const core = new CoreTasks(runtime, { async ask(question) {
      return question.id === 'taskType' ? taskType : question.id === 'target' ? 'PLAN.md'
        : question.id === 'expected' ? 'A concise explanation' : 'No unrelated changes'
    } })
    const decisions = new DecisionService(TypedDecisionsConfig.parse({ provider: 'laya-coreml',
      'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', socketPath: join(root, 'unused-provider.sock') } }),
    () => ({ capabilities: { maxQuestions: 256, maxChoices: 256, maxBytes: 262144 },
      async evaluate(batch) {
        providerCalls++
        return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(question => {
          const choiceId = question.id === 'request-relation' ? 'same_scope_continuation'
            : question.id === 'request-action' && action !== 'unknown' ? action
              : question.id === 'request-change-scope' && action === 'change' ? 'document'
                : question.id.startsWith('request-proposal-') ? 'not_selected' : undefined
          return choiceId ? { id: question.id, status: 'selected' as const, choiceId }
            : { id: question.id, status: 'abstained' as const, reason: 'uncertain' as const }
        }) }
      } }))
    try {
      await mkdir(join(root, '.git'))
      await runtime.start()
      fibers.push(await ctx.plugin(prompt.default, {}))
      if (mode === 'ptc') {
        for (const name of ['dsh-session-projection', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subprocess-local',
          'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-ptc-runtime-node']) {
          const plugin = await load(name)
          const config = name === 'dsh-fs-local' ? { cwd: root } : name === 'dsh-working-directory' ? { defaultDirectory: root }
            : name === 'dsh-sandbox-policy' ? { mode: 'read-only', workspaceRoot: root }
              : name === 'dsh-ptc-runtime-node' ? { timeoutMs: 10000 } : {}
          fibers.push(await ctx.plugin(plugin.default, config))
        }
        const ptc = ctx.get('ptcRuntime', false), original = ptc.run
        ptc.run = function (...args: any[]) { runtimePrograms++; return original.apply(this, args) }
        restoreRuntime = () => { ptc.run = original }
      }
      await mountToolExecutor(ctx, tools, packages, mode, fibers)
      const session = sessions.Session.create(sessions.SessionId('intent-advisory'), [],
        { version: 4, id: 'intent-advisory', createdAt: 1, isSeeded: false, cwd: root })
      const agent = { id: 'intent-advisory-agent', session, ctx, status: 'idle', async whenIdle() {} }
      workflow = new DshTaskWorkflow({ runtime, agents: new Map([[agent.id, agent]]), sessions: new Map([[session.id, session]]),
        skills: { async snapshot() { return { complete: true, skills: [{ name: 'kiokuko-soul' }] } } }, tools: { schemas: () => [] }, emit() {} })
      const created = await workflow.operate(agent, { operation: 'create', taskType, request: task }, signal())
      const started = await workflow.operate(agent, { operation: 'start', expected: created }, signal())
      const seedContext = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task), activeTask: started })!
      const seedIntent = bindMainModelRequestIntent({ relation: 'same_scope_continuation', action: action === 'change' ? 'change' : 'verify',
        ...(action === 'change' ? { changeScope: 'document' } : {}), evidenceRefs: requestIntentReferenceIds(seedContext) }, seedContext)!
      const seeded = await core.prepare({ requestId: 'seed', sessionId: session.id, turn: 1, task, cwd: root, capabilities,
        signal: signal(), agent, requestIntent: seedIntent, requestIntentContext: seedContext })
      assert.equal(seeded.admitted, true)
      const activeTask = (await workflow.snapshot(agent)).task!
      assert.equal(activeTask.state, 'Working'); assert.equal(activeTask.runStatus, 'active')
      const messages = [{ id: 'human-current', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: task }] }]
      const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs(messages, task), activeTask,
        proposals: [{ id: 'unrelated-deployment', revision: 3, digest: 'a'.repeat(64), text: 'Deploy an unrelated service.' }] })!
      const originalContext = structuredClone(context)
      intake = new OnDemandIntake({ validate: async input => { assert.equal(input.agent, agent); assert.equal(input.agent.session, session) },
        existing: async () => false, classify: async () => ({ deferInference: true }),
        interpret: async () => ({ context, decision: (await classifyRequestIntent(decisions, 'advisory', context, signal()))! }),
        prepare: async (input, type, intent, boundContext) => {
          admissions.push({ input, taskType: type, ...(intent ? { intent } : {}), ...(boundContext ? { context: boundContext } : {}) })
          if (!hostAllowsAdmission) return false
          coreTask = await core.prepare({ requestId: `admission-${admissions.length}`, sessionId: session.id, turn: input.turn, task,
            cwd: root, capabilities, signal: input.signal, agent, ...(intent ? { requestIntent: intent } : {}),
            ...(boundContext ? { requestIntentContext: boundContext } : {}) })
          ready = coreTask.admitted
          return ready
        }, ready: candidate => candidate === agent && ready,
      })
      intake.mount(ctx, ctx.tools)
      const releaseProbe = ctx.tools.register({ name: 'effect_probe', parameters: {}, output: { schema: {}, render: () => [] },
        execute() { effects++; return 'unexpected effect' } })
      const input = { agent, turn: 1, step: 0, messages, signal: signal() }
      await intake.capture(input)
      const initial = intake.snapshot(session.id)!
      assert.equal(initial.requestIntent?.source, 'unresolved')
      assert.equal(initial.requestIntent?.unresolvedReason, action === 'unknown' ? 'provider_abstained_or_uncertain' : 'task_operation_unresolved')
      assert.equal(initial.requestIntent?.taskOperation, undefined); assert.equal(providerCalls, 1)
      const name = mode === 'ptc' ? 'run_code' : TASK_PREPARE_TOOL
      const invoke = (args: unknown) => executeNativeTool(ctx, packages, { callId: `advisory-${++calls}`, name,
        arguments: mode === 'ptc' ? { description: 'Prepare original request only',
          code: `return await tools.prepare_requested_work(${JSON.stringify(args)})` } : args, agent, signal: signal() })
      const guidanceMessages = await intake.answerMessages(input, messages)
      const guidance = (guidanceMessages.at(-1) as any).content[0].text as string
      const current = JSON.parse(guidance.split('advisory only):\n')[1]!.split('\n')[0]!)
      const allRefs = requestIntentReferenceIds(context)
      assert.deepEqual(current.references, allRefs, 'retain the complete reference list for compatibility')
      assert.deepEqual(current.requiredReferences, allRefs.filter(reference => !reference.startsWith('proposal:')))
      assert.equal(current.proposals[0].evidenceRef, allRefs.find(reference => reference.startsWith('proposal:')))
      assert.match(guidance, /only.*proposals.*(?:adopt|refer)|proposals.*only.*(?:adopt|refer)/i)
      const refs: string[] = current.requiredReferences
      const submission = (evidenceRefs: string[]) => ({ requestIntent: { relation: 'same_scope_continuation', action,
        ...(action === 'change' ? { changeScope: 'document' } : {}), evidenceRefs } })
      const unchanged = async () => {
        assert.equal(admissions.length, 0); assert.equal(effects, 0); assert.equal(runtimePrograms, 0)
        assert.deepEqual(await runtime.withDatabase(db => readTaskSnapshot(db, activeTask)), activeTask)
      }
      if (action === 'unknown') {
        const rejected = await invoke(submission(refs))
        assert.equal(rejected.isError, false, resultText(rejected))
        const waiting = mode === 'ptc' ? rejected.value.result : rejected.value
        if (mode === 'ptc') assert.equal(waiting.programExecuted, false)
        assert.equal(waiting.prepared, false); assert.equal(waiting.status, 'awaiting_clarification')
        assert.match(waiting.question, /具体的|対象|作業/)
        await unchanged(); releaseProbe(); return
      }
      for (const evidenceRefs of [refs.slice(1), [...refs, 'foreign-ref'], ...[
        { ...activeTask, revision: activeTask.revision - 1 }, { ...activeTask, generation: activeTask.generation + 1 },
      ].map(staleTask => requestIntentReferenceIds({ ...context, activeTask: staleTask }).filter(reference => !reference.startsWith('proposal:')))]) {
        const rejected = await invoke(submission(evidenceRefs))
        assert.equal(rejected.isError, true); assert.match(resultText(rejected), /missing required current|another request, stale revision/)
        await unchanged()
      }
      const invalidTransition = submission(refs)
      const invalidOperation = await invoke({ requestIntent: { ...invalidTransition.requestIntent, taskOperation: 'start' } })
      assert.equal(invalidOperation.isError, true); assert.match(resultText(invalidOperation), /not allowed.*Working/)
      await unchanged()
      const deny = ctx.tools.guard((execution: any) => execution.name === name ? 'native preparation denial' : undefined)
      try { assert.equal((await invoke({ taskType: requestedType })).isError, true); await unchanged() } finally { deny() }
      const ask = ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'native approval required' }))
      try { assert.equal((await invoke({ taskType: requestedType })).isError, true); await unchanged() } finally { ask() }
      hostAllowsAdmission = false
      const hostDenied = await invoke(submission(refs))
      assert.equal(hostDenied.isError, true)
      assert.match(resultText(hostDenied), /did not admit this exact request/)
      assert.deepEqual(admissions[0]!.intent?.evidence.proposalRefs, [], 'mandatory refs do not adopt an unrelated proposal')
      assert.deepEqual(await runtime.withDatabase(db => readTaskSnapshot(db, activeTask)), activeTask)
      hostAllowsAdmission = true
      const result = await invoke({ taskType: requestedType })
      assert.equal(result.isError, false, resultText(result))
      const receipt = mode === 'ptc' ? result.value.result : result.value
      assert.equal(receipt.permissions, 'unchanged_native_policy')
      if (mode === 'ptc') assert.equal(receipt.programExecuted, false)
      assert.equal(receipt.originalTask, task); assert.equal(receipt.requestIntent.action, action)
      assert.equal(receipt.requestIntent.relation, 'same_scope_continuation')
      assert.equal(receipt.requestIntent.source, 'unresolved'); assert.equal(receipt.requestIntent.taskOperation, undefined)
      assert.equal(receipt.requestIntent.unresolvedReason, 'task_operation_unresolved')
      assert.equal(admissions.length, 2)
      assert.equal(coreTask?.runId, created.taskId); assert.equal(coreTask?.admitted, true)
      assert.deepEqual(admissions[1]!.input.messages, messages); assert.equal(admissions[1]!.taskType, requestedType)
      assert.deepEqual(admissions[1]!.context, originalContext)
      assert.equal(admissions[1]!.intent?.evidence.taskRevision, activeTask.revision)
      assert.equal(admissions[1]!.intent?.evidence.taskGeneration, activeTask.generation)
      assert.deepEqual(await runtime.withDatabase(db => readTaskSnapshot(db, activeTask)), activeTask)
      assert.equal(await runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n), 1)
      const denyWork = ctx.tools.guard(() => 'native execution denial remains authoritative')
      try {
        const denied = await executeNativeTool(ctx, packages, { callId: 'forbidden-work', name: mode === 'ptc' ? 'run_code' : 'effect_probe',
          arguments: mode === 'ptc' ? { description: 'Attempt work', code: 'return await tools.effect_probe({})' } : {}, agent, signal: signal() })
        assert.equal(denied.isError, true)
      } finally { denyWork(); releaseProbe() }
      assert.equal(effects, 0); assert.equal(runtimePrograms, 0)

      // Controlled SQLite state injections exercise the actual admission/effect
      // guards. They do not stand in for proof of a legitimate completion event.
      const admittedTask = coreTask!
      assert.equal(admittedTask.sessionId, activeTask.sessionId)
      assert.equal(root, activeTask.repositoryRoot)
      const owned = new OwnedExecutionService({ runtime, resolve: () => ({ ...admittedTask, repositoryRoot: root,
        generation: 'advisory-fixture', agent }) })
      const effect = (id: string, oldLease = false) => {
        const name = action === 'verify' ? 'kioku_exec' : 'kioku_write'
        const args = action === 'verify' ? { command: `printf forbidden > ${id}.txt`, cwd: root }
          : { path: `${id}.txt`, content: 'must not be written' }
        return owned.execute(name, args, { name, callId: id, agent, signal: signal(),
          ...(oldLease ? { [TASK_AUTHORITY]: admittedTask.authority! } : {}) })
      }
      const prepareCurrent = async (id: string) => {
        const currentTask = await runtime.withDatabase(db => readTaskSnapshot(db, activeTask))
        const currentContext = createRequestIntentContext({ ...context, activeTask: currentTask })!
        const currentIntent = (await classifyRequestIntent(decisions, id, currentContext, signal()))!
        assert.equal(currentIntent.relation, 'same_scope_continuation'); assert.equal(currentIntent.action, action)
        assert.equal(currentIntent.taskOperation, undefined)
        return core.prepare({ requestId: id, sessionId: session.id, turn: 2, task, cwd: root, capabilities, signal: signal(), agent,
          requestIntent: currentIntent, requestIntentContext: currentContext })
      }
      try {
        const workingLease = await owned.captureAuthority({ name: 'kioku_exec', callId: 'valid-working-authority', agent, signal: signal() })
        assert.deepEqual(workingLease, admittedTask.authority, 'the same owner/root holds valid Working authority before negative states')
        for (const state of ['Pending', 'Done'] as const) {
          await runtime.withDatabase(db => db.prepare('UPDATE ledger_runs SET task_state=?,task_revision=task_revision+1,task_generation=task_generation+1 WHERE run_id=?')
            .run(state, created.taskId))
          if (state === 'Pending') assert.equal((await prepareCurrent(`prepare-${state}`)).admitted, false)
          else await assert.rejects(prepareCurrent(`prepare-${state}`), /Task intake authority changed/)
          assert.deepEqual({ ...await runtime.withDatabase(db => db.prepare('SELECT COALESCE(task_owner_session_id,dsh_session_id) owner,task_repository_root root FROM ledger_runs WHERE run_id=?').get(created.taskId)) }, { owner: admittedTask.sessionId, root })
          await assert.rejects(effect(`denied-${state}`), /not Working/)
          assert.equal(existsSync(join(root, `denied-${state}.txt`)), false)
        }
        await runtime.withDatabase(db => db.prepare("UPDATE ledger_runs SET task_state='Working',task_revision=?,task_generation=? WHERE run_id=?")
          .run(activeTask.revision, activeTask.generation + 1, created.taskId))
        await assert.rejects(core.prepare({ requestId: 'stale-generation', sessionId: session.id, turn: 2, task, cwd: root,
          capabilities, signal: signal(), agent, requestIntent: admittedTask.requestIntent!, requestIntentContext: originalContext }), /revision is stale/)
        await assert.rejects(effect('denied-generation', true), /stale/)
        assert.equal(existsSync(join(root, 'denied-generation.txt')), false)
        await runtime.withDatabase(db => db.prepare('UPDATE ledger_runs SET task_owner_session_id=? WHERE run_id=?')
          .run('another-native-session', created.taskId))
        await assert.rejects(effect('denied-owner', true), /owner|repository changed/)
        assert.equal(existsSync(join(root, 'denied-owner.txt')), false)
        assert.equal(await runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM dsh_owned_operations').get()!.n), 0)
      } finally { await owned.close() }
    } finally {
      await intake?.dispose(); restoreRuntime?.(); workflow?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await runtime.close(); await rm(root, { recursive: true, force: true })
    }
  })
}
