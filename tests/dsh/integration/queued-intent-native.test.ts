import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import { mountNativeExecutor } from '../helpers/native-tools.js'
/** Real queued native messages; scripted generation/provider responses prove routing, not model accuracy. */
import { CODING_READ_ONLY } from '../../../src/dsh/coding-workflow/intent.js'
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
import { nativeMock, nativeToolResults } from '../helpers/native-mock.js'
import { interpretedPreparation } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const manifest = join(packages, '@deepseek-ai/dsh/package.json')
const installed = existsSync(manifest)
if (installed) {
  const version = JSON.parse(await readFile(manifest, 'utf8')).version
  const expectedVersion = process.env.KIOKUKO_EXPECTED_DSH_VERSION
    ?? JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
  assert.equal(version, expectedVersion)
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
    const ctx = new cordis.Context(), fibers: any[] = [], errors: string[] = [], asked: string[] = [], classified: unknown[] = [], intentQuestionSets: string[][] = []
    let adapter: ReturnType<typeof createDshHostAdapter> | undefined, composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
    let core: Awaited<ReturnType<typeof mountCore>> | undefined, handle: any, probes = 0
    const configuration = TypedDecisionsConfig.parse(host.startsWith('full-laya')
      ? { provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } } : { provider: 'typesafe' })
    const decisions = new DecisionService(configuration, config => ({ capabilities: { maxQuestions: 256, maxChoices: 256, maxBytes: 262144 }, async evaluate(batch) {
      if (batch.purpose === 'akinator' || batch.purpose === 'request-intent') classified.push(batch.state)
      if (batch.purpose === 'request-intent') intentQuestionSets.push(batch.questions.map(question => question.id))
      if (host === 'full-laya-unavailable') throw new DecisionError('UNAVAILABLE')
      if(batch.purpose==='intent-semantic-match') {
        const source=(batch.state as {source:{task:string}}).source.task
        assert.ok(instructions.some(text=>source.includes(text)),'independent comparison retains the exact scripted queued source')
        return {provider:config.provider,requestedModel:config.provider==='laya-coreml'?'laya-rl-agent':config.typesafe.model,policyVersion:'queued-semantic-fixture',
          answers:batch.questions.map(q=>({id:q.id,status:'selected' as const,choiceId:'supported'}))}
      }
      // Queued follow-up requests keep the active task without requesting a state transition.
      return { provider: config.provider, requestedModel: config.provider === 'laya-coreml' ? 'laya-rl-agent' : config.typesafe.model, policyVersion: 'queued-fixture', answers: batch.questions.map(q => (['task-type', 'request-relation', 'request-action', 'request-change-scope', 'request-task-operation'].includes(q.id) || q.id.startsWith('request-proposal-')) && host !== 'full-laya-abstain'
        ? { id: q.id, status: 'selected' as const, choiceId: ({ 'task-type': 'debug', 'request-relation': (batch.state as { currentUserMessage?: string }).currentUserMessage === instructions[1] ? 'same_scope_continuation' : 'new', 'request-action': 'change', 'request-change-scope': 'implementation', 'request-task-operation': 'none' } as Record<string, string>)[q.id] ?? 'not_selected' } : { id: q.id, status: 'abstained' as const, reason: 'insufficient' as const }) }
    } }))
    try {
      for (const plugin of [llm, session, projection, prompt, tools, agents, skills, commands]) {
        const fiber = ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined); fibers.push(fiber); await fiber
      }
      await mountNativeExecutor(ctx, process.env.KIOKUKO_DSH_PACKAGE_ROOT!, fibers)
    const loopFiber = ctx.plugin(loop.default, { agents: [] }); fibers.push(loopFiber); await loopFiber
      const questions = ctx.plugin({ name: 'queued-intake-questions', apply(context: any) { return context.provide('userQuestions', { async ask(request: any) {
if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, host === 'core-off' ? 'decision OFF / Lisp OFF' : 'decision ON / Lisp OFF')

        const id = request.questions[0].id; asked.push(id)
        assert.notEqual(id, 'taskType', 'clear queued requests must not ask their purpose')
        return { answers: [{ id, selected: [id === 'lisp-coding-mode' || id.startsWith('lisp-early-') || id.startsWith('coding-lisp-') ? 'Lispモードを使わない' : '通常実行'] }] }
      } }) } }); fibers.push(questions); await questions
      ctx.on('agent/error', (event: any) => errors.push(String(event.error)))
      ctx.tools.register({ name: 'fixture_probe', [CODING_READ_ONLY]: true, description: 'Harmless read-only fixture probe.', parameters: {}, output: { schema: {}, render: () => [] }, execute: () => { probes++; return 'probe result' } })
      const mock = nativeMock(llm), provider = new mock.MockAdapter(instructions.flatMap((_, index) => {
        if(host==='full-laya-unavailable')return [
          interpretedPreparation(mock,`queued-unavailable-${index}`,index===0?'new':'same_scope_continuation','change','debug'),
          (request:any)=>{const result=nativeToolResults(request.messages).find(r=>r.toolCallId===`queued-unavailable-${index}`);assert.ok(result&&!result.isError);const value=JSON.parse(result.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(''));assert.equal(value.status,'assessment_unavailable');assert.equal(value.prepared,false);return mock.textResponse('The independent provider is unavailable; the original request is retained without executing work.')},
        ]
        const work = [mock.toolCallResponse(`queued-probe-${index}`, 'fixture_probe', {}), mock.textResponse('QUEUED_NATIVE_RESULT')]
        return intakeMode === 'on-demand' || host === 'full-laya-abstain' || host === 'core-off' ? mock.prepareWork(work, 'debug', `queued-prepare-${index}`, interpretedPreparation(mock, `queued-prepare-${index}`, index === 0 ? 'new' : 'same_scope_continuation', 'change', 'debug')) : work
      }))
      ctx.llm.registerAdapter(['fixture'], provider)
      const common = { repositoryRoot: root, databasePath, intakeMode, answerReview: { mode: 'off' as const }, modelAutoMode: { mode: 'off' as const }, memoryReuse: { mode: 'off' as const }, semanticCompaction: { mode: 'off' as const } }
      const lisp = LispConfig.parse({ enabled: true, sbclPath: join(root, 'must-not-start-sbcl') })
      if (host === 'core-off') core = await mountCore(ctx, { ...common, typedDecisions: { mode: 'off' } }, [{ module: lispModule, configuration: lisp }])
      else {
        adapter = createDshHostAdapter(ctx, { ...common, decisions, agenticReplay: { enabled: false }, deepPlanning: { enabled: false }, llm: { async *stream() { throw new Error('Optional memory model unavailable in native routing fixture') } } })
        composition = await mountDshComposition(ctx, adapter.host, lisp)
      }
      handle = await ctx.agents.create({ sessionId: session.SessionId('queued-intake'), agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: root } })
      for (const text of instructions) handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await handle.agent.whenIdle()
      assert.deepEqual(errors, [], JSON.stringify(handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result').map((event: any) => event.data.message))); assert.equal(probes, host==='full-laya-unavailable'?0:instructions.length, JSON.stringify({ asked, results: handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result').map((event: any) => event.data.message) })); assert.ok(!asked.includes('taskType'))
      assert.deepEqual(asked.filter(id => id.startsWith('coding-lisp-')), [], 'read-only probes cannot ask before Goal/items/criteria exist')
      assert.ok(handle.agent.session.snapshotEvents().some((event: any) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(host==='full-laya-unavailable'?'independent provider is unavailable':'QUEUED_NATIVE_RESULT')))
      const db = openConnection(databasePath)
      try {
        const rows = db.prepare('SELECT task_text AS task FROM akinator_sessions').all() as Array<{ task: string }>
        if(host==='full-laya-unavailable')assert.equal(rows.length,0,'unavailable matching cannot admit an execution run')
        else assert.ok(rows.some(row => row.task.includes(instructions[0]!)), JSON.stringify(rows))
        for (const text of instructions) assert.ok(provider.requests.some(request => JSON.stringify(request.messages).includes(text)), 'every original queued request reaches the native model')
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_sessions WHERE enabled=1').get()?.n, 0)
      } finally { db.close() }
      if (host === 'full-laya' || host === 'full-jev') assert.ok(intentQuestionSets.some(ids => ids.includes('request-task-operation')),
        'the second queued request exercises the active-task operation decision')
      if (host !== 'core-off') for (const text of instructions) assert.ok(classified.some(state => JSON.stringify(state).includes(text)), JSON.stringify(classified))
    } finally {
      await composition?.dispose(); await adapter?.dispose(); await core?.dispose(); await handle?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
