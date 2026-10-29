/** Real native read_image, durable image store and DSH model loop; no paid model calls. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
isolateSkillHome()
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const imageTools = process.env.KIOKUKO_IMAGE_TOOL_ROOT ?? packages
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)
for (const scenario of [
  'answer',
  'research',
  'lisp-protected',
  'denied-path',
  'text-model',
  'unsupported-format',
  'oversize',
] as const)
  test(
    `native read_image: ${scenario} returns image evidence without mutation authority`,
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
            executionMode:
              scenario === 'lisp-protected' ? 'protected' : 'development',
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
        nativeAnswer: async (request: any) => ({
          answers: request.questions.map((q: any) => {
            assert.ok(
              ['enno-execution-mode', 'taskType'].includes(q.id) ||
                q.id.startsWith('coding-lisp-'),
              q.id,
            )
            return {
              id: q.id,
              selected: [
                q.id === 'taskType'
                  ? 'research'
                  : q.id.startsWith('coding-lisp-')
                    ? '使わない'
                    : '通常実行',
              ],
            }
          }),
        }),
      })
      const fibers: any[] = []
      let checked = false
      try {
        await writeFile(join(f.dir, 'pixel.png'), png)
        f.model.resolveModel = async (provider: any, id: any) => ({
          provider,
          id,
          name: id,
          inputModalities:
            scenario === 'text-model' ? ['text'] : ['text', 'image'],
        })
        if (scenario === 'denied-path')
          f.ctx.tools.guard((e: any) =>
            e.name === 'read_image' &&
            e.arguments?.file_path === '../outside.png'
              ? 'NATIVE_IMAGE_PATH_DENIED'
              : undefined,
          )
        for (const name of [
          'dsh-attachment-local',
          'dsh-fs-observation-policy',
          'dsh-tool-fs',
        ]) {
          const root = name === 'dsh-tool-fs' ? imageTools : packages
          const p = await import(
            pathToFileURL(join(root, '@deepseek-ai', name, 'lib/index.js')).href
          )
          fibers.push(
            await f.ctx.plugin(
              p.default ?? p,
              name === 'dsh-attachment-local'
                ? {
                    dshHome: join(f.dir, 'image-home'),
                    ...(scenario === 'oversize' ? { maxImageBytes: 16 } : {}),
                  }
                : {},
            ),
          )
        }
        if (scenario === 'lisp-protected') {
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
        if (scenario === 'research')
          f.responses.push((q: any) => {
            const section = q.messages
              .flatMap((m: any) => m.source?.sections ?? [])
              .filter((s: any) => s.name === 'on-demand-intake')
              .at(-1)
            assert.ok(section)
            const bound = JSON.parse(
              section.text.split('advisory only):\n')[1].split('\n')[0],
            )
            return f.mock.toolCallResponse(
              'image-prepare',
              'prepare_requested_work',
              {
                taskType: 'research',
                requestIntent: {
                  relation: 'new',
                  action: 'research',
                  evidenceRefs: bound.requiredReferences,
                },
              },
            )
          })
        f.responses.push(
          (q: any) => {
            if (scenario === 'research') {
              const r = nativeToolResults(q.messages).find(
                (r) => r.toolCallId === 'image-prepare',
              )
              assert.ok(r)
              assert.equal(r.isError, false, JSON.stringify(r.content))
              assert.equal(
                JSON.parse(
                  r.content
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text)
                    .join(''),
                ).prepared,
                true,
              )
            }
            assert.ok(
              q.tools.some((t: any) => t.name === 'read_image'),
              'native image tool remains exposed',
            )
            return f.mock.toolCallResponse('image-read', 'read_image', {
              file_path:
                scenario === 'denied-path'
                  ? '../outside.png'
                  : scenario === 'unsupported-format'
                    ? 'pixel.txt'
                    : 'pixel.png',
            })
          },
          async (q: any) => {
            const r = nativeToolResults(q.messages).find(
              (r) => r.toolCallId === 'image-read',
            )
            assert.ok(r)
            if (
              [
                'denied-path',
                'text-model',
                'unsupported-format',
                'oversize',
              ].includes(scenario)
            ) {
              assert.equal(r.isError, true)
              assert.ok(!r.content.some((b: any) => b.type === 'image'))
              assert.match(
                JSON.stringify(r.content),
                scenario === 'denied-path'
                  ? /NATIVE_IMAGE_PATH_DENIED/
                  : scenario === 'text-model'
                    ? /image input/
                    : scenario === 'unsupported-format'
                      ? /supported image format/
                      : /byte|size|limit|large/i,
              )
              checked = true
              return f.mock.textResponse(
                'The existing image constraint denied this read.',
              )
            }
            assert.equal(r.isError, false, JSON.stringify(r.content))
            const image = r.content.find((b: any) => b.type === 'image')
            assert.ok(image, 'result must contain an actual image block')
            assert.equal(image.attachment.mediaType, 'image/png')
            assert.equal(image.attachment.width, 1)
            assert.equal(image.attachment.height, 1)
            const stored = await f.ctx
              .get('attachments')
              .readImage(image.attachment)
            assert.deepEqual(Buffer.from(stored.data), png)
            assert.equal(
              await readFile(join(f.dir, 'pixel.png'), 'base64'),
              png.toString('base64'),
            )
            checked = true
            return f.mock.textResponse(
              'The permitted image was delivered to the model.',
            )
          },
        )
        await f.turn(
          'pixel.png を読み込んで画像の内容を調査して説明して。ファイルは変更しないで。',
        )
        assert.equal(checked, true)
      } finally {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        await f.close()
      }
    },
  )
