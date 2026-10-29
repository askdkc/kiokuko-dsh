import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
isolateSkillHome()
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
for (const explicit of [false, true])
  test(
    `actual ${explicit ? 'explicit' : 'public'} DSH preserves one guidance origin per turn and intentional human repetition`,
    { timeout: 45000 },
    async () => {
      const f = await nativeSkillFixture({
        packages,
        explicit,
        ...(process.env.KIOKUKO_SKILL_PACKAGE_ROOT
          ? { packageRoot: process.env.KIOKUKO_SKILL_PACKAGE_ROOT }
          : {}),
        extra: {
          typedDecisions: { mode: 'off' },
          answerReview: { mode: 'off' },
          memoryReview: { mode: 'off' },
          memoryEvolution: { mode: 'off' },
          deepPlanning: { enabled: false },
          modelAutoMode: { mode: 'off' },
        },
        hostPlugin: {
          name: 'origin-read-fixture',
          async apply(ctx: any) {
            for (const name of ['dsh-fs-observation-policy', 'dsh-tool-fs']) {
              const module = await import(
                pathToFileURL(
                  join(packages, '@deepseek-ai', name, 'lib/index.js'),
                ).href
              )
              await ctx.plugin(module.default ?? module, {})
            }
          },
        },
      })
      const seen: any[] = []
      try {
        await writeFile(join(f.dir, 'origin.txt'), 'OWNED_READ_EVIDENCE')
        for (let turn = 0; turn < 2; turn++) {
          for (let step = 0; step < 4; step++)
            f.responses.push((q: any) => {
              const guidance = q.messages.filter(
                (m: any) =>
                  m.role === 'user' &&
                  m.source?.kind === 'plugin:kiokuko-dsh' &&
                  m.source.sections?.[0]?.name === 'on-demand-intake',
              )
              if (step === 3) {
                assert.equal(
                  guidance.length,
                  turn + 1,
                  'Unchanged injected guidance must not grow with model/tool steps',
                )
                const humans = q.messages.filter(
                  (m: any) => m.role === 'user' && m.source?.kind === 'user',
                )
                assert.equal(humans.length, turn + 1)
                assert.equal(
                  new Set(humans.map((m: any) => m.id)).size,
                  turn + 1,
                )
                assert.equal(
                  nativeToolResults(q.messages).filter(
                    (m: any) =>
                      m.toolCallId.startsWith(`read-${turn}-`) && !m.isError,
                  ).length,
                  3,
                )
                seen.push({
                  guidance: guidance.map((m: any) => m.id),
                  humans: humans.map((m: any) => m.id),
                })
                return f.mock.textResponse(
                  'The read completed; no edits were requested.',
                )
              }
              return f.mock.toolCallResponse(`read-${turn}-${step}`, 'read', {
                file_path: 'origin.txt',
              })
            })
          await f.turn(
            'Read origin.txt and explain it without modifying files.',
          )
        }
        assert.equal(seen.length, 2)
        assert.equal(seen[1].guidance[0], seen[0].guidance[0])
        assert.notEqual(seen[1].guidance[1], seen[0].guidance[0])
      } finally {
        await f.close()
      }
    },
  )
