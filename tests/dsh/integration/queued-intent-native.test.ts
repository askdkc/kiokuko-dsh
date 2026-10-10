/** Real queued native messages; scripted generation/provider responses prove routing, not model accuracy. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { mountCore } from '../../../src/dsh/core/index.js'
import { lispModule } from '../../../src/dsh/modules/lisp.js'
import { LispConfig } from '../../../src/dsh/lisp/contracts.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { DecisionError } from '../../../src/dsh/decisions/contracts.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeMock } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const manifest = join(packages, '@deepseek-ai/dsh/package.json')
const installed = existsSync(manifest)
if (installed) {
  const version = JSON.parse(await readFile(manifest, 'utf8')).version
  assert.ok(['0.1.5-rc.1', '0.2.0-rc.2'].includes(version))
  if (process.env.KIOKUKO_EXPECTED_DSH_VERSION) assert.equal(version, process.env.KIOKUKO_EXPECTED_DSH_VERSION)
}
if (!installed && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Native DSH required for queued intake regression')
const instructions = ['Fix `src/parser.ts` and add input validation.', 'Also fix empty-input handling and cover the regression; do not deploy.']

for (const host of ['full-laya', 'full-jev', 'full-laya-abstain', 'full-laya-unavailable', 'core-off'] as const) for (const intakeMode of ['eager', 'on-demand'] as const) {
  test(`queued ${host} ${intakeMode}: preserve every request without purpose UI`, { skip: !installed, timeout: 30000 }, async () => {
    const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
    const [cordis, llm, session, projection, prompt, tools, agents, loop, skills, commands] = await Promise.all([
      'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill', 'dsh-commands',
    ].map(load))
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'queued-intake-'))), databasePath = join(root, 'state.sqlite3')
    const ctx = new cordis.Context(), fibers: any[] = [], errors: string[] = [], asked: string[] = [], classified: unknown[] = []
    let adapter: ReturnType<typeof createDshHostAdapter> | undefined, composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
    let core: Awaited<ReturnType<typeof mountCore>> | undefined, handle: any, probes = 0
    const configuration = TypedDecisionsConfig.parse(host.startsWith('full-laya')
      ? { provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } } : { provider: 'typesafe' })
    const decisions = new DecisionService(configuration, config => ({ capabilities: { maxQuestions: 256, maxChoices: 256, maxBytes: 262144 }, async evaluate(batch) {
      if (batch.purpose === 'akinator') classified.push(batch.state)
      if (host === 'full-laya-unavailable') throw new DecisionError('UNAVAILABLE')
      return { provider: config.provider, requestedModel: config.provider === 'laya-coreml' ? 'laya-rl-agent' : config.typesafe.model, policyVersion: 'queued-fixture', answers: batch.questions.map(q => q.id === 'task-type' && host !== 'full-laya-abstain'
        ? { id: q.id, status: 'selected' as const, choiceId: 'debug' } : { id: q.id, status: 'abstained' as const, reason: 'insufficient' as const }) }
    } }))
    try {
      for (const plugin of [llm, session, projection, prompt, tools, agents, skills, commands]) {
        const fiber = ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined); fibers.push(fiber); await fiber
      }
      const loopFiber = ctx.plugin(loop.default, { agents: [] }); fibers.push(loopFiber); await loopFiber
      const questions = ctx.plugin({ name: 'queued-intake-questions', apply(context: any) { return context.provide('userQuestions', { async ask(request: any) {
        const id = request.questions[0].id; asked.push(id)
        assert.notEqual(id, 'taskType', 'clear queued requests must not ask their purpose')
        return { answers: [{ id, selected: [id === 'lisp-coding-mode' ? 'Lispモードを使わない' : '通常実行'] }] }
      } }) } }); fibers.push(questions); await questions
      ctx.on('agent/error', (event: any) => errors.push(String(event.error)))
      ctx.tools.register({ name: 'fixture_probe', description: 'Harmless read-only fixture probe.', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => { probes++; return 'probe result' } })
      const mock = nativeMock(llm), provider = new mock.MockAdapter(instructions.flatMap((_, index) => {
        const work = [mock.toolCallResponse(`queued-probe-${index}`, 'fixture_probe', {}), mock.textResponse('QUEUED_NATIVE_RESULT')]
        return intakeMode === 'on-demand' || host === 'full-laya-abstain' || host === 'full-laya-unavailable' ? mock.prepareWork(work, 'debug', `queued-prepare-${index}`) : work
      }))
      ctx.llm.registerAdapter(['fixture'], provider)
      const common = { repositoryRoot: root, databasePath, intakeMode, answerReview: { mode: 'off' as const }, modelAutoMode: { mode: 'off' as const }, memoryReuse: { mode: 'off' as const }, semanticCompaction: { mode: 'off' as const } }
      const lisp = LispConfig.parse({ enabled: true, sbclPath: join(root, 'must-not-start-sbcl') })
      if (host === 'core-off') core = await mountCore(ctx, { ...common, typedDecisions: { mode: 'off' } }, [{ module: lispModule, configuration: lisp }])
      else {
        adapter = createDshHostAdapter(ctx, { ...common, decisions, orca: { enabled: false }, deepPlanning: { enabled: false }, llm: { async *stream() { throw new Error('Optional memory model unavailable in native routing fixture') } } })
        composition = await mountDshComposition(ctx, adapter.host, lisp)
      }
      handle = await ctx.agents.create({ sessionId: session.SessionId('queued-intake'), agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: root } })
      for (const text of instructions) handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await handle.agent.whenIdle()
      assert.deepEqual(errors, [], JSON.stringify(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result').map((event: any) => event.data.message))); assert.equal(probes, instructions.length, JSON.stringify({ asked, results: handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result').map((event: any) => event.data.message) })); assert.ok(!asked.includes('taskType'))
      assert.deepEqual(asked.filter(id => id === 'lisp-coding-mode'), ['lisp-coding-mode'], 'inference does not waive Lisp opt-in')
      assert.ok(handle.agent.session.snapshotEvents().some((event: any) => event.type === 'assistant/message' && JSON.stringify(event.data).includes('QUEUED_NATIVE_RESULT')))
      const db = openConnection(databasePath)
      try {
        const rows = db.prepare('SELECT task_text AS task FROM akinator_sessions').all() as Array<{ task: string }>
        for (const text of instructions) assert.ok(rows.some(row => row.task.includes(text)), JSON.stringify(rows))
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_sessions WHERE enabled=1').get()?.n, 0)
      } finally { db.close() }
      if (host !== 'core-off') for (const text of instructions) assert.ok(classified.some(state => (typeof state === 'string' ? state : (state as any).task).includes(text)), JSON.stringify(classified))
    } finally {
      await composition?.dispose(); await adapter?.dispose(); await core?.dispose(); await handle?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
