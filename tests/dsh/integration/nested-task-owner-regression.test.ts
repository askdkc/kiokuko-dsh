import { mountNativeTools } from '../helpers/native-tools.js'
/** Scripted generation through the real native runtime; all workspaces are isolated. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { mountCore } from '../../../src/dsh/core/host.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeMock } from '../helpers/native-mock.js'
import { interpretedPreparation } from '../helpers/coding-script.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const expected = process.env.KIOKUKO_EXPECTED_DSH_VERSION
  ?? JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
assert.equal(JSON.parse(readFileSync(join(packages, '@deepseek-ai/dsh/package.json'), 'utf8')).version, expected)
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)

for (const mode of ['full-nested', 'core-nested', 'full-non-git-binding'] as const) test(`${mode}: admitted native reads retain canonical task ownership`, { timeout: 30_000 }, async () => {
  const [cordis, llm, session, projection, prompt, tools, agents, loop, skills, fsLocal, workingDirectory, scope, fsTools] = await Promise.all([
    'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill',
    'dsh-fs-local', 'dsh-working-directory', 'dsh-scope', 'dsh-tool-fs',
  ].map(load))
  const temp = realpathSync(await mkdtemp(join(tmpdir(), 'nested-task-owner-')))
  const repositoryRoot = join(temp, 'project'), cwd = mode === 'full-non-git-binding' ? repositoryRoot : join(repositoryRoot, 'nested')
  await mkdir(cwd, { recursive: true })
  if (mode === 'full-non-git-binding') {
    await writeFile(join(repositoryRoot, '.kiokuko.json'), JSON.stringify({ schemaVersion: 1, repositoryId: 'repo_non_git_owner', workspace: 'non-git-owner', agentFile: 'AGENTS.md', templateVersion: 1 }))
    assert.equal(existsSync(join(repositoryRoot, '.git')), false)
  } else execFileSync('git', ['init', '--quiet', repositoryRoot])
  const target = join(cwd, 'probe.txt'), marker = 'NESTED_OWNER_MARKER_592'
  await writeFile(target, marker + '\n')
  const databasePath = join(temp, 'state.sqlite3')
  const ctx = new cordis.Context(), fibers: any[] = []
  let adapter: any, composition: any, core: any, local: any, release: (() => void) | undefined
  const errors: string[] = []
  try {
    for (const [plugin, config] of [[llm.default], [session.default], [projection.default], [prompt.default, { persona: '' }],
      [fsLocal.default, { cwd }], [workingDirectory.default, { defaultDirectory: cwd }], [tools.default],
      [agents.default], [skills.default], [loop.default, { agents: [] }], [fsTools]]) {
      if (plugin === tools.default) { await mountNativeTools(ctx, tools, packages, fibers); continue }
      const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber
    }
    const questions = ctx.plugin({ name: 'nested-task-owner-questions', apply(context: any) {
      return context.provide('userQuestions', { async ask(request: any) { return { answers: request.questions.map((question: any) =>
        ({ id: question.id, selected: [question.id === 'taskType' ? 'review' : question.options?.[0]?.label ?? 'review'] })) } } })
    } }); fibers.push(questions); await questions
    const mock = nativeMock(llm)
    const model = new mock.MockAdapter([
      interpretedPreparation(mock, 'prepare-probe', 'new', 'verify', 'review'),
      mock.toolCallResponse('native-read-probe', 'read', { file_path: target }),
      mock.toolCallResponse('owned-read-probe', 'kioku_read', { path: target }),
      mock.textResponse('The exact probe was read. No files were changed.'),
    ])
    ctx.llm.registerAdapter(['nested-mock'], model)
    const options = { repositoryRoot: mode === 'core-nested' ? cwd : repositoryRoot, databasePath,
      migrationsDirectory: join(process.cwd(), 'migrations'), typedDecisions: { mode: 'off' as const } }
    if (mode === 'core-nested') core = await mountCore(ctx, options)
    else { adapter = createDshHostAdapter(ctx, options); composition = await mountDshComposition(ctx, adapter.host) }
    const agent = await ctx.agentLoop.create(session.SessionId('nested-owner-session'), { provider: 'nested-mock', model: 'mock' }, { cwd })
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    const off = ctx.on('agent/error', (event: any) => errors.push(String(event.error?.stack ?? event.error)))
    try {
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: `Verify the marker in the exact file ${target}. Read that file only; do not modify files.\nread paths: ${cwd}\n完了条件: report the marker from this file.` }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const events = agent.session.snapshotEvents()
      const results = events.filter((event: any) => event.type === 'tool/result').map((event: any) => event.data.message)
      const prepared = results.find((value: any) => value.toolCallId === 'prepare-probe')
      const owned = results.find((value: any) => value.toolCallId === 'owned-read-probe')
      assert.ok(prepared && !prepared.isError, JSON.stringify({ errors, results }))
      assert.equal(JSON.parse(prepared.content[0].text).prepared, true)
      assert.ok(owned && !owned.isError, JSON.stringify({ errors, results }))
      assert.match(JSON.stringify(owned.content), new RegExp(marker))
      const db = openConnection(databasePath)
      try {
        const tasks = db.prepare('SELECT run_id, task_repository_root FROM ledger_runs').all<{ run_id: string; task_repository_root: string }>()
        assert.equal(tasks.length, 1, 'the native read must retain the admitted task')
        assert.equal(tasks[0]!.task_repository_root, realpathSync(repositoryRoot))
        assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_owned_operations WHERE run_id=?').get(tasks[0]!.run_id)?.n, 1)
        if (mode !== 'core-nested') assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence WHERE run_id=?').get(tasks[0]!.run_id)?.n, 1,
          'the ordinary native read must retain a current task lease and evidence')
      } finally { db.close() }
      const definition = ctx.tools.get('kioku_read', agent)
      await assert.rejects(definition.execute({ path: target }, { agent: { ...agent, session: agent.session }, name: 'kioku_read', callId: 'impostor-read', signal: new AbortController().signal }),
        /owner|identity|scope/, 'same-id impostor must not gain the corrected repository authority')
      assert.deepEqual(errors, [])
    } finally { off() }
  } finally {
    composition?.stopIngress(); release?.(); await local?.dispose(); await composition?.dispose(); await adapter?.dispose(); await core?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(temp, { recursive: true, force: true })
  }
})
