import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openConnection } from '../../../src/db/connection.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
isolateSkillHome()
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const extra = {
  lisp: {
    enabled: true,
    executionMode: 'development',
    sbclPath: process.env.KIOKUKO_LISP_SBCL,
    startupTimeoutMs: 15000,
  },
  typedDecisions: { mode: 'off' },
  answerReview: { mode: 'off' },
  memoryReview: { mode: 'off' },
  memoryEvolution: { mode: 'off' },
  memoryIndexReasoning: { mode: 'off' },
  deepPlanning: { enabled: false },
  modelAutoMode: { mode: 'off' },
}
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT

for (const entry of [
  'web',
  ...(process.env.KIOKUKO_CLI_HOST_ROOT ? ['cli'] : []),
]) {
  const hostPlugin =
    entry === 'cli'
      ? await import(
          pathToFileURL(
            join(
              process.env.KIOKUKO_CLI_HOST_ROOT!,
              'src/dsh-adapter/plugin-host.ts',
            ),
          ).href
        )
      : undefined
  test(
    `${entry}: manual Lisp ON survives a saved pending coding choice at the next real model step`,
    { timeout: 45000 },
    async () => {
      const f = await nativeSkillFixture({
        packages,
        ...(packageRoot ? { packageRoot } : {}),
        hostPlugin,
        mode: 'compiled',
        extra,
        nativeAnswer: async () => {
          throw new Error('Manual ON must not ask again')
        },
      })
      try {
        const db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
        try {
          const task = 'Implement the old parser in src/parser.ts'
          const prepared = await prepareAgentTask(db, {
            requestId: 'old-coding-request',
            dshSessionId: f.agent.session.id,
            cwd: f.dir,
            task,
            profileHints: {
              taskType: 'build',
              target: 'src/parser.ts',
              expected: 'Parser works',
              constraints: 'No publishing',
            },
            capabilities: [],
            skillDiscoveryMode: 'off',
            completionMode: 'shadow',
          })
          initializeCodingWorkflow(db, {
            runId: prepared.run.runId,
            sessionId: f.agent.session.id,
            repositoryRoot: f.dir,
            requestId: 'old-coding-request',
            task,
          })
        } finally {
          db.close()
        }
        const enabled = (
          await f.ctx.commands.execute(
            f.agent,
            '/kioku-lisp enable',
            [],
            new AbortController().signal,
          )
        ).result
        assert.equal(enabled.kind, 'success', enabled.text)
        const state = JSON.parse(
          (
            await f.ctx.commands.execute(
              f.agent,
              '/kioku-lisp status --json',
              [],
              new AbortController().signal,
            )
          ).result.text,
        )
        assert.equal(state.enabled, true)
        assert.equal(state.state, 'READY')
        f.responses.push(
          (q: any) => {
            const section = q.messages
              .flatMap((message: any) => message.source?.sections ?? [])
              .find((value: any) => value.name === 'on-demand-intake')
            assert.match(
              section?.text ?? '',
              /Current request references and same-session work/,
              'An existing native task must retain source-bound host evidence',
            )
            assert.ok(
              q.tools.some((t: any) => t.name === 'lisp_eval'),
              'ON must publish the actual Lisp tool',
            )
            return f.mock.toolCallResponse('calculate', 'lisp_eval', {
              operationId: 'calculate',
              code: '(+ 40 2)',
            })
          },
          (q: any) => {
            const result = nativeToolResults(q.messages).find(
              (r: any) => r.toolCallId === 'calculate',
            )
            assert.ok(result)
            assert.equal(result.isError, false, JSON.stringify(result))
            assert.match(JSON.stringify(result), /42/)
            return f.mock.textResponse('42')
          },
        )
        await f.turn('40+2を計算してください。ファイルは変更しないで。')
        await f.reload('compiled')
        const stopped = JSON.parse(
          (
            await f.ctx.commands.execute(
              f.agent,
              '/kioku-lisp status --json',
              [],
              new AbortController().signal,
            )
          ).result.text,
        )
        assert.equal(stopped.state, 'RECOVERY_REQUIRED')
        const recovered = (
          await f.ctx.commands.execute(
            f.agent,
            '/kioku-lisp recover',
            [],
            new AbortController().signal,
          )
        ).result
        assert.equal(recovered.kind, 'success', recovered.text)
        f.responses.push(
          f.mock.toolCallResponse('after-restore', 'lisp_eval', {
            operationId: 'after-restore',
            code: '(+ 20 22)',
          }),
          (q: any) => {
            const result = nativeToolResults(q.messages).find(
              (r: any) => r.toolCallId === 'after-restore',
            )
            assert.ok(result)
            assert.equal(result.isError, false, JSON.stringify(result))
            assert.match(JSON.stringify(result), /42/)
            return f.mock.textResponse('42 after explicit recovery')
          },
        )
        await f.turn('20+22を計算してください。ファイルは変更しないで。')
      } finally {
        await f.close()
      }
    },
  )

  test(
    `${entry}: Lisp selected during admission is executable in the first model request`,
    { timeout: 45000 },
    async () => {
      let asked = 0
      const fibers: any[] = []
      const f = await nativeSkillFixture({
        packages,
        ...(packageRoot ? { packageRoot } : {}),
        hostPlugin,
        mode: 'compiled',
        extra,
        nativeAnswer: async (q) => {
          asked++
          assert.match(q.questions[0].id, /^lisp-early-/)
          return { answers: [{ id: q.questions[0].id, selected: ['使う'] }] }
        },
      })
      try {
        for (const name of [
          'dsh-subprocess-local',
          'dsh-bash-local',
          'dsh-shell-env',
          'dsh-tool-bash',
        ]) {
          const p = await import(
            pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js'))
              .href
          )
          fibers.push(
            await f.ctx.plugin(
              p.default ?? p,
              name === 'dsh-bash-local'
                ? { cwd: f.dir }
                : name === 'dsh-shell-env'
                  ? { dshHome: f.dir }
                  : {},
            ),
          )
        }
        f.responses.push(
          (q: any) => {
            const section = q.messages
              .flatMap((message: any) => message.source?.sections ?? [])
              .find((value: any) => value.name === 'on-demand-intake')
            assert.match(
              section?.text ?? '',
              /Current request references and same-session work/,
              'The first ON request must retain current host evidence after its actual turn starts',
            )
            const starts = f.agent.session
              .snapshotEvents()
              .filter((event: any) => event.type === 'turn/start')
            assert.equal(
              starts.length,
              1,
              'Evidence must follow exactly one real turn/start',
            )
            assert.ok(
              q.tools.some((t: any) => t.name === 'lisp_eval'),
              'First ON request must expose executable Lisp, not only shell tools',
            )
            return f.mock.toolCallResponse('first-lisp', 'lisp_eval', {
              operationId: 'first-lisp',
              code: '(+ 40 2)',
            })
          },
          (q: any) => {
            const result = nativeToolResults(q.messages).find(
              (r: any) => r.toolCallId === 'first-lisp',
            )
            assert.ok(result)
            assert.equal(result.isError, false, JSON.stringify(result))
            assert.match(JSON.stringify(result), /42/)
            return f.mock.toolCallResponse('direct-shell', 'bash', {
              command: 'printf 42',
              description: 'Check selected Lisp route',
            })
          },
          (q: any) => {
            const result = nativeToolResults(q.messages).find(
              (r: any) => r.toolCallId === 'direct-shell',
            )
            assert.ok(result)
            assert.equal(result.isError, true)
            assert.match(JSON.stringify(result), /LISP_ROUTE_REQUIRED/)
            return f.mock.toolCallResponse('lisp-process', 'lisp_eval', {
              operationId: 'lisp-process',
              code: `(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" "console.log(42)"))`,
            })
          },
          (q: any) => {
            const result = nativeToolResults(q.messages).find(
              (r: any) => r.toolCallId === 'lisp-process',
            )
            assert.ok(result)
            assert.equal(result.isError, false, JSON.stringify(result))
            assert.match(JSON.stringify(result), /42/)
            return f.mock.textResponse(
              '42 through Lisp and its real native process bridge',
            )
          },
        )
        await f.turn(
          'src/parser.ts の関数を実装して。まず40+2を計算して。外部公開しないで。',
        )
        assert.equal(asked, 1)
        const off = (
          await f.ctx.commands.execute(
            f.agent,
            '/kioku-lisp disable',
            [],
            new AbortController().signal,
          )
        ).result
        assert.equal(off.kind, 'success', off.text)
        f.responses.push(
          (q: any) => {
            assert.ok(!q.tools.some((t: any) => t.name === 'lisp_eval'))
            return f.mock.toolCallResponse('off-shell', 'bash', {
              command: 'printf 42',
              description: 'Calculate while Lisp is OFF',
            })
          },
          (q: any) => {
            const result = nativeToolResults(q.messages).find(
              (r: any) => r.toolCallId === 'off-shell',
            )
            assert.ok(result)
            assert.equal(result.isError, false, JSON.stringify(result))
            return f.mock.textResponse('42 with Lisp OFF')
          },
        )
        await f.turn(
          'printf 42で結果を読み取ってください。ファイルは変更しないで。',
        )
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        await f.close()
      }
    },
  )
}
