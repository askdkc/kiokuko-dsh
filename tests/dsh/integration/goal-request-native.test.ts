import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock } from '../helpers/native-mock.js'
import { mountNativeExecutor } from '../helpers/native-tools.js'
import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()

for (const decision of ['OFF', 'ON'] as const) test(`decision ${decision}: goal-only native session executes tools across turns without the request-denial storm`, { timeout: 30_000 }, async () => {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
  const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, llm, session, projection, prompt, tools, agents, skills] = await Promise.all([
    'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-skill',
  ].map(load))
  const loop = await import(new URL('../helpers/kiokuko-driver.mjs', import.meta.url).href)
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'goal-request-')))
  const ctx = new cordis.Context(), fibers: any[] = [], errors: unknown[] = []
  let adapter: ReturnType<typeof createDshHostAdapter> | undefined
  let composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
  let handle: any, executions = 0
  try {
    for (const plugin of [llm, session, projection, prompt, tools, agents, skills]) {
      const fiber = ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined)
      fibers.push(fiber); await fiber
    }
    await mountNativeExecutor(ctx, packages, fibers)
    const loopFiber = ctx.plugin(loop.default, { agents: [] }); fibers.push(loopFiber); await loopFiber
    const questionFiber = ctx.plugin({ name: 'goal-request-startup', apply(context: any) {
      context.provide('userQuestions', { async ask(request: any) {
        if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, `decision ${decision} / Lisp OFF`)
        return { answers: [] }
      } })
    } }); fibers.push(questionFiber); await questionFiber
    ctx.on('agent/error', (event: any) => errors.push(String(event.error)))
    ctx.tools.register({ name: 'read', description: 'Read-only native goal probe.', parameters: {},
      output: { schema: {}, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
      execute: () => { executions++; return 'GOAL_NATIVE_READ' } })
    const mock = nativeMock(llm)
    const provider = new mock.MockAdapter([
      mock.toolCallResponse('goal-read-1', 'read', {}), mock.textResponse('ROUND_ONE_DONE'),
      mock.toolCallResponse('goal-read-2', 'read', {}), mock.textResponse('ROUND_TWO_DONE'),
    ])
    ctx.llm.registerAdapter(['fixture'], provider)
    adapter = createDshHostAdapter(ctx, { repositoryRoot: root, databasePath: join(root, 'state.sqlite3'),
      agenticReplay: { enabled: false }, answerReview: { mode: 'off' }, deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } })
    composition = await mountDshComposition(ctx, adapter.host)
    handle = await ctx.agents.create({ sessionId: session.SessionId('goal-request-native'),
      agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: root } })
    for (const round of [1, 2]) {
      handle.agent.followup(llm.createUserMessage({
        source: { kind: 'goal', goalId: 'native-goal', revision: 1, round },
        content: [{ type: 'text', text: `<goal_round>\nObjective: inspect the repository\nRound: ${round}/256\n</goal_round>` }],
      }))
      await handle.agent.whenIdle()
    }
    assert.deepEqual(errors, [])
    assert.equal(executions, 2)
    const results = handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result')
    assert.equal(results.length, 2)
    assert.ok(results.every((event: any) => !event.data.message.isError), JSON.stringify(results))
    assert.equal(provider.requests.length, 4)
  } finally {
    await handle?.dispose(); await composition?.dispose(); await adapter?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
