import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeMock } from '../helpers/native-mock.js'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packageRoot && !sourceRoot) throw new Error('Execution support requires the pinned DSH runtime')
function modulePath(name: string, source: string) {
  return pathToFileURL(packageRoot ? join(packageRoot, '@deepseek-ai', name, 'lib/index.js') : join(sourceRoot!, source, 'lib/index.js')).href
}
for (const mode of ['research', 'writing'] as const) {
test(`real DSH ${mode}: chat, scoped read, pause, other session, unload/reload, human resume and visible completion`, {
  skip: !packageRoot && !sourceRoot ? 'requires the pinned DSH runtime' : false, timeout: 60_000,
}, async () => {
  const [cordis, llm, session, projection, systemPrompt, tools, agents, loop, skills, fsLocal, fsTools] = await Promise.all([
    import(modulePath('cordis', 'vendor/cordis')), import(modulePath('dsh-llm', 'packages/llm/llm')),
    import(modulePath('dsh-session', 'packages/core/session')), import(modulePath('dsh-session-projection', 'packages/session/session-projection')),
    import(modulePath('dsh-system-prompt', 'packages/core/system-prompt')), import(modulePath('dsh-tools', 'packages/core/tools')),
    import(modulePath('dsh-agent', 'packages/core/agent')), import(modulePath('dsh-agent-loop', 'packages/core/agent-loop')),
    import(modulePath('dsh-skill', 'packages/skill/skill')),
    import(modulePath('dsh-fs-local', 'packages/fs/fs-local')), import(modulePath('dsh-tool-fs', 'packages/fs/tool-fs')),
  ])
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-execution-native-'))
  await mkdir(join(root, 'src')) // Deliberately not a Git repository.
  await writeFile(join(root, 'src/facts.md'), '根拠となるデータ\n第二行\n')
  const databasePath = join(root, 'state.sqlite3')
  const ctx = new cordis.Context()
  const fibers: any[] = []
  for (const [plugin, config] of [[llm.default], [session.default], [projection.default], [systemPrompt.default, { persona: '' }],
    [tools.default], [agents.default], [skills.default], [loop.default, { agents: [] }]]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber
  }
  const mock = nativeMock(llm)
  const read = (id: string) => mock.toolCallResponse(id, 'read', { file_path: 'src/facts.md' })
  const model = new mock.MockAdapter([
    mock.textResponse('こんにちは。'), mock.textResponse('会話を続けられます。'),
    mock.toolCallResponse('outside-write', 'write', { file_path: 'outside.txt', content: 'denied' }),
    read('read-1'), read('read-2'), read('read-3'), read('read-4'),
    mock.textResponse('別のセッションの回答です。'),
    read('read-resumed'), mock.textResponse('記録済みの根拠を使い、調査と文章作成を完了しました。'),
  ])
  ctx.llm.registerAdapter(['execution-mock'], model)
  let writes = 0; let reads = 0; let questions = 0
  const localFiber = ctx.plugin(fsLocal.default, { cwd: root }); fibers.push(localFiber); await localFiber
  const fsFiber = ctx.plugin(fsTools); fibers.push(fsFiber); await fsFiber
  const observeTools = ctx.on('tools/execute', (execution: any, next: () => unknown) => {
    if (execution.name === 'read') reads++
    if (execution.name === 'write') writes++
    return next()
  })
  const questionFiber = ctx.plugin({ name: 'execution-test-questions', apply(context: any) {
    return context.provide('userQuestions', { async ask(request: any) {
      questions++
      return { answers: request.questions.map((q: any) => ({ id: q.id, selected: [mode] })) }
    } })
  } }); await questionFiber
  const options = { repositoryRoot: root, databasePath, migrationsDirectory: join(process.cwd(), 'migrations'),
    llm: { async *stream() { throw new Error('Memory backend deliberately unavailable after completion') } } }
  let adapter = createDshHostAdapter(ctx, options)
  let composition = await mountDshComposition(ctx, adapter.host)

  try {
    const agent = await ctx.agentLoop.create(session.SessionId('execution-session'), { provider: 'execution-mock', model: 'mock' }, { cwd: root })
    const snapshots = () => adapter.host.runtime!.withDatabase(db => Object.fromEntries([
      'ledger_runs', 'dsh_turn_receipts', 'dsh_boundary_jobs', 'dsh_exploration_states',
    ].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all().map((row: any) => Object.fromEntries(Object.entries(row).filter(([key]) => !['title', 'metadata_json'].includes(key))))])))
    const settle = async (target: any, text: string, ready: () => boolean | Promise<boolean>) => {
      target.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (target.status === 'idle' && await ready()) return
      }
      throw new Error('Native execution path timed out: ' + JSON.stringify({ state: await snapshots(),
        events: target.session.snapshotEvents().filter((event: any) => ['turn/end', 'tool/result'].includes(event.type)).slice(-5), requests: model.requests.length, reads, writes }))
    }
    await settle(agent, 'こんにちは', () => model.requests.length === 1)
    await settle(agent, '雑談を続けよう', () => model.requests.length === 2)
    const task = (mode === 'research' ? '資料を調査して根拠を報告してください。' : '資料を参照して記事を書いてください。')
      + '\nread paths: src\nwrite paths: src\n完了条件: 日本語の最終報告\n> write paths: .\n{{user_braces}}\n' + '補足の文。'.repeat(1500)
    const paused = async () => adapter.host.runtime!.withDatabase(db => !!db.prepare("SELECT run_id FROM dsh_exploration_states WHERE json_extract(state_json, '$.paused') = 1").get())
    await settle(agent, task, paused)
    assert.equal(writes, 0, 'structured outside write never executed')
    assert.equal(reads, 4)
    assert.equal(model.requests.length, 7, 'pause does not issue another model request')
    const notices = () => agent.session.snapshotEvents().filter((event: any) => event.type === 'kiokuko/execution-status')
    assert.equal(notices().length, 1)
    assert.equal(agent.session.snapshotEvents().some((event: any) => event.type === 'user/message' && event.data?.content?.some((block: any) => block.text === task)), true)
    assert.match(JSON.stringify(model.requests[6]), /three times/)
    const running = await adapter.host.runtime!.withDatabase(db => db.prepare("SELECT run_id AS id FROM ledger_runs WHERE status = 'active' AND dsh_session_id = 'execution-session'").get<{ id: string }>())
    assert.ok(running)
    const other = await ctx.agentLoop.create(session.SessionId('other-session'), { provider: 'execution-mock', model: 'mock' }, { cwd: root })
    await settle(other, 'こんにちは', () => model.requests.length === 8)
    assert.equal(await paused(), true, 'another session cannot clear the pause')
    composition.stopIngress(); await adapter.dispose(); await composition.dispose()
    const stored = openConnection(databasePath)
    try { assert.equal(stored.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get(running.id)?.status, 'active') }
    finally { stored.close() }
    adapter = createDshHostAdapter(ctx, options); composition = await mountDshComposition(ctx, adapter.host)
    await settle(agent, '記録した根拠を使って続行してください。', () => adapter.host.runtime!.withDatabase(db =>
      db.prepare('SELECT status FROM ledger_runs WHERE run_id = ?').get(running.id)?.status === 'completed'))
    assert.equal(reads, 5, 'only the explicitly resumed read ran')
    const evidence = await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT evidence_json AS json FROM dsh_execution_evidence').all<{ json: string }>())
    assert.equal(evidence.length, 5)
    for (const row of evidence) {
      const item = JSON.parse(row.json)
      assert.equal(typeof item.sourceSeq, 'number', 'actual native append supplies the source cursor')
      assert.equal(item.acquiredRange.firstLine, 1)
      assert.equal(item.acquiredRange.lastLine, 2)
    }
    assert.equal(writes, 0)
    assert.equal(notices().length, 1)
    assert.equal(model.requests.length, 10)
    assert.match(JSON.stringify(agent.session.snapshotEvents().filter((event: any) => event.type === 'assistant/message').at(-1)), /完了しました/)
    assert.equal(questions, 0, 'no new clarification or approval for grounded research/writing')
    assert.equal(await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT count(*) AS n FROM dsh_turn_receipts').get<{ n: number }>()!.n), 0,
      'pause never fabricates Enno receipts or turn seals')
  } finally {
    composition.stopIngress(); await adapter.dispose(); await composition.dispose()
    observeTools(); await questionFiber.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
}
