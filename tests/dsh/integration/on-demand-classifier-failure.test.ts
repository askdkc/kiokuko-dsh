/** Fault-injected classifier with the real DecisionService and published native host/loop. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { DecisionService, type DecisionObservation } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { DecisionError, type DecisionBatchResult } from '../../../src/dsh/decisions/contracts.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeMock } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const installed = existsSync(join(packages, '@deepseek-ai/dsh-tools/lib/index.js'))
if (!installed && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Native runtime required for classifier failure tests')

for (const fault of ['NONE', 'UNAVAILABLE', 'MALFORMED_RESPONSE'] as const) for (const web of [false, true]) {
  test(`on-demand full native: ${fault} classifier with AgenticReplay recording permits ${web ? 'automatic web search' : 'an ordinary answer'} without purpose UI`, { skip: !installed, timeout: 30_000 }, async () => {
    const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
    const [cordis, llm, session, projection, prompt, tools, agents, loop, skills] = await Promise.all([
      'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill',
    ].map(load))
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'on-demand-fault-'))), databasePath = join(root, 'state.sqlite3')
    const ctx = new cordis.Context(), fibers: any[] = [], observations: DecisionObservation[] = [], errors: unknown[] = []
    let adapter: ReturnType<typeof createDshHostAdapter> | undefined, composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined, handle: any
    let questions = 0, providerCalls = 0
    const configuration = TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent', socketPath: '/fault-injected-not-used' } })
    const decisions = new DecisionService(configuration, () => ({ capabilities: { maxQuestions: 256, maxChoices: 256, maxBytes: 262144 },
      async evaluate(batch) {
        providerCalls++
        if (fault === 'NONE') return { provider: 'laya-coreml', requestedModel: 'laya-rl-agent', policyVersion: 'native-fault-test', answers: batch.questions.map(question => ({ id: question.id, status: 'selected' as const, choiceId: question.id === 'task-type' ? 'chat' : 'apple' })) }
        if (fault === 'UNAVAILABLE') throw new DecisionError('UNAVAILABLE')
        return { answers: 'malformed injected provider response' } as unknown as DecisionBatchResult
      } }), undefined, { onEvaluation: observation => observations.push(observation) })
    try {
      for (const plugin of [llm, session, projection, prompt, tools, agents, skills]) {
        const fiber = ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined); fibers.push(fiber); await fiber
      }
      const loopFiber = ctx.plugin(loop.default, { agents: [] }); fibers.push(loopFiber); await loopFiber
      const questionFiber = ctx.plugin({ name: 'fault-question-observer', apply(context: any) { return context.provide('userQuestions', {
        async ask() { questions++; throw new Error('An ordinary answer must not open intake UI') },
      }) } }); fibers.push(questionFiber); await questionFiber
      ctx.on('agent/error', (event: any) => errors.push(String(event.error)))
      let webBodies = 0
      ctx.tools.register({ name: 'web_search', description: 'Harmless web search fixture.', parameters: { queries: { type: 'array', items: { type: 'string' }, required: true } }, output: { schema: {}, render: () => [] }, execute: () => { webBodies++; return 'web fixture result' } })
      const mock = nativeMock(llm), provider = new mock.MockAdapter([...(web ? [mock.toolCallResponse('first-search', 'web_search', { queries: ['VMware Tools critical CVE'] })] : []), mock.textResponse('SCRIPTED_ORDINARY_ANSWER')])
      ctx.llm.registerAdapter(['fixture'], provider)
      adapter = createDshHostAdapter(ctx, { repositoryRoot: root, databasePath, decisions,
        agenticReplay: { enabled: true }, answerReview: { mode: 'off' }, deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } })
      composition = await mountDshComposition(ctx, adapter.host)
      handle = await ctx.agents.create({ sessionId: session.SessionId(`fault-${fault}`), agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: root } })
      const task = web ? 'vmware toolsの最新の脆弱性でクリティカルレベルのものある？' : 'Why is the sky blue?'
      handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
      await handle.agent.whenIdle()
      assert.deepEqual(errors, []); assert.equal(questions, 0); assert.ok(providerCalls > 0)
      assert.ok(observations.some(observation => observation.purpose === 'akinator' && observation.fallbackReason === (fault === 'NONE' ? null : `DECISION_${fault}`)))
      assert.equal(provider.requests.length, web ? 2 : 1); assert.equal(webBodies, web ? 1 : 0)
      if (web) assert.ok(!handle.agent.session.snapshotEvents().some((event: any) => event.type === 'tool/result' && event.data.message.isError))
      assert.ok(handle.agent.session.snapshotEvents().some((event: any) => event.type === 'assistant/message' && JSON.stringify(event.data).includes('SCRIPTED_ORDINARY_ANSWER')))
      const db = openConnection(databasePath)
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get()?.n, web ? 1 : 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM akinator_sessions').get()?.n, web ? 1 : 0) } finally { db.close() }
    } finally {
      await handle?.dispose(); await composition?.dispose(); await adapter?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
