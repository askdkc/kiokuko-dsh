/** Actual native tools and full-adapter mapPreStep/gate/SQLite admission.
 * Finite-decision responses and question answers are scripted; no model accuracy,
 * external provider or deployed-host claim is made; native generation is scripted. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { LispConfig } from '../../../src/dsh/lisp/contracts.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { createRequestIntentContext, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'
import { readTaskSnapshot } from '../../../src/dsh/task-state.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { nativeMock, nativeToolResults } from '../helpers/native-mock.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const available = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) {
  throw new Error('Adapter advisory tests require the configured native DSH package root')
}
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const signal = () => new AbortController().signal
const resultText = (result: any) => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')

for (const scenario of ['verify', 'change', 'unknown', 'scope-unknown'] as const) {
  const action = scenario === 'scope-unknown' ? 'change' : scenario
  const semanticUnresolved = scenario === 'unknown' || scenario === 'scope-unknown'
  test(`full adapter native: optional task-operation abstention preserves ${scenario} and current task authority`,
    { skip: !available, timeout: 30_000 }, async () => withIsolatedSkillHome(async () => {
    const modules = await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt',
      'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill', 'dsh-commands', 'dsh-fs-local', 'dsh-working-directory'].map(load))
    const [cordis, llm, sessions, projection, prompt, tools, agents, loop, skills, commands, fsLocal, workingDirectory] = modules
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'request-intent-adapter-')))
    const ctx = new cordis.Context(), fibers: any[] = [], errors: unknown[] = [], idleClosures: Promise<unknown>[] = []
    let adapter: ReturnType<typeof createDshHostAdapter> | undefined
    let composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined, handle: any
    const requestBatches: Array<{ task: unknown; questionIds: string[] }> = []
    const taskType = action === 'change' ? 'writing' : 'research'
    const requestedType = action === 'change' ? 'writing' : 'review'
    const task = action === 'change'
      ? 'Update only the prose summary in PLAN.md. Target: PLAN.md. Expected: a concise summary. Preserve factual accuracy.'
      : 'Verify the current contents of PLAN.md. Target: PLAN.md. Expected: a concise explanation. Do not modify files.'
    const decisions = new DecisionService(TypedDecisionsConfig.parse({ provider: 'laya-coreml',
      'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', socketPath: join(root, 'unused-provider.sock') } }),
    () => ({ capabilities: { maxQuestions: 256, maxChoices: 256, maxBytes: 262144 }, async evaluate(batch) {
      if (batch.purpose === 'request-intent') requestBatches.push({ task: batch.state, questionIds: batch.questions.map(question => question.id) })
      return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(question => {
        if(question.id.startsWith('semantic-')) {
          assert.equal((batch.state as {source:{task:string}}).source.task,task,'independent comparison preserves this exact current human source')
          return {id:question.id,status:'selected' as const,choiceId:'supported'}
        }
        const choiceId = question.id === 'task-type' ? taskType : question.id === 'request-relation' ? 'same_scope_continuation'
          : question.id === 'request-action' && action !== 'unknown' ? action
            : question.id === 'request-change-scope' && action === 'change' && scenario !== 'scope-unknown' ? 'document'
              : question.id.startsWith('request-proposal-') ? 'not_selected' : undefined
        return choiceId ? { id: question.id, status: 'selected' as const, choiceId }
          : { id: question.id, status: 'abstained' as const, reason: 'uncertain' as const }
      }) }
    } }))
    try {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'PLAN.md'), 'ADAPTER_CURRENT_TASK_SOURCE')
      for (const plugin of [fsLocal, workingDirectory, llm, sessions, projection, prompt, tools, agents, skills, commands]) {
        const config = plugin === fsLocal ? { cwd: root } : plugin === workingDirectory ? { defaultDirectory: root }
          : plugin === prompt ? { persona: '' } : undefined
        fibers.push(await ctx.plugin(plugin.default, config))
      }
      fibers.push(await ctx.plugin(loop.default, { agents: [] }))
      fibers.push(await ctx.plugin({ name: 'advisory-adapter-questions', apply(context: any) {
        return context.provide('userQuestions', { async ask(request: any) {
          return { answers: request.questions.map((question: any) => ({ id: question.id,
            selected: question.id.startsWith('request-clarification-') ? [] : [question.id === 'taskType' ? taskType : question.id === 'target' ? 'PLAN.md'
              : question.id === 'expected' ? 'A concise explanation' : question.id === 'enno-execution-mode' ? '通常実行' : 'No unrelated changes'] })) }
        } })
      } }))
      ctx.on('agent/error', (event: any) => errors.push(event.error))
      const mock = nativeMock(llm), responses: any[] = [], model = new mock.MockAdapter(responses)
      ctx.llm.registerAdapter(['fixture'], model)
      adapter = createDshHostAdapter(ctx, { repositoryRoot: root, databasePath: join(root, 'state.sqlite3'), decisions,
        intakeMode: 'on-demand', agenticReplay: { enabled: false }, deepPlanning: { enabled: false },
        answerReview: { mode: 'off' }, modelAutoMode: { mode: 'off' }, memoryReuse: { mode: 'off' },
        memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, semanticCompaction: { mode: 'off' }, toolExposure: { mode: 'full' },
        llm: { async *stream() { throw new Error('Auxiliary model calls are disabled in adapter advisory test') } } })
      const productionIdleClose = adapter.host.resolveIdleClose!
      composition = await mountDshComposition(ctx, { ...adapter.host,
        resolveIdleClose(agentId, sessionId, nativeSession, nativeAgent) {
          // Observe completion of actual asynchronous native idle handling;
          // leave the production resolver and its return value unchanged.
          const operation = Promise.resolve(productionIdleClose(agentId, sessionId, nativeSession, nativeAgent))
          idleClosures.push(operation)
          return operation
        } }, LispConfig.parse({ enabled: false }))
      handle = await ctx.agents.create({ sessionId: sessions.SessionId('advisory-adapter'),
        agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: root } })
      const agent = handle.agent, workflow = adapter.host.taskWorkflow!, intake = adapter.host.onDemandIntake!
      const runtime = adapter.host.runtime
      assert.ok(runtime)
      assert.ok(workflow); assert.ok(intake)
      const created = await workflow.operate(agent, { operation: 'create', taskType, request: task }, signal())
      const activeTask = await workflow.operate(agent, { operation: 'start', expected: created }, signal())
      assert.equal(activeTask.state, 'Working'); assert.equal(activeTask.repositoryRoot, root)
      const readCurrent = () => runtime.withDatabase(db => readTaskSnapshot(db, activeTask))
      const assertUnchangedAuthority = async () => {
        const current = await readCurrent()
        for (const key of ['taskId', 'runId', 'sessionId', 'state', 'revision', 'generation', 'runStatus', 'repositoryRoot'] as const) {
          assert.equal(current[key], activeTask[key], `${key} must not change during advisory interpretation`)
        }
        assert.equal(await runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n), 1)
      }
      const resultFor = (request: any, callId: string) => {
        const result = nativeToolResults(request.messages).find(result => result.toolCallId === callId)
        assert.ok(result, `native result ${callId} must exist`)
        return result
      }
      let requiredRefs: string[] = [], checked = false
      const submission = (selectedAction: string, evidenceRefs: string[]) => ({ requestIntent: {
        relation: 'same_scope_continuation', action: selectedAction,
        ...(selectedAction === 'change' ? { changeScope: 'document' } : {}), evidenceRefs } })
      responses.push(async (request: any) => {
        const captured = intake.snapshot(agent.session.id)!
        assert.equal(captured.requestIntent?.source, 'unresolved')
        assert.equal(captured.requestIntent?.taskOperation, undefined)
        if (!semanticUnresolved) {
          assert.equal(captured.requestIntent?.relation, 'same_scope_continuation')
          assert.equal(captured.requestIntent?.action, action)
          assert.equal(captured.requestIntent?.unresolvedReason, 'task_operation_unresolved')
        }
        const guidance = request.messages.flatMap((message: any) => message.source?.sections ?? [])
          .filter((section: any) => section.name === 'on-demand-intake').at(-1)?.text
        assert.ok(guidance, 'the production adapter must supply current interpretation evidence')
        const bound = JSON.parse(guidance.split('advisory only):\n')[1]!.split('\n')[0]!)
        requiredRefs = bound.requiredReferences
        const context = createRequestIntentContext({ task, messageRefs: captured.requestIntent!.evidence.messageRefs.map(ref => ({ ...ref })), activeTask: bound.activeTask })!
        assert.deepEqual(requiredRefs, requestIntentReferenceIds(context))
        assert.equal(bound.activeTask.taskId, activeTask.taskId)
        await assertUnchangedAuthority()
        return mock.toolCallResponse('stale-preparation', TASK_PREPARE_TOOL, submission(action === 'unknown' ? 'verify' : action,
          requestIntentReferenceIds({ ...context, activeTask: { ...bound.activeTask, revision: activeTask.revision - 1 } })))
      }, async (request: any) => {
        const stale = resultFor(request, 'stale-preparation')
        assert.equal(stale.isError, true); assert.match(resultText(stale), /another request, stale revision/)
        await assertUnchangedAuthority()
        return mock.toolCallResponse('foreign-reference-preparation', TASK_PREPARE_TOOL,
          submission('verify', [...requiredRefs, 'foreign:another-session-reference']))
      }, async (request: any) => {
        const foreign = resultFor(request, 'foreign-reference-preparation')
        assert.equal(foreign.isError, true); assert.match(resultText(foreign), /another request, stale revision, or unknown proposal/)
        await assertUnchangedAuthority()
        return mock.toolCallResponse('unknown-preparation', TASK_PREPARE_TOOL, submission('unknown', requiredRefs))
      }, async (request: any) => {
        const unknown = resultFor(request, 'unknown-preparation')
        assert.equal(unknown.isError, false, resultText(unknown))
        assert.equal(JSON.parse(resultText(unknown)).prepared, false)
        assert.equal(JSON.parse(resultText(unknown)).status, 'awaiting_clarification')
        await assertUnchangedAuthority()
        return mock.toolCallResponse('missing-scope-preparation', TASK_PREPARE_TOOL, { requestIntent: {
          relation: 'same_scope_continuation', action: 'change', evidenceRefs: requiredRefs } })
      }, async (request: any) => {
        const missingScope = resultFor(request, 'missing-scope-preparation')
        assert.equal(missingScope.isError, false, resultText(missingScope))
        assert.equal(JSON.parse(resultText(missingScope)).prepared, false)
        assert.equal(JSON.parse(resultText(missingScope)).status, 'awaiting_clarification')
        await assertUnchangedAuthority()
        return mock.toolCallResponse('provider-preparation', TASK_PREPARE_TOOL, { taskType: requestedType })
      }, async (request: any) => {
        const prepared = resultFor(request, 'provider-preparation')
        if (semanticUnresolved) {
          assert.equal(prepared.isError, false, resultText(prepared))
          assert.equal(JSON.parse(resultText(prepared)).prepared, false)
          assert.equal(JSON.parse(resultText(prepared)).status, 'awaiting_clarification')
          await assertUnchangedAuthority()
          assert.equal(await runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM dsh_execution_owners').get()!.n), 0)
          checked = true
          return mock.textResponse('The action or artifact scope needs clarification.')
        }
        assert.equal(prepared.isError, false, resultText(prepared))
        const receipt = JSON.parse(resultText(prepared))
        assert.equal(receipt.prepared, true); assert.equal(receipt.permissions, 'unchanged_native_policy')
        assert.equal(receipt.originalTask, task); assert.equal(receipt.requestIntent.action, action)
        assert.equal(receipt.requestIntent.source, 'unresolved'); assert.equal(receipt.requestIntent.taskOperation, undefined)
        assert.equal(receipt.requestIntent.unresolvedReason, 'task_operation_unresolved')
        await assertUnchangedAuthority()
        return mock.toolCallResponse('adapter-read-current', 'kioku_read', { path: 'PLAN.md' })
      })
      if (!semanticUnresolved) responses.push(async (request: any) => {
        const read = resultFor(request, 'adapter-read-current')
        assert.equal(read.isError, false, resultText(read)); assert.match(resultText(read), /ADAPTER_CURRENT_TASK_SOURCE/)
        await assertUnchangedAuthority()
        assert.equal(await runtime.withDatabase(db => db.prepare('SELECT run_id FROM dsh_execution_owners WHERE dsh_session_id=?')
          .get(agent.session.id)!.run_id), activeTask.taskId)
        checked = true
        return mock.textResponse('The same current task remains selected.')
      })
      agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
      await agent.whenIdle()
      await Promise.all(idleClosures)
      await adapter.host.boundaryWorker?.whenIdle()
      if (semanticUnresolved) {
        assert.ok(idleClosures.length > 0, 'native idle lifecycle resolver must actually run')
        await assertUnchangedAuthority()
      }
      assert.deepEqual(errors, []); assert.equal(checked, true)
      assert.ok(requestBatches.some(batch => batch.questionIds.includes('request-task-operation')
        && (batch.task as any).activeTask?.taskId === activeTask.taskId && (batch.task as any).currentUserMessage === task))
      assert.equal(model.requests.length, semanticUnresolved ? 6 : 7)
      assert.equal(await runtime.withDatabase(db => db.prepare('SELECT count(*) n FROM dsh_coding_workflows').get()!.n), 0)
    } finally {
      await composition?.dispose(); await adapter?.dispose(); await handle?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }))
}
