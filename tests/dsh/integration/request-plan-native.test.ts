/** Actual DSH plan review, model loop, tool executor and isolated SQLite.
 * The model and human responses are scripted; no paid model or live profile is used. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { fixtureDefinition, toolValue } from '../helpers/coding-script.js'
import { nativeMock, nativeToolResults } from '../helpers/native-mock.js'
import { mountNativeExecutor } from '../helpers/native-tools.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'

const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const available = existsSync(
  join(packages, '@deepseek-ai/dsh-plan-mode/lib/index.js'),
)
if (!available && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')
  throw new Error('Plan regression requires the selected official DSH fixture')
const implementation = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const load = (name: string) =>
  import(
    pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href
  )
const resultText = (result: any) =>
  result.content
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text)
    .join('\n')
const preparationValue = (result: any) => {
  const text = resultText(result)
  return JSON.parse(text.slice(text.indexOf('{')))
}
const plan =
  '# Parser implementation\nCreate src/parser.ts with an identity function. Preserve all other files. Do not publish.'

for (const mode of ['core', 'adapter'] as const)
  for (const presentation of ['native', 'ptc'] as const)
    for (const legacy of [false, true, 'assessment'] as const)
      test(
        `native plan review -> explicit implementation -> prepared write (${mode}, ${presentation}, legacy=${legacy})`,
        { skip: !available, timeout: 30_000 },
        async (t) =>
          withIsolatedSkillHome(async () => {
            const modules = await Promise.all(
              [
                'cordis',
                'dsh-llm',
                'dsh-session',
                'dsh-session-projection',
                'dsh-system-prompt',
                'dsh-tools',
                'dsh-agent',
                'dsh-agent-loop',
                'dsh-skill',
                'dsh-commands',
                'dsh-fs-local',
                'dsh-working-directory',
                'dsh-plan-mode',
              ].map(load),
            )
            const [
              cordis,
              llm,
              sessions,
              projection,
              prompt,
              tools,
              agents,
              loop,
              skills,
              commands,
              fsLocal,
              workingDirectory,
              plans,
            ] = modules
            const root = realpathSync(
              await mkdtemp(join(tmpdir(), 'plan-handoff-')),
            )
            const ctx = new cordis.Context(),
              fibers: any[] = [],
              errors: unknown[] = [],
              asked: string[] = []
            let handle: any,
              host: any,
              adapter: any,
              composition: any,
              written = false
            try {
              await mkdir(join(root, '.git'))
              await mkdir(join(root, 'src'))
              for (const plugin of [
                fsLocal,
                workingDirectory,
                llm,
                sessions,
                projection,
                prompt,
                tools,
                agents,
                skills,
                commands,
              ]) {
                fibers.push(
                  await ctx.plugin(
                    plugin.default,
                    plugin === fsLocal
                      ? { cwd: root }
                      : plugin === workingDirectory
                        ? { defaultDirectory: root }
                        : plugin === prompt
                          ? { persona: '' }
                          : undefined,
                  ),
                )
              }
              await mountNativeExecutor(ctx, packages, fibers)
              ctx.provide('userQuestions', {
                async ask(request: any) {
                  asked.push(
                    ...request.questions.map((q: any) =>
                      q.intent?.kind === 'plan-review' ? 'plan-review' : q.id,
                    ),
                  )
                  return {
                    answers: request.questions.map((q: any) => ({
                      id: q.id,
                      selected:
                        q.intent?.kind === 'plan-review'
                          ? [q.intent.approve]
                          : q.id === 'enno-execution-mode'
                            ? ['通常実行']
                            : q.id.startsWith('coding-lisp-')
                              ? ['使わない']
                              : [],
                    })),
                  }
                },
              })
              fibers.push(
                await ctx.plugin(plans.default, {
                  section: 'Plan the requested work before implementation.',
                }),
              )
              fibers.push(await ctx.plugin(loop.default, { agents: [] }))
              ctx.on('agent/error', (event: any) => errors.push(event.error))
              const mock = nativeMock(llm),
                responses: any[] = []
              ctx.llm.registerAdapter(
                ['fixture'],
                new mock.MockAdapter(responses),
              )
              const settings = {
                repositoryRoot: root,
                databasePath: join(root, 'state.sqlite3'),
                typedDecisions:
                  legacy === 'assessment'
                    ? {
                        provider: 'laya-coreml',
                        'laya-coreml': {
                          protocol: 'v1',
                          model: 'laya-rl-agent',
                          socketPath: join(root, 'unused-classifier.sock'),
                        },
                      }
                    : { mode: 'off' },
                answerReview: { mode: 'off' },
                modelAutoMode: { mode: 'off' },
                memoryReuse: { mode: 'off' },
                semanticCompaction: { mode: 'off' },
              }
              const moduleFor = (path: string) =>
                implementation
                  ? pathToFileURL(
                      join(implementation, 'dist/dsh', path + '.js'),
                    ).href
                  : new URL('../../../src/dsh/' + path + '.ts', import.meta.url)
                      .href
              if (legacy === 'assessment') {
                const provider = await import(moduleFor('decisions/laya-v1'))
                t.mock.method(
                  provider.LayaV1DecisionProvider.prototype,
                  'evaluate',
                  async (batch: any) => {
                    const candidate = batch.state?.candidate
                    const supported =
                      candidate?.relation === 'scope_change' &&
                      candidate?.evidence?.proposalRefs?.length === 1
                    return {
                      provider: 'laya-coreml',
                      requestedModel: 'laya-rl-agent',
                      policyVersion: 'logged-assessment-fixture',
                      answers: batch.questions.map((q: any) =>
                        q.id.startsWith('semantic-') && supported
                          ? {
                              id: q.id,
                              status: 'selected',
                              choiceId: 'supported',
                            }
                          : {
                              id: q.id,
                              status: 'abstained',
                              reason: 'insufficient',
                            },
                      ),
                    }
                  },
                )
              }
              if (mode === 'core')
                host = await (
                  await import(moduleFor('core/host'))
                ).mountCore(ctx, settings, [])
              else {
                adapter = (
                  await import(moduleFor('host-adapter'))
                ).createDshHostAdapter(ctx, {
                  ...settings,
                  agenticReplay: { enabled: false },
                  deepPlanning: { enabled: false },
                  memoryReview: { mode: 'off' },
                  memoryEvolution: { mode: 'off' },
                  toolExposure: { mode: 'full' },
                })
                composition = await (
                  await import(moduleFor('composition'))
                ).mountDshComposition(ctx, adapter.host, { enabled: false })
              }
              handle = await ctx.agents.create({
                sessionId: sessions.SessionId('plan-' + mode),
                agentOptions: { provider: 'fixture', model: 'mock' },
                meta: { cwd: root },
              })
              const agent = handle.agent
              const toolCall = (
                id: string,
                name: string,
                args: Record<string, unknown>,
              ) =>
                presentation === 'native'
                  ? mock.toolCallResponse(id, name, args)
                  : mock.toolCallResponse(id, 'run_code', {
                      description: 'Follow the current requested plan',
                      code: `return await tools.${name}(${JSON.stringify(args)})`,
                    })
              ctx.get('planMode').set(agent, true)
              const resultFor = (request: any, id: string) => {
                const result = nativeToolResults(request.messages).find(
                  (result) => result.toolCallId === id,
                )
                assert.ok(result, 'the native tool result must be present')
                assert.equal(result.isError, false, resultText(result))
                return result
              }
              responses.push(
                mock.toolCallResponse('review-plan', 'exit_plan_mode', {
                  plan,
                }),
                (request: any) => {
                  assert.match(
                    resultText(resultFor(request, 'review-plan')),
                    /^Plan approved/u,
                  )
                  return mock.textResponse('The plan is ready.')
                },
              )
              agent.followup(
                llm.createUserMessage({
                  source: { kind: 'user' },
                  content: [
                    {
                      type: 'text',
                      text: 'Present a plan for src/parser.ts. Do not implement yet.',
                    },
                  ],
                }),
              )
              await agent.whenIdle()
              assert.deepEqual(errors, [])
              assert.equal(existsSync(join(root, 'src/parser.ts')), false)
              if (presentation === 'ptc') {
                for (const name of [
                  'dsh-subprocess-local',
                  'dsh-sandbox-local',
                  'dsh-sandbox-policy',
                  'dsh-ptc-runtime-node',
                ])
                  fibers.push(
                    await ctx.plugin(
                      (await load(name)).default,
                      name === 'dsh-sandbox-policy'
                        ? { mode: 'read-only', workspaceRoot: root }
                        : name === 'dsh-ptc-runtime-node'
                          ? { timeoutMs: 10000 }
                          : undefined,
                    ),
                  )
                fibers.push(
                  await agent.ctx.plugin(
                    await load('dsh-tool-executor-ptc'),
                    {},
                  ),
                )
              }
              let repairedPreparation: any
              if (legacy === true)
                responses.push(
                  toolCall('unresolved-legacy', 'prepare_requested_work', {
                    taskType: 'build',
                  }),
                )
              responses.push(
                (request: any) => {
                  if (legacy === true) {
                    assert.equal(
                      preparationValue(resultFor(request, 'unresolved-legacy'))
                        .prepared,
                      false,
                    )
                    assert.equal(existsSync(join(root, 'src/parser.ts')), false)
                  }
                  const section = request.messages
                    .flatMap((m: any) => m.source?.sections ?? [])
                    .filter((s: any) => s.name === 'on-demand-intake')
                    .at(-1)
                  assert.ok(section)
                  const bound = JSON.parse(
                    section.text.split('advisory only):\n')[1].split('\n')[0],
                  )
                  assert.ok(
                    bound.proposals.some((p: any) => p.text === plan),
                    'the full reviewed plan must survive the ordinary assistant reply',
                  )
                  const proposal = bound.proposals.find(
                    (p: any) => p.text === plan,
                  )
                  repairedPreparation = {
                    requestIntent: {
                      relation: 'scope_change',
                      action: 'change',
                      changeScope: 'implementation',
                      evidenceRefs: [
                        ...bound.requiredReferences,
                        proposal.evidenceRef,
                      ],
                    },
                  }
                  return legacy === 'assessment'
                    ? toolCall('inconclusive-plan', 'prepare_requested_work', {
                        requestIntent: {
                          relation: 'same_scope_continuation',
                          action: 'change',
                          changeScope: 'implementation',
                          evidenceRefs: bound.requiredReferences,
                        },
                      })
                    : toolCall(
                        'prepare-plan',
                        'prepare_requested_work',
                        repairedPreparation,
                      )
                },
                ...(legacy === 'assessment'
                  ? [
                      (request: any) => {
                        const inconclusive = preparationValue(
                          resultFor(request, 'inconclusive-plan'),
                        )
                        assert.equal(inconclusive.prepared, false)
                        assert.equal(inconclusive.status, 'assessment_rejected')
                        assert.equal(
                          inconclusive.requestIntent.action,
                          'change',
                        )
                        assert.equal(
                          existsSync(join(root, 'src/parser.ts')),
                          false,
                        )
                        assert.equal(
                          asked.filter((id) =>
                            id.startsWith('request-clarification-'),
                          ).length,
                          0,
                        )
                        return toolCall(
                          'missing-scope-plan',
                          'prepare_requested_work',
                          {
                            requestIntent: {
                              ...repairedPreparation.requestIntent,
                              changeScope: 'unknown',
                            },
                          },
                        )
                      },
                    ]
                  : []),
                ...(legacy === 'assessment'
                  ? [
                      (request: any) => {
                        const rejected = nativeToolResults(
                          request.messages,
                        ).find(
                          (result) =>
                            result.toolCallId === 'missing-scope-plan',
                        )
                        assert.ok(rejected)
                        assert.equal(rejected.isError, false)
                        const interpretation = preparationValue(rejected)
                        assert.equal(interpretation.prepared, false)
                        assert.equal(
                          interpretation.status,
                          'request_interpretation_required',
                        )
                        assert.deepEqual(
                          interpretation.requestInterpretation.missingFields,
                          ['requestIntent.changeScope'],
                        )
                        assert.equal(
                          existsSync(join(root, 'src/parser.ts')),
                          false,
                        )
                        assert.equal(
                          asked.filter((id) =>
                            id.startsWith('request-clarification-'),
                          ).length,
                          0,
                        )
                        return toolCall(
                          'prepare-plan',
                          'prepare_requested_work',
                          repairedPreparation,
                        )
                      },
                    ]
                  : []),
                (request: any) => {
                  assert.equal(
                    preparationValue(resultFor(request, 'prepare-plan'))
                      .prepared,
                    true,
                  )
                  return toolCall('plan-status', 'coding_workflow', {
                    action: 'status',
                  })
                },
                (request: any) =>
                  toolCall('plan-goal', 'coding_workflow_apply', {
                    action: 'propose',
                    expectedRevision: toolValue(request, 'plan-status')
                      .revision,
                    definition: fixtureDefinition('src/parser.ts'),
                  }),
                (request: any) => {
                  resultFor(request, 'plan-goal')
                  return toolCall('write-plan', 'kioku_write', {
                    path: 'src/parser.ts',
                    content: 'export const parse = (value: string) => value\n',
                  })
                },
                (request: any) => {
                  resultFor(request, 'write-plan')
                  written = true
                  return mock.textResponse('Implemented the requested parser.')
                },
              )
              agent.followup(
                llm.createUserMessage({
                  source: { kind: 'user' },
                  content: [
                    {
                      type: 'text',
                      text: 'PLAN.md を実装。今提示した計画を実装し、それ以外は変更しないで。公開は禁止。',
                    },
                  ],
                }),
              )
              await agent.whenIdle()
              await host?.drain()
              await adapter?.host.runtime.drain?.()
              assert.deepEqual(errors, [])
              assert.equal(written, true)
              assert.equal(
                await readFile(join(root, 'src/parser.ts'), 'utf8'),
                'export const parse = (value: string) => value\n',
              )
              assert.equal(
                asked.filter((id) => id.startsWith('request-clarification-'))
                  .length,
                0,
                'clear plan adoption needs no generic human question, including a legacy model request',
              )
              assert.equal(
                asked.filter((id) => id === 'enno-execution-mode').length <= 1,
                true,
                'execution selection is never repeated',
              )
              assert.ok(
                asked.every(
                  (id) =>
                    id === 'enno-execution-mode' ||
                    id === 'plan-review' ||
                    id.startsWith('coding-lisp-') ||
                    (legacy && id.startsWith('request-clarification-')),
                ),
                'only native plan review and normal execution selection are presented',
              )
            } finally {
              await handle?.dispose()
              await composition?.dispose()
              await adapter?.dispose()
              await host?.dispose()
              for (const fiber of fibers.reverse()) await fiber.dispose()
              await rm(root, { recursive: true, force: true })
            }
          }),
      )
