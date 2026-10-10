/** Real native file reads; scripted generation does not establish model intent quality. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as sourceFull from '../../../src/dsh/index.js'
import * as sourceCore from '../../../src/dsh/core/index.js'
import { nativeMock } from '../helpers/native-mock.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { openConnection } from '../../../src/db/connection.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_TEST_PLUGIN_PACKAGE_ROOT
const full = packageRoot ? await import(pathToFileURL(join(packageRoot, 'dist/dsh/index.js')).href) : sourceFull
const core = packageRoot ? await import(pathToFileURL(join(packageRoot, 'dist/dsh/core/index.js')).href) : sourceCore

for (const mode of ['full', 'core'] as const) for (const outcome of ['read', 'native-denial', 'unclear-target'] as const) {
  test(`on-demand file ${mode}: first read ${outcome} uses original admission and native policy`, { timeout: 30_000 }, async () => withIsolatedSkillHome(async () => {
    const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
    const [cordis, llm, sessions, projection, prompt, tools, agents, skills, loop, fs, directory, policy, files] = await Promise.all([
      'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-skill',
      'dsh-agent-loop', 'dsh-fs-local', 'dsh-working-directory', 'dsh-fs-observation-policy', 'dsh-tool-fs',
    ].map(load))
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'on-demand-file-'))), ctx = new cordis.Context()
    const fibers: any[] = [], errors: unknown[] = []
    let handle: any, mounted: any, adapter: any
    const marker = 'REAL_PLAN_CONTENT_7e62'
    const task = outcome === 'unclear-target' ? 'Do it.' : 'PLAN.md を読んで要点を説明して。ファイルは変更しないで。'
    try {
      await writeFile(join(root, 'PLAN.md'), '# Plan\n' + marker + '\n')
      for (const plugin of [llm, sessions, projection, prompt, tools, agents, skills, fs, directory, policy, files]) {
        fibers.push(await ctx.plugin(plugin.default ?? plugin, plugin === fs ? { cwd: root }
          : plugin === directory ? { defaultDirectory: root } : plugin === prompt ? { persona: '' } : undefined))
      }
      fibers.push(await ctx.plugin(loop.default, { agents: [] }))
      ctx.on('agent/error', (event: any) => errors.push(String(event.error)))
      if (outcome === 'native-denial') ctx.tools.guard((execution: any) => execution.name === 'read' ? 'native file denial' : undefined)
      const mock = nativeMock(llm), model = new mock.MockAdapter([
        mock.toolCallResponse('read-plan-first', 'read', { file_path: 'PLAN.md' }), mock.textResponse('SCRIPTED_FINAL'),
      ])
      ctx.llm.registerAdapter(['fixture'], model)
      const config = { repositoryRoot: root, databasePath: join(root, 'memory.sqlite3'), typedDecisions: { mode: 'off' },
        answerReview: { mode: 'off' }, semanticCompaction: { mode: 'off' }, modelAutoMode: { mode: 'off' } }
      if (mode === 'core') mounted = await core.mountCore(ctx, config, [])
      else { adapter = full.createDshHostAdapter(ctx, { ...config, agenticReplay: { enabled: false }, toolExposure: { mode: 'full' }, deepPlanning: { enabled: false } }); mounted = await full.mountDshComposition(ctx, adapter.host) }
      handle = await ctx.agents.create({ sessionId: sessions.SessionId(`first-file-${mode}-${outcome}`), agentOptions: { provider: 'fixture', model: 'mock' }, meta: { cwd: root } })
      handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
      await handle.agent.whenIdle()
      assert.deepEqual(errors, [])
      const results = handle.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result')
      assert.equal(results.length, 1, 'the model must not need an extra preparation call')
      assert.equal(results[0].data.message.isError, outcome !== 'read', JSON.stringify(results))
      assert.equal(JSON.stringify(model.requests.at(-1).messages).includes(marker), outcome === 'read', 'only an admitted native read may deliver file bytes')
      if (outcome === 'read') assert.ok(!JSON.stringify(results).includes('Before tool-backed work'))
      if (outcome === 'native-denial') assert.ok(JSON.stringify(results).includes('native file denial'))
      if (outcome === 'unclear-target') assert.ok(JSON.stringify(results).includes('does not identify the action target'))
      const db = openConnection(config.databasePath)
      try {
        const intakes = db.prepare('SELECT task_text FROM akinator_sessions').all()
        assert.equal(intakes.length, outcome === 'unclear-target' ? 0 : 1)
        if (intakes.length) assert.equal(intakes[0]?.task_text, task, 'the tool must not replace the original request or its negation')
      } finally { db.close() }
    } finally {
      await handle?.dispose(); await mounted?.dispose(); await adapter?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }))
}
