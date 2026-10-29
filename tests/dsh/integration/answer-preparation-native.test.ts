/** Real DSH model loop, file tools and SBCL; generation is scripted and uses no paid provider. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { openConnection } from '../../../src/db/connection.js'
isolateSkillHome()
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
for (const lisp of [false, true])
  test(
    `answer preparation reaches permitted ${lisp ? 'Lisp' : 'native'} evidence reads without a clarification or new owner`,
    { timeout: 60000 },
    async () => {
      const f = await nativeSkillFixture({
        packages,
        ...(process.env.KIOKUKO_SKILL_PACKAGE_ROOT
          ? { packageRoot: process.env.KIOKUKO_SKILL_PACKAGE_ROOT }
          : {}),
        explicit: true,
        extra: {
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
          deepPlanning: { enabled: false },
          modelAutoMode: { mode: 'off' },
        },
        nativeAnswer: async () => {
          throw new Error(
            'An established explanatory request must not ask for its action again',
          )
        },
      })
      const fibers: any[] = []
      const marker = 'REAL_ANSWER_EVIDENCE'
      let checked = false
      try {
        await writeFile(join(f.dir, 'PLAN.md'), marker)
        for (const name of lisp
          ? [
              'dsh-subprocess-local',
              'dsh-bash-local',
              'dsh-shell-env',
              'dsh-tool-bash',
            ]
          : ['dsh-fs-observation-policy', 'dsh-tool-fs']) {
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
        if (lisp) {
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
        const locate = (q: any, id: string) => {
          const r = nativeToolResults(q.messages).find(
            (r) => r.toolCallId === id,
          )
          assert.ok(r, id)
          return r
        }
        if (lisp)
          f.responses.push(
            f.mock.toolCallResponse('route-denied', 'bash', {
              command: 'pwd',
              description: 'Check the evidence location',
            }),
          )
        f.responses.push(
          (q: any) => {
            if (lisp) {
              const denied = locate(q, 'route-denied')
              assert.equal(denied.isError, true)
              assert.match(
                JSON.stringify(denied.content),
                /LISP_ROUTE_REQUIRED/,
              )
            }
            const section = q.messages
              .flatMap((m: any) => m.source?.sections ?? [])
              .filter((s: any) => s.name === 'on-demand-intake')
              .at(-1)
            assert.ok(section)
            const context = JSON.parse(
              section.text.split('advisory only):\n')[1].split('\n')[0],
            )
            return f.mock.toolCallResponse(
              'prepare-answer',
              'prepare_requested_work',
              {
                taskType: 'research',
                requestIntent: {
                  relation: 'new',
                  action: 'answer',
                  evidenceRefs: context.requiredReferences,
                },
              },
            )
          },
          (q: any) => {
            const r = locate(q, 'prepare-answer')
            assert.equal(r.isError, false, JSON.stringify(r.content))
            const value = JSON.parse(
              r.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join(''),
            )
            assert.equal(value.prepared, false)
            assert.equal(value.status, 'answer_directly')
            return lisp
              ? f.mock.toolCallResponse('answer-evidence', 'lisp_eval', {
                  operationId: 'answer-evidence',
                  code: `(kioku.process:run ${JSON.stringify(process.execPath)} (list "-e" "console.log(require('fs').readFileSync('PLAN.md','utf8'))"))`,
                })
              : f.mock.toolCallResponse('answer-evidence', 'read', {
                  file_path: 'PLAN.md',
                })
          },
          (q: any) => {
            const r = locate(q, 'answer-evidence')
            assert.equal(r.isError, false, JSON.stringify(r.content))
            assert.match(JSON.stringify(r.content), new RegExp(marker))
            checked = true
            return f.mock.textResponse(
              'The answer uses the permitted file evidence.',
            )
          },
        )
        await f.turn('PLAN.md を読んで内容を説明して。ファイルは変更しないで。')
        assert.equal(checked, true)
        assert.equal(await readFile(join(f.dir, 'PLAN.md'), 'utf8'), marker)
        const db = openConnection(join(f.dir, 'state.sqlite3'))
        try {
          assert.equal(
            db.prepare('SELECT count(*) n FROM akinator_sessions').get()!.n,
            0,
          )
          assert.equal(
            db.prepare('SELECT count(*) n FROM ledger_runs').get()!.n,
            0,
          )
        } finally {
          db.close()
        }
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        await f.close()
      }
    },
  )
