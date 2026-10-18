/** Direct Core + native question service/model loop/owned effects. Provider and
 * model answers and the human UI response are scripted; no external model runs. */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { DecisionBatch } from '../../../src/dsh/decisions/contracts.js'
import { TASK_WORKFLOW_SERVICE, type DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { readTaskSnapshot, taskCanExecute, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import { openConnection } from '../../../src/db/connection.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { nativeMock, nativeToolResults } from '../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const available = existsSync(join(packages, '@deepseek-ai/dsh-user-questions/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) {
  throw new Error('Clarification tests require the configured native DSH package root')
}
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
const signal = () => new AbortController().signal
const firstRequest = 'Verify the contents of PLAN.md. Target: PLAN.md. Expected: a concise explanation. Do not modify files.'
const ambiguousRequest = 'Continue this task and change PLAN.md. Target: PLAN.md. Expected: update the requested artifact. Clarify which kind of artifact before making changes.'
const clarifiedAnswer = 'Only update the prose summary in PLAN.md; document scope. Continue the same current task.'
const originalContent = 'ORIGINAL_CLARIFICATION_CONTENT'
const updatedContent = 'USER_CLARIFIED_DOCUMENT_UPDATE'
const authority = (task: TaskSnapshot) => ({ taskId: task.taskId, runId: task.runId, sessionId: task.sessionId,
  repositoryRoot: task.repositoryRoot, state: task.state, runStatus: task.runStatus, revision: task.revision, generation: task.generation })
const resultText = (result: any) => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
const resultFor = (request: any, id: string) => {
  const result = nativeToolResults(request.messages).find(result => result.toolCallId === id)
  assert.ok(result, `native result ${id} must exist`)
  return result
}
const boundIntent = (request: any) => {
  const text = request.messages.flatMap((message: any) => message.source?.sections ?? [])
    .filter((section: any) => section.name === 'on-demand-intake').at(-1)?.text
  assert.ok(text, 'current native turn must carry source-bound interpretation')
  return JSON.parse(text.split('advisory only):\n')[1]!.split('\n')[0]!)
}

for (const scenario of ['answered', 'target-answered', 'dismissed', 'stopped', 'stale', 'foreign-answer'] as const) {
  test(`direct Core native semantic clarification: ${scenario}`, { skip: !available, timeout: 30_000 },
    async () => withIsolatedSkillHome(async () => {
    const providerModule = await import(packageRoot
      ? pathToFileURL(join(packageRoot, 'dist/dsh/decisions/laya-v1.js')).href : '../../../src/dsh/decisions/laya-v1.js')
    const coreModule = await import(packageRoot
      ? pathToFileURL(join(packageRoot, 'dist/dsh/core/host.js')).href : '../../../src/dsh/core/host.js')
    const answeredScenario = scenario === 'answered' || scenario === 'target-answered'
    const requested = scenario === 'target-answered' ? 'Change that.' : ambiguousRequest
    const providerMessages: string[] = []
    const inference = mock.method(providerModule.LayaV1DecisionProvider.prototype, 'evaluate', async (batch: DecisionBatch) => {
      const task = typeof batch.state === 'string' ? batch.state : (batch.state as { currentUserMessage?: string }).currentUserMessage ?? ''
      const first = task === firstRequest, answered = task.includes(clarifiedAnswer)
      providerMessages.push(task)
      return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'clarification-fixture',
        answers: batch.questions.map(question => {
          const choiceId = question.id === 'task-type' ? first ? 'research' : 'writing'
            : question.id === 'request-relation' ? !first && !answered && scenario === 'target-answered' ? 'scope_change' : 'same_scope_continuation'
              : question.id === 'request-action' ? first ? 'verify' : 'change'
                : question.id === 'request-change-scope' && (answered || scenario === 'target-answered') ? 'document'
                  : question.id.startsWith('request-proposal-') ? 'not_selected' : undefined
          return choiceId ? { id: question.id, status: 'selected' as const, choiceId }
            : { id: question.id, status: 'abstained' as const, reason: 'uncertain' as const }
        }) }
    })
    const modules = await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt',
      'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill', 'dsh-commands', 'dsh-fs-local', 'dsh-working-directory', 'dsh-user-questions'].map(load))
    const [cordis, llm, sessions, projection, prompt, tools, agents, loop, skills, commands, fsLocal, workingDirectory, questions] = modules
    const dir = realpathSync(await mkdtemp(join(tmpdir(), 'request-clarification-core-'))), databasePath = join(dir, 'state.sqlite3')
    const ctx = new cordis.Context(), fibers: any[] = [], errors: unknown[] = [], asked: any[] = []
    let core: Awaited<ReturnType<typeof coreModule.mountCore>> | undefined, handle: any, release: (() => void) | undefined
    let questionObserved!: () => void
    const questionReady = new Promise<void>(resolve => { questionObserved = resolve })
    let working: TaskSnapshot | undefined, checked = false
    try {
      await mkdir(join(dir, '.git'))
      await writeFile(join(dir, 'PLAN.md'), originalContent)
      for (const plugin of [fsLocal, workingDirectory, llm, sessions, projection, prompt, tools, agents, skills, commands, questions]) {
        const config = plugin === fsLocal ? { cwd: dir } : plugin === workingDirectory ? { defaultDirectory: dir }
          : plugin === prompt ? { persona: '' } : undefined
        fibers.push(await ctx.plugin(plugin.default, config))
      }
      fibers.push(await ctx.plugin(loop.default, { agents: [] }))
      ctx.on('agent/error', (event: any) => errors.push(event.error))
      const native = nativeMock(llm), responses: any[] = [], model = new native.MockAdapter(responses)
      ctx.llm.registerAdapter(['fixture'], model)
      core = await coreModule.mountCore(ctx, { repositoryRoot: dir, databasePath,
        intakeMode: 'on-demand', typedDecisions: { provider: 'laya-coreml',
          'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', socketPath: join(dir, 'unused-provider.sock') } },
        answerReview: { mode: 'off' }, memoryReuse: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
        semanticCompaction: { mode: 'off' }, modelAutoMode: { mode: 'off' } })
      handle = await ctx.agents.create({ sessionId: sessions.SessionId(`clarification-${scenario}`),
        agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: dir } })
      const agent = handle.agent, workflow = ctx.get(TASK_WORKFLOW_SERVICE, false) as DshTaskWorkflow
      agent.ctx.on('user-questions/request', (request: any) => {
        const question = request.questions[0]
        assert.equal(request.agent, agent, 'native question must target the exact live primary agent')
        if (!question.id.startsWith('request-clarification-')) return { answers: [{ id: question.id,
          selected: [question.id === 'taskType' ? 'research' : question.id === 'target' ? 'PLAN.md'
            : question.id === 'expected' ? 'A concise explanation' : '通常実行'] }] }
        asked.push(request)
        if (scenario === 'target-answered') assert.match(question.question, /具体的|対象/)
        else assert.match(question.question, /文章|コード|設定/)
        assert.equal(request.questions.length, 1, 'ask only the unresolved semantic question')
        questionObserved()
        if (scenario === 'dismissed') return { answers: [{ id: question.id, selected: [] }] }
        const answer = { answers: [{ id: scenario === 'foreign-answer' ? 'request-clarification-another-task' : question.id, selected: [], custom: clarifiedAnswer }] }
        if (answeredScenario || scenario === 'foreign-answer') return answer
        return new Promise(resolve => { release = () => resolve(answer) })
      })
      const created = await workflow.operate(agent, { operation: 'create', taskType: 'research', request: firstRequest }, signal())
      await workflow.operate(agent, { operation: 'start', expected: created }, signal())
      const database = <T>(read: (db: ReturnType<typeof openConnection>) => T): T => {
        const db = openConnection(databasePath)
        try { return read(db) } finally { db.close() }
      }
      const readCurrent = () => database(db => {
        assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n, 1)
        return readTaskSnapshot(db, { taskId: created.taskId, sessionId: agent.session.id, repositoryRoot: dir })
      })
      const assertUnchanged = () => assert.deepEqual(authority(readCurrent()), authority(working!))
      let oldRefs: string[] = [], clarifiedEvidence: unknown
      responses.push(native.toolCallResponse('first-prepare', 'prepare_requested_work', { taskType: 'review' }),
        (request: any) => {
          const prepared = resultFor(request, 'first-prepare')
          assert.equal(prepared.isError, false, resultText(prepared))
          working = readCurrent()
          assert.equal(working.state, 'Working'); assert.equal(working.runStatus, 'active')
          agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: requested }] }))
          return native.textResponse('The first inspection is complete; the current task remains selected.')
        }, (request: any) => {
          const bound = boundIntent(request)
          assert.equal(bound.decision.action, 'change')
          assert.equal(bound.decision.taskOperation, undefined)
          assertUnchanged()
          oldRefs = bound.requiredReferences
          return native.toolCallResponse('clarify-preparation', 'prepare_requested_work', { taskType: 'writing' })
        }, (request: any) => {
          const prepared = resultFor(request, 'clarify-preparation')
          assert.equal(prepared.isError, false, resultText(prepared))
          const value = JSON.parse(resultText(prepared))
          assert.equal(value.prepared, false)
          assert.equal(value.status, answeredScenario ? 'clarification_answer_queued'
            : scenario === 'stale' ? 'clarification_context_changed' : 'awaiting_clarification')
          assert.equal(asked.length, 1)
          if (scenario === 'stale') {
            assert.equal(readCurrent().revision, working!.revision + 1)
            checked = true
            return native.textResponse('The previous question no longer matches current task authority.')
          }
          assertUnchanged()
          return native.toolCallResponse('repeat-clarify-preparation', 'prepare_requested_work', { taskType: 'writing' })
        }, (request: any) => {
          const repeated = resultFor(request, 'repeat-clarify-preparation')
          assert.equal(repeated.isError, false, resultText(repeated))
          assert.equal(JSON.parse(resultText(repeated)).prepared, false)
          assert.equal(asked.length, 1, 'repeated preparation must not repeatedly ask the same question')
          assertUnchanged()
          checked = true
          return native.textResponse('Waiting for clarification before making any changes.')
        })
      if (answeredScenario) responses.push((request: any) => {
        const bound = boundIntent(request)
        assert.equal(bound.decision.relation, 'same_scope_continuation')
        assert.equal(bound.decision.action, 'change')
        assert.equal(bound.activeTask.taskId, working!.taskId)
        clarifiedEvidence = bound.decision.evidence
        assert.notDeepEqual(bound.requiredReferences, oldRefs, 'answer must be recaptured with fresh current-message refs')
        assertUnchanged()
        assert.ok(agent.session.snapshotEvents().some((event: any) => event.type === 'user/message'
          && event.data.source?.kind === 'user' && JSON.stringify(event.data.content).includes(clarifiedAnswer)
          && JSON.stringify(event.data.content).includes(requested)), 'clarification preserves the original request and actual answer as genuine user input')
        return native.toolCallResponse('answered-preparation', 'prepare_requested_work', { taskType: 'writing' })
      }, (request: any) => {
        const prepared = resultFor(request, 'answered-preparation')
        assert.equal(prepared.isError, false, resultText(prepared)); assert.equal(JSON.parse(resultText(prepared)).prepared, true)
        assert.equal(JSON.parse(resultText(prepared)).requestIntent.changeScope, 'document')
        assert.deepEqual(JSON.parse(resultText(prepared)).requestIntent.evidence, clarifiedEvidence)
        assertUnchanged(); assert.equal(asked.length, 1)
        return native.toolCallResponse('answered-write', 'kioku_write', { path: 'PLAN.md', content: updatedContent })
      }, async (request: any) => {
        const written = resultFor(request, 'answered-write')
        assert.equal(written.isError, false, resultText(written))
        assert.equal(await readFile(join(dir, 'PLAN.md'), 'utf8'), updatedContent)
        assertUnchanged()
        assert.equal(database(db => db.prepare('SELECT run_id FROM dsh_owned_operations').get()!.run_id), working!.runId)
        return native.textResponse('The clarified document update was completed in the same task.')
      })
      agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: firstRequest }] }))
      if (scenario === 'stopped' || scenario === 'stale') {
        await Promise.race([questionReady, agent.whenIdle().then(() => { assert.ok(release, `semantic clarification must ask the native user: ${errors.map(String).join('; ')}`) })])
        assertUnchanged()
        assert.equal(await readFile(join(dir, 'PLAN.md'), 'utf8'), originalContent)
        if (scenario === 'stopped') agent.cancel({ kind: 'user' })
        else {
          // Fault injection: a concurrent authority revision invalidates the
          // already-presented question. No inference grants a replacement lease.
          database(db => db.prepare('UPDATE ledger_runs SET task_revision=task_revision+1,task_generation=task_generation+1 WHERE run_id=?').run(created.taskId))
        }
        release!()
      }
      await agent.whenIdle()
      await core.drain()
      assert.deepEqual(errors, [])
      if (scenario === 'stopped') {
        assert.ok(agent.session.snapshotEvents().some((event: any) => event.type === 'turn/end'
          && event.data.reason?.kind === 'aborted'), 'actual native user Stop reaches its aborted boundary')
        assert.equal(taskCanExecute(readCurrent()), false, 'stopped work has no executable authority')
      }
      assert.equal(asked.length, 1, 'a single unresolved scope gets a single native question')
      if (answeredScenario || scenario === 'dismissed' || scenario === 'foreign-answer') {
        assert.deepEqual(errors, []); assert.equal(checked, true)
      }
      if (answeredScenario) assert.ok(providerMessages.some(task => task.includes(clarifiedAnswer)))
      else {
        assert.equal(await readFile(join(dir, 'PLAN.md'), 'utf8'), originalContent)
        assert.equal(database(db => db.prepare('SELECT count(*) n FROM dsh_owned_operations').get()!.n), 0)
        assert.ok(!providerMessages.some(task => task.includes(clarifiedAnswer)), 'stale/Stop/dismissed answers cannot enqueue resumed work')
        if (scenario === 'dismissed' || scenario === 'foreign-answer') assertUnchanged()
      }
    } finally {
      release?.()
      await core?.dispose(); await handle?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      inference.mock.restore()
    }
  }))
}
