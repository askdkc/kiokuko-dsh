import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
/** Public plugin entry -> full adapter -> actual native questions and owned write.
 * Finite inference, native generation and human UI replies are scripted. Idle
 * listener/worker instrumentation calls through unchanged and only observes drain. */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DecisionBatch } from '../../../src/dsh/decisions/contracts.js'
import { TASK_WORKFLOW_SERVICE, type DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { readTaskSnapshot, type TaskSnapshot } from '../../../src/dsh/task-state.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { assertNativeDecisionDiagnostics } from '../helpers/decision-diagnostics.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const available = existsSync(join(packages, '@deepseek-ai/dsh-user-questions/lib/index.js'))
if (!available && (process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) {
  throw new Error('Public clarification tests require the configured native DSH package root')
}
const firstRequest = 'Verify the contents of PLAN.md. Target: PLAN.md. Expected: a concise explanation. Do not modify files.'
const ambiguousRequest = 'Continue this task and change PLAN.md. Target: PLAN.md. Expected: update the requested artifact. Clarify which kind of artifact before making changes.'
const answer = 'Only update the prose summary in PLAN.md; document scope. Continue the same current task.'
const original = 'PUBLIC_ADAPTER_ORIGINAL', updated = 'PUBLIC_ADAPTER_USER_CLARIFIED_UPDATE'
const signal = () => new AbortController().signal
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
  assert.ok(text)
  return JSON.parse(text.split('advisory only):\n')[1]!.split('\n')[0]!)
}

for (const scenario of ['answered', 'dismissed', 'foreign-answer'] as const) {
  const answered = scenario === 'answered'
  test(`public adapter semantic clarification: ${answered ? 'answer resumes same work' : scenario === 'foreign-answer' ? 'foreign question answer cannot resume work' : 'dismissal retains settled idle work'}`,
    { skip: !available, timeout: 30_000 }, async () => withIsolatedSkillHome(async () => {
    const providerModule = await import(packageRoot
      ? pathToFileURL(join(packageRoot, 'dist/dsh/decisions/laya-v1.js')).href : '../../../src/dsh/decisions/laya-v1.js')
    const boundaryModule = await import(packageRoot
      ? pathToFileURL(join(packageRoot, 'dist/dsh/boundary-worker.js')).href : '../../../src/dsh/boundary-worker.js')
    const cordis = await import(pathToFileURL(join(packages, '@deepseek-ai/cordis/lib/index.js')).href)
    const classified: string[] = [], idlePromises: Promise<unknown>[] = [], workers = new Set<any>()
    let idleCalls = 0
    const originalOn = cordis.EventsService.prototype.on
    const observeIdle = mock.method(cordis.EventsService.prototype, 'on', function (this: any, name: any, listener: any, options: any) {
      if (name !== 'agent/status') return originalOn.call(this, name, listener, options)
      return originalOn.call(this, name, function (this: any, ...args: any[]) {
        const result = listener.apply(this, args)
        if (args[0]?.status === 'idle') {
          idleCalls++
          if (result?.then) idlePromises.push(Promise.resolve(result))
        }
        return result
      }, options)
    })
    const originalKick = boundaryModule.DshBoundaryWorker.prototype.kick
    const observeWorker = mock.method(boundaryModule.DshBoundaryWorker.prototype, 'kick', function (this: any, ...args: any[]) {
      workers.add(this)
      return originalKick.apply(this, args)
    })
    const inference = mock.method(providerModule.LayaV1DecisionProvider.prototype, 'evaluate', async (batch: DecisionBatch) => {
      const task = typeof batch.state === 'string' ? batch.state : (batch.state as { currentUserMessage?: string; source?: {task:string} }).currentUserMessage ?? (batch.state as {source?:{task:string}}).source?.task ?? ''
      const first = task === firstRequest, clarified = task.includes(answer)
      classified.push(task)
      return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'public-clarification-fixture',
        answers: batch.questions.map(question => {
          const choiceId = question.id.startsWith('semantic-') ? 'supported' : question.id === 'task-type' ? first ? 'research' : 'writing'
            : question.id === 'request-relation' ? 'same_scope_continuation'
              : question.id === 'request-action' ? first ? 'verify' : 'change'
                : question.id === 'request-change-scope' && clarified ? 'document'
                  : question.id.startsWith('request-proposal-') ? 'not_selected' : undefined
          return choiceId ? { id: question.id, status: 'selected' as const, choiceId }
            : { id: question.id, status: 'abstained' as const, reason: 'uncertain' as const }
        }) }
    })
    let fixture: Awaited<ReturnType<typeof nativeSkillFixture>> | undefined
    const asked: any[] = []
    try {
      const f = fixture = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}),
        extra: { lisp: { enabled: false }, typedDecisions: { provider: 'laya-coreml',
          'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } }, answerReview: { mode: 'off' }, memoryReuse: { mode: 'off' },
          memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
          semanticCompaction: { mode: 'off' }, modelAutoMode: { mode: 'off' }, toolExposure: { mode: 'full' } },
        async nativeAnswer(request) {
if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, 'decision ON / Lisp OFF')

          const question = request.questions[0]
          if (!question.id.startsWith('request-clarification-')) return { answers: [{ id: question.id,
            selected: [question.id === 'taskType' ? 'research' : question.id === 'target' ? 'PLAN.md'
              : question.id === 'expected' ? 'A concise explanation' : '通常実行'] }] }
          asked.push(request)
          assert.equal(request.agent, fixture!.agent)
          assert.equal(request.questions.length, 1); assert.match(question.question, /文章|コード|設定/)
          return { answers: [{ id: scenario === 'foreign-answer' ? 'request-clarification-another-task' : question.id, selected: [], ...(answered || scenario === 'foreign-answer' ? { custom: answer } : {}) }] }
        } })
      await writeFile(join(f.dir, 'PLAN.md'), original)
      const workflow = f.ctx.get(TASK_WORKFLOW_SERVICE, false) as DshTaskWorkflow
      const created = await workflow.operate(f.agent, { operation: 'create', taskType: 'research', request: firstRequest }, signal())
      await workflow.operate(f.agent, { operation: 'start', expected: created }, signal())
      const database = <T>(read: (db: ReturnType<typeof openConnection>) => T): T => {
        const db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
        try { return read(db) } finally { db.close() }
      }
      const readCurrent = () => database(db => {
        assert.equal(db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n, 1,
          `one original run must remain: ${JSON.stringify(db.prepare('SELECT run_id,title,status,task_state,task_revision,task_generation FROM ledger_runs').all())}`)
        return readTaskSnapshot(db, { taskId: created.taskId, sessionId: f.agent.session.id, repositoryRoot: f.dir })
      })
      let working: TaskSnapshot | undefined, oldRefs: string[] = [], clarifiedEvidence: unknown, wrote = false
      const unchanged = () => assert.deepEqual(authority(readCurrent()), authority(working!))
      f.responses.push(f.mock.toolCallResponse('first-prepare', 'prepare_requested_work', { taskType: 'review' }),
        (request: any) => {
          const prepared = resultFor(request, 'first-prepare')
          assert.equal(prepared.isError, false, resultText(prepared))
          working = readCurrent(); assert.equal(working.state, 'Working'); assert.equal(working.runStatus, 'active')
          f.agent.followup(f.llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: ambiguousRequest }] }))
          return f.mock.textResponse('The inspection reached its native boundary.')
        }, (request: any) => {
          const bound = boundIntent(request)
          oldRefs = bound.requiredReferences
          assert.equal(bound.decision.action, 'change'); assert.equal(bound.activeTask.taskId, working!.taskId)
          unchanged()
          return f.mock.toolCallResponse('ask-before-change', 'prepare_requested_work', { taskType: 'writing' })
        }, async (request: any) => {
          const prepared = resultFor(request, 'ask-before-change')
          assert.equal(prepared.isError, false, resultText(prepared))
          const value = JSON.parse(resultText(prepared))
          assert.equal(value.prepared, false)
          assert.equal(value.status, answered ? 'clarification_answer_queued' : 'awaiting_clarification')
          assert.equal(asked.length, 1, `clarification ask count: ${JSON.stringify(asked.map(request => request.questions))}`); unchanged()
          assert.equal(await readFile(join(f.dir, 'PLAN.md'), 'utf8'), original)
          assert.equal(database(db => db.prepare('SELECT count(*) n FROM dsh_owned_operations').get()!.n), 0)
          return f.mock.toolCallResponse('repeat-question', 'prepare_requested_work', { taskType: 'writing' })
        }, (request: any) => {
          const repeated = resultFor(request, 'repeat-question')
          assert.equal(repeated.isError, false, resultText(repeated)); assert.equal(JSON.parse(resultText(repeated)).prepared, false)
          assert.equal(asked.length, 1, `clarification ask count: ${JSON.stringify(asked.map(request => request.questions))}`); unchanged()
          return f.mock.textResponse('Waiting for the exact requested clarification.')
        })
      if (answered) f.responses.push((request: any) => {
        const bound = boundIntent(request)
        assert.equal(bound.decision.relation, 'same_scope_continuation'); assert.equal(bound.decision.action, 'change')
        assert.equal(bound.activeTask.taskId, working!.taskId)
        assert.notDeepEqual(bound.requiredReferences, oldRefs)
        clarifiedEvidence = bound.decision.evidence
        assert.ok(f.agent.session.snapshotEvents().some((event: any) => event.type === 'user/message'
          && event.data.source?.kind === 'user' && JSON.stringify(event.data.content).includes(answer)
          && JSON.stringify(event.data.content).includes(ambiguousRequest)), 'actual user answer and original request must both reach fresh native capture')
        unchanged()
        return f.mock.toolCallResponse('resume-same-work', 'prepare_requested_work', { taskType: 'writing' })
      }, (request: any) => {
        const prepared = resultFor(request, 'resume-same-work')
        assert.equal(prepared.isError, false, resultText(prepared))
        const value = JSON.parse(resultText(prepared))
        assert.equal(value.prepared, true); assert.equal(value.requestIntent.changeScope, 'document')
        assert.deepEqual(value.requestIntent.evidence, clarifiedEvidence)
        unchanged(); assert.equal(asked.length, 1, `clarification ask count: ${JSON.stringify(asked.map(request => request.questions))}`)
        return f.mock.toolCallResponse('clarified-write', 'kioku_write', { path: 'PLAN.md', content: updated })
      }, async (request: any) => {
        const written = resultFor(request, 'clarified-write')
        assert.equal(written.isError, false, resultText(written))
        assert.equal(await readFile(join(f.dir, 'PLAN.md'), 'utf8'), updated)
        assert.equal(database(db => db.prepare('SELECT run_id FROM dsh_owned_operations').get()!.run_id), working!.runId)
        unchanged(); wrote = true
        return f.mock.textResponse('The clarified document edit is complete.')
      })
      await f.turn(firstRequest)
      assert.ok(idleCalls > 0, 'actual public adapter receives native idle notifications')
      // Observe the real native listeners and worker queues to completion;
      // no synthetic idle event or substituted resolver establishes this result.
      await Promise.all(idlePromises)
      await Promise.all([...workers].map(worker => worker.whenIdle()))
      assert.equal(asked.length, 1, `clarification ask count: ${JSON.stringify(asked.map(request => request.questions))}`)
      database(db=>assertNativeDecisionDiagnostics(db,f.agent.session.id,answered))
      if (answered) { assert.equal(wrote, true); assert.ok(classified.some(task => task.includes(answer))) }
      else {
        unchanged()
        assert.equal(await readFile(join(f.dir, 'PLAN.md'), 'utf8'), original)
        assert.equal(database(db => db.prepare('SELECT count(*) n FROM dsh_owned_operations').get()!.n), 0)
        assert.ok(!classified.some(task => task.includes(answer)))
      }
    } finally {
      await fixture?.close()
      inference.mock.restore(); observeWorker.mock.restore(); observeIdle.mock.restore()
    }
  }))
}
