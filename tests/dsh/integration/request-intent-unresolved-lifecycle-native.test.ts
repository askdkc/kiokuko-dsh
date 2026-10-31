import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import { mountNativeExecutor } from '../helpers/native-tools.js'
/** Direct modular Core host lifecycle through real native queued turns. Only finite
 * provider answers and model generation are scripted; no external model runs. */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { DecisionBatch } from '../../../src/dsh/decisions/contracts.js'
import { TASK_WORKFLOW_SERVICE, type DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { readTaskSnapshot, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import { openConnection } from '../../../src/db/connection.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { nativeMock, nativeToolResults } from '../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const available = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) {
  throw new Error('Unresolved lifecycle tests require the configured native DSH package root')
}
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const signal = () => new AbortController().signal
const firstRequest = 'Verify the contents of PLAN.md. Target: PLAN.md. Expected: a concise explanation. Do not modify files.'
const nextRequest = 'Start a different change task for REPORT.md. Target: REPORT.md. Expected: revise the requested artifact. Its artifact scope still needs clarification.'
const authority = (task: TaskSnapshot) => ({ taskId: task.taskId, runId: task.runId, sessionId: task.sessionId,
  repositoryRoot: task.repositoryRoot, state: task.state, runStatus: task.runStatus, revision: task.revision, generation: task.generation })

for (const uncertain of ['change-scope', 'whole-intent'] as const) {
test(`direct Core queued ${uncertain} uncertainty preserves current authority during interpretation recovery`,
  { skip: !available, timeout: 30_000 }, async () => withIsolatedSkillHome(async () => {
  const providerModule = await import(packageRoot
    ? pathToFileURL(join(packageRoot, 'dist/dsh/decisions/laya-v1.js')).href : '../../../src/dsh/decisions/laya-v1.js')
  let clarificationQuestions = 0
  const providerCalls: Array<{ task: string; question: string }> = []
  // Patch only the provider inference boundary: actual DecisionService splitting,
  // result validation, classifier and direct Core host lifecycle remain active.
  const provider = mock.method(providerModule.LayaV1DecisionProvider.prototype, 'evaluate', async (batch: DecisionBatch) => {
    const task = typeof batch.state === 'string' ? batch.state : (batch.state as { currentUserMessage?: string }).currentUserMessage ?? ''
    const next = task === nextRequest
    return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'lifecycle-fixture',
      answers: batch.questions.map(question => {
        providerCalls.push({ task, question: question.id })
        const choiceId = question.id === 'task-type' ? next ? 'writing' : 'research'
          : question.id === 'request-relation' ? next ? uncertain === 'whole-intent' ? undefined : 'new' : 'same_scope_continuation'
            : question.id === 'request-action' ? next ? uncertain === 'whole-intent' ? undefined : 'change' : 'verify'
              : question.id.startsWith('request-proposal-') ? 'not_selected' : undefined
        return choiceId ? { id: question.id, status: 'selected' as const, choiceId }
          : { id: question.id, status: 'abstained' as const, reason: 'uncertain' as const }
      }) }
  })
  const coreModule = await import(packageRoot
    ? pathToFileURL(join(packageRoot, 'dist/dsh/core/host.js')).href : '../../../src/dsh/core/host.js')
  const modules = await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt',
    'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill', 'dsh-commands', 'dsh-fs-local', 'dsh-working-directory'].map(load))
  const [cordis, llm, sessions, projection, prompt, tools, agents, loop, skills, commands, fsLocal, workingDirectory] = modules
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'request-intent-core-lifecycle-')))
  const ctx = new cordis.Context(), fibers: any[] = [], errors: unknown[] = []
  let core: Awaited<ReturnType<typeof coreModule.mountCore>> | undefined, handle: any
  try {
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, 'PLAN.md'), 'PRESERVE_CURRENT_WORKING_TASK')
    for (const plugin of [fsLocal, workingDirectory, llm, sessions, projection, prompt, tools, agents, skills, commands]) {
      const config = plugin === fsLocal ? { cwd: dir } : plugin === workingDirectory ? { defaultDirectory: dir }
        : plugin === prompt ? { persona: '' } : undefined
      fibers.push(await ctx.plugin(plugin.default, config))
    }
    await mountNativeExecutor(ctx, process.env.KIOKUKO_DSH_PACKAGE_ROOT!, fibers)
    fibers.push(await ctx.plugin(loop.default, { agents: [] }))
    fibers.push(await ctx.plugin({ name: 'unresolved-lifecycle-questions', apply(context: any) {
      return context.provide('userQuestions', { async ask(request: any) {
if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, 'decision ON / Lisp OFF')

        clarificationQuestions += request.questions.filter((question: any) => question.id.startsWith('request-clarification-')).length
        return { answers: request.questions.map((question: any) => ({ id: question.id,
          selected: question.id.startsWith('request-clarification-') ? [] : [question.id === 'taskType' ? 'research' : question.id === 'target' ? 'PLAN.md'
            : question.id === 'expected' ? 'A concise explanation' : question.id === 'enno-execution-mode' ? '通常実行' : 'No unrelated changes'] })) }
      } })
    } }))
    ctx.on('agent/error', (event: any) => errors.push(event.error))
    const native = nativeMock(llm), responses: any[] = [], model = new native.MockAdapter(responses)
    ctx.llm.registerAdapter(['fixture'], model)
    core = await coreModule.mountCore(ctx, { repositoryRoot: dir, databasePath: join(dir, 'state.sqlite3'),
      intakeMode: 'on-demand', typedDecisions: { provider: 'laya-coreml',
        'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', socketPath: join(dir, 'unused-provider.sock') } },
      answerReview: { mode: 'off' }, memoryReuse: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
      semanticCompaction: { mode: 'off' }, modelAutoMode: { mode: 'off' } })
    handle = await ctx.agents.create({ sessionId: sessions.SessionId('unresolved-core-lifecycle'),
      agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: dir } })
    const f = { ctx, agent: handle.agent, dir, llm, responses, mock: native,
      async turn(input: string) {
        handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input }] }))
        await handle.agent.whenIdle()
        assert.deepEqual(errors, [])
      } }
    const workflow = ctx.get(TASK_WORKFLOW_SERVICE, false) as DshTaskWorkflow
    const created = await workflow.operate(f.agent, { operation: 'create', taskType: 'research', request: firstRequest }, signal())
    await workflow.operate(f.agent, { operation: 'start', expected: created }, signal())
    const readCurrent = () => {
      const db = openConnection(join(f.dir, 'state.sqlite3'))
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n, 1)
        return readTaskSnapshot(db, { taskId: created.taskId, sessionId: f.agent.session.id, repositoryRoot: f.dir })
      } finally { db.close() }
    }
    const resultFor = (request: any, id: string) => {
      const result = nativeToolResults(request.messages).find(result => result.toolCallId === id)
      assert.ok(result, `native result ${id} must exist`)
      return result
    }
    const text = (result: any) => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
    let working: TaskSnapshot | undefined, rejected = false
    f.responses.push(f.mock.toolCallResponse('first-prepare', 'prepare_requested_work', { taskType: 'review' }),
      (request: any) => {
        const prepared = resultFor(request, 'first-prepare')
        assert.equal(prepared.isError, false, text(prepared))
        // This provider deliberately abstains on semantic checks in both turns.
        // Count each distinct user request, not both requests as one question.
        assert.equal(JSON.parse(text(prepared)).prepared, false)
        assert.equal(JSON.parse(text(prepared)).status, 'awaiting_clarification')
        assert.equal(clarificationQuestions, 1)
        working = readCurrent()
        assert.equal(working.state, 'Working'); assert.equal(working.runStatus, 'active')
        // A queued human follow-up creates a genuine next native turn, without
        // an idle interval that would independently finalize the current task.
        f.agent.followup(f.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: nextRequest }] }))
        return f.mock.textResponse('The inspection step has reached its native turn boundary.')
      }, (request: any) => {
        assert.ok(f.agent.session.snapshotEvents().some((event: any) => event.type === 'turn/end'
          && event.data.turn === 1 && event.data.reason.kind === 'completed'), 'first native turn actually completed')
        assert.deepEqual(authority(readCurrent()), authority(working!), 'uncertain new artifact scope must not retire the current task')
        const guidance = request.messages.flatMap((message: any) => message.source?.sections ?? [])
          .filter((section: any) => section.name === 'on-demand-intake').at(-1)?.text
        const bound = JSON.parse(guidance.split('advisory only):\n')[1]!.split('\n')[0]!)
        assert.equal(bound.decision.relation, uncertain === 'whole-intent' ? 'unknown' : 'new')
        assert.equal(bound.decision.action, uncertain === 'whole-intent' ? 'unknown' : 'change')
        assert.equal(bound.decision.taskOperation, undefined)
        assert.equal(bound.decision.source, 'unresolved'); assert.equal(bound.activeTask.taskId, working!.taskId)
        return f.mock.toolCallResponse('uncertain-next-prepare', 'prepare_requested_work', { taskType: 'writing' })
      }, (request: any) => {
        const result = resultFor(request, 'uncertain-next-prepare')
        assert.equal(result.isError, false, text(result))
        assert.equal(JSON.parse(text(result)).prepared, false)
        assert.equal(JSON.parse(text(result)).status, 'awaiting_clarification')
        assert.equal(JSON.parse(text(result)).nextAction, 'wait_for_user')
        assert.equal(clarificationQuestions, 2, 'one question per distinct native user request; no same-request repeat')
        assert.deepEqual(authority(readCurrent()), authority(working!))
        rejected = true
        return f.mock.textResponse('Wait for the user to clarify the concrete target and action before changing the active work.')
      })
    await f.turn(firstRequest)
    console.info(`Core ${uncertain} immediate idle:`, JSON.stringify(authority(readCurrent())))
    // Native status delivery is asynchronous. Drain it before recording the
    // final-idle outcome separately from the before-preparation invariant.
    await core.drain()
    console.info(`Core ${uncertain} settled idle:`, JSON.stringify(authority(readCurrent())))
    assert.deepEqual(authority(readCurrent()), authority(working!), 'dismissed clarification preserves current work through settled idle')
    assert.equal(rejected, true)
    assert.equal(await readFile(join(dir, 'PLAN.md'), 'utf8'), 'PRESERVE_CURRENT_WORKING_TASK')
    assert.equal(existsSync(join(dir, 'REPORT.md')), false)
    assert.ok(providerCalls.some(call => call.task === nextRequest && call.question === 'request-task-operation'))
    if (uncertain === 'change-scope') assert.ok(providerCalls.some(call => call.task === nextRequest && call.question === 'request-change-scope'))
  } finally {
    await core?.dispose(); await handle?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    provider.mock.restore()
  }
}))
}
