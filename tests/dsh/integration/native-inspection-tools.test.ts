import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
isolateSkillHome()
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
for (const mode of ['unprepared', 'prepared', 'protected'] as const)
  test(
    `native inspection and session planning remain available for ${mode} review without file authority`,
    { timeout: 45000 },
    async () => {
      const load = (name: string) =>
        import(
          pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js'))
            .href
        )
      const hostPlugin = {
        name: 'inspection-fixture-tools',
        async apply(ctx: any) {
          for (const name of [
            'dsh-jobs-local',
            'dsh-tool-jobs',
            'dsh-tool-todo',
            'dsh-tool-subagent',
          ]) {
            const module = await load(name)
            await ctx.plugin(
              module.default ?? module,
              name === 'dsh-tool-jobs'
                ? { completionDelivery: 'quiet' }
                : name === 'dsh-tool-todo'
                  ? { allowParallelInProgress: false }
                  : name === 'dsh-tool-subagent'
                    ? { provider: 'spawn', modelDiscovery: true }
                    : {},
            )
          }
        },
      }
      const f = await nativeSkillFixture({ startupChoice: mode === 'protected' ? 'decision OFF / Lisp ON' : 'decision OFF / Lisp OFF',
        packages,
        ...(packageRoot ? { packageRoot } : {}),
        hostPlugin,
        extra: {
          typedDecisions: { mode: 'off' },
          answerReview: { mode: 'off' },
          memoryReview: { mode: 'off' },
          memoryEvolution: { mode: 'off' },
          memoryIndexReasoning: { mode: 'off' },
          deepPlanning: { enabled: false },
          modelAutoMode: { mode: 'off' },
          lisp: {
            enabled: mode === 'protected',
            executionMode: 'protected',
            sbclPath: process.env.KIOKUKO_LISP_SBCL,
            startupTimeoutMs: 15000,
          },
        },
        nativeAnswer: async (q) => ({
          answers: q.questions.map((q: any) => ({
            id: q.id,
            selected: [q.id === 'taskType' ? 'review' : '通常実行'],
          })),
        }),
      })
      let writes = 0
      try {
        const foreign = await f.ctx.agentLoop.create(
          'foreign-inspection',
          { provider: 'mock', model: 'qwen3-coder' },
          { cwd: f.dir },
        )
        const start = (owner: string, text: string) =>
          f.ctx.jobs.start({
            kind: 'fixture',
            label: 'inspection',
            owner,
            run(job: any) {
              job.append(text)
              let finish!: (value: { status: string }) => void
              return {
                done: new Promise((resolve) => {
                  finish = resolve
                }),
                cancel() {
                  finish({ status: 'killed' })
                },
              }
            },
          })
        const own = start(f.agent.id, 'OWN_BACKGROUND_OUTPUT'),
          other = start(foreign.id, 'FOREIGN_BACKGROUND_OUTPUT')
        f.ctx.tools.register({
          name: 'write',
          description: 'Counterexample mutation',
          parameters: { type: 'object', properties: {} },
          output: {
            schema: { type: 'number' },
            render: (_a: any, value: number) => [
              { type: 'text', text: String(value) },
            ],
          },
          async execute() {
            return ++writes
          },
        })
        f.ctx.tools.guard((e: any) =>
          e.name === 'job_output' && e.arguments.job_id === 'blocked'
            ? 'NATIVE_INSPECTION_DENIED'
            : undefined,
        )
        const result = (q: any, id: string) => {
          const r = nativeToolResults(q.messages).find(
            (r: any) => r.toolCallId === id,
          )
          assert.ok(r, id)
          return r
        }
        if (mode === 'protected') {
          const command = (
            await f.ctx.commands.execute(
              f.agent,
              '/kioku-lisp enable',
              [],
              new AbortController().signal,
            )
          ).result
          assert.equal(command.kind, 'success', command.text)
        }
        if (mode === 'prepared')
          f.responses.push(
            interpretedPreparation(
              f.mock,
              'prepare',
              'new',
              'verify',
              'review',
            ),
          )
        f.responses.push(
          (q: any) => {
            if (mode === 'prepared')
              assert.equal(
                toolValue(q, 'prepare').prepared,
                true,
                JSON.stringify(toolValue(q, 'prepare')),
              )
            return f.mock.toolCallResponse('todo', 'todo_write', {
              todos: [
                {
                  content: 'Review the code without changing files',
                  status: 'in_progress',
                },
              ],
            })
          },
          (q: any) => {
            assert.equal(
              result(q, 'todo').isError,
              false,
              JSON.stringify(result(q, 'todo')),
            )
            return f.mock.toolCallResponse('models', 'list_subagent_models', {})
          },
        )
        f.responses.push(
          (q: any) => {
            assert.equal(
              result(q, 'models').isError,
              false,
              JSON.stringify(result(q, 'models')),
            )
            return f.mock.toolCallResponse('list-jobs', 'job_list', {})
          },
          (q: any) => {
            const r = result(q, 'list-jobs')
            assert.equal(r.isError, false, JSON.stringify(r))
            assert.ok(!JSON.stringify(r).includes('FOREIGN_BACKGROUND_OUTPUT'))
            assert.ok(
              !JSON.stringify(r).includes(other),
              'Native job_list must not expose foreign jobs',
            )
            return f.mock.toolCallResponse('read-job', 'job_output', {
              job_id: own,
              wait: false,
            })
          },
          (q: any) => {
            const r = result(q, 'read-job')
            assert.equal(r.isError, false, JSON.stringify(r))
            assert.match(JSON.stringify(r), /OWN_BACKGROUND_OUTPUT/)
            return f.mock.toolCallResponse('foreign-job', 'job_output', {
              job_id: other,
            })
          },
          (q: any) => {
            const r = result(q, 'foreign-job')
            assert.equal(r.isError, true)
            assert.ok(!JSON.stringify(r).includes('FOREIGN_BACKGROUND_OUTPUT'))
            return f.mock.toolCallResponse('blocked-job', 'job_output', {
              job_id: 'blocked',
            })
          },
          (q: any) => {
            const r = result(q, 'blocked-job')
            assert.equal(r.isError, true)
            assert.match(JSON.stringify(r), /NATIVE_INSPECTION_DENIED/)
            return f.mock.toolCallResponse('write-attempt', 'write', {})
          },
          (q: any) => {
            assert.equal(result(q, 'write-attempt').isError, true)
            return f.mock.textResponse(
              'Read-only review completed; no project mutation.',
            )
          },
        )
        await f.turn(
          'このコードベースをレビュー。バックグラウンドの結果と利用可能モデルを調べ、ファイルは変更しない。',
        )
        assert.equal(writes, 0)
        assert.equal(
          f.agent.session
            .snapshotEvents()
            .filter((e: any) => e.type === 'todo/write').length,
          1,
        )
      } finally {
        await f.close()
      }
    },
  )
