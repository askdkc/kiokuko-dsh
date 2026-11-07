import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountCore } from '../../../src/dsh/core/host.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { openConnection } from '../../../src/db/connection.js'
import { recordEntry, updateCandidateEntry } from '../../../src/memory/entries.js'
import { nativeMock } from '../helpers/native-mock.js'
import { mountNativeExecutor } from '../helpers/native-tools.js'
import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { codingPrelude } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { DshAnswerContext } from '../../../src/dsh/answer-context.js'
import { readRepositoryLearning } from '../../../src/memory/repository-learning.js'
import { setTimeout as delay } from 'node:timers/promises'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const implementation = packageRoot ? {
  mountCore: (await import(pathToFileURL(join(packageRoot, 'dist/dsh/core/index.js')).href)).mountCore,
  createDshHostAdapter: (await import(pathToFileURL(join(packageRoot, 'dist/dsh/host-adapter.js')).href)).createDshHostAdapter,
  mountDshComposition: (await import(pathToFileURL(join(packageRoot, 'dist/dsh/composition.js')).href)).mountDshComposition,
} : { mountCore, createDshHostAdapter, mountDshComposition }
const AnswerContext = packageRoot ? (await import(pathToFileURL(join(packageRoot, 'dist/dsh/answer-context.js')).href)).DshAnswerContext : DshAnswerContext
for (const mode of ['core', 'adapter'] as const) for (const [changes, timing] of [[0, 'stream'], [1, 'stream'], [3, 'stream'], [1, 'metadata'], [1, 'after-read'], [1, 'after-validation']] as const) {
  test(`${mode}: native memory rebuild delivers an update or omits continuously racing memory (${changes}, ${timing})`, { timeout: 30000 }, async t => {
    const [cordis, llm, session, projection, prompt, tools, agents, skills, commands, loop] = await Promise.all(
      ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-skill', 'dsh-commands', 'dsh-agent-loop']
        .map(name => import(name === 'dsh-agent-loop' ? new URL('../helpers/kiokuko-driver.mjs', import.meta.url).href : pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)))
    const root = await mkdtemp(join(tmpdir(), 'memory-rebuild-native-')), databasePath = join(root, 'state.sqlite3')
    const ctx = new cordis.Context(), fibers: any[] = [], requests: any[] = [], errors: unknown[] = [], failures: string[] = []
    let handle: { dispose(): Promise<unknown> } | undefined
    try {
      await mkdir(join(root, '.git'))
      for (const plugin of [llm, session, projection, prompt, tools, agents, skills, commands]) fibers.push(await ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined))
      await mountNativeExecutor(ctx, packages, fibers)
      fibers.push(await ctx.plugin(loop.default, { agents: [] }))
      fibers.push(await ctx.plugin({ name: 'memory-race-questions', apply(c: any) { return c.provide('userQuestions', { async ask(request: any) {
        if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, 'decision OFF / Lisp OFF')
        throw new Error('Unexpected question')
      } }) } }))
      const config = { repositoryRoot: root, databasePath, intakeMode: 'eager' as const, answerReview: { mode: 'off' as const }, memoryIndexReasoning: { mode: 'off' as const }, typedDecisions: { mode: 'off' as const } }
      if (mode === 'core') handle = await implementation.mountCore(ctx, config)
      else {
        const adapter = implementation.createDshHostAdapter(ctx, { ...config, agenticReplay: { enabled: false }, toolExposure: { mode: 'full' } })
        handle = await implementation.mountDshComposition(ctx, adapter.host)
      }
      const db = openConnection(databasePath)
      const workspace = db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{ workspace: string }>()!.workspace
      let memory = recordEntry(db, { workspace, kind: 'fact', title: 'RACEWORDS', body: 'RACEWORDS original fact.', scope: { visibility: 'project' } })
      db.close()
      const mock = nativeMock(llm)
      class Provider extends llm.LlmAdapter {
        async listModels(provider: string) { return [{ provider, id: 'fixed', name: 'fixed' }] }
        async resolveModel(provider: string, id: string) { return { provider, id, name: id, context: { contextWindow: 200000 } } }
        async *stream(request: any) {
          // Count foreground dispatches only; post-turn reflection is independently covered.
          if (String(request.system).startsWith('Extract compact repository-scoped learning')) {
            yield* mock.textResponse('{"lessons":[]}'); return
          }
          requests.push(request); yield* mock.textResponse('Acknowledged.')
        }
      }
      ctx.llm.registerAdapter(['memory-race'], new Provider())
      ctx.on('agent/error', (event: any) => errors.push(event.error))
      const agent = (await ctx.agents.create({ sessionId: session.SessionId('memory-race'), agentOptions: { provider: 'memory-race', model: 'fixed' }, meta: { cwd: root } })).agent
      agent.ctx.on('agent/request-error', (event: any, next: () => unknown) => { failures.push(event.failure?.code); return next() }, { prepend: true })
      const turn = async () => { agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'RACEWORDS の内容を説明して。' }] })); await agent.whenIdle(); assert.deepEqual(errors, []) }
      await turn()
      assert.match(JSON.stringify(requests.at(-1).messages), /RACEWORDS original fact/)
      let updates = 0
      const update = () => {
        const db = openConnection(databasePath)
        updates++
        try { memory = updateCandidateEntry(db, { workspace, entryId: memory.id, expectedRevision: memory.revision, kind: 'fact', title: 'RACEWORDS',
          body: timing === 'metadata' ? memory.body : `RACEWORDS updated fact ${updates}.`, scope: { visibility: 'project' },
          ...(timing === 'metadata' ? { provenance: { type: 'manual', reference: 'refreshed-source-metadata' } } : {}) }) } finally { db.close() }
      }
      if (timing === 'after-read' || timing === 'after-validation') {
        const method = timing === 'after-read' ? 'prepare' : 'fence'
        const original = AnswerContext.prototype[method]
        t.mock.method(AnswerContext.prototype, method, async function (this: DshAnswerContext, ...args: any[]) {
          const result = await original.apply(this, args)
          if (!updates) update()
          return result
        })
      }
      const release = agent.ctx.on('llm/stream', (request: any, next: () => AsyncIterable<unknown>) => (async function* () {
        if (changes === 0) {
          const db = openConnection(databasePath)
          try { const saved = recordEntry(db, { workspace, kind: 'fact', title: memory.title, body: memory.body, scope: memory.scope }); assert.equal(saved.id, memory.id); assert.equal(saved.revision, memory.revision) } finally { db.close() }
        }
        if ((timing === 'stream' || timing === 'metadata') && updates < changes && JSON.stringify(request.messages).includes(memory.body)) update()
        yield* next()
      })(), { prepend: true })
      const sent = requests.length
      await turn()
      release()
      assert.equal(requests.length, sent + 1, 'only one provider dispatch after pre-send recovery')
      if (changes > 0 && timing !== 'metadata') assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /RACEWORDS original fact/)
      if (changes <= 1) assert.ok(JSON.stringify(requests.at(-1).messages).includes(memory.body), 'reconstructed memory must reach the actual provider')
      else {
        assert.equal(updates, 2, 'one refresh followed by memory-free fallback, without replaying the same state')
        assert.ok(!requests.at(-1).messages.some((m: any) => m.source?.sections?.some((s: any) => s.name.startsWith('memory:memory:'))))
      }
      assert.ok(!failures.includes('DSH_MEMORY_REBUILD_EXHAUSTED'))
      if (changes === 0) assert.deepEqual(failures, [], 'idempotent storage must not cause a request rebuild')
      await turn()
      assert.ok(JSON.stringify(requests.at(-1).messages).includes(memory.body), 'memory retrieval resumes on the next turn')
    } finally { await handle?.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })
}

for (const explicit of [false, true]) for (const changes of [1, 3]) test(`${explicit ? 'adapter' : 'core'}: execution refresh never repeats a completed write (${changes})`, { timeout: 30000 }, async () => {
  const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), explicit, approveMemory: changes === 3, startupChoice: 'decision OFF / Lisp OFF',
    extra: { lisp: { enabled: false }, answerReview: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' }, modelAutoMode: { mode: 'off' } } })
  const db = openConnection(join(f.dir, explicit ? 'state.sqlite3' : 'kiokuko-dsh.sqlite3'))
  let updates = 0, writes = 0
  let reflections = 0
  const originalStream = f.model.stream.bind(f.model)
  if (changes === 3) f.model.stream = async function* (request: any) {
    if (String(request.system).startsWith('Extract compact repository-scoped learning')) {
      const evidence = JSON.parse(request.messages[0].content[0].text)
      reflections++
      yield* f.mock.textResponse(JSON.stringify({ lessons: reflections === 1 ? [{
        hypothesis: 'RECOVERED_RACECODE: parser file writing completed once.',
        applicability: 'This repository parser only; verification is still pending.',
        nextAction: 'Check the written parser file.', verifyWith: 'Run parser assertions.', evidenceRefs: [evidence.evidenceRefs[0]],
      }] : [] }))
      return
    }
    if (request.purpose === 'compaction') { yield* f.mock.textResponse('{"schemaVersion":4,"memoryOperations":[]}'); return }
    yield* originalStream(request)
  }
  try {
    await mkdir(join(f.dir, 'src'))
    const workspace = db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{ workspace: string }>()!.workspace
    let memory = recordEntry(db, { workspace, kind: 'lesson', title: 'RACECODE parser', body: 'RACECODE original parser guidance.', scope: { visibility: 'project' }, provenance: { type: 'interaction_capture', reference: 'user_correction' } })
    const releaseWrite = f.agent.ctx.on('tools/post-execute', async (execution: any, result: unknown, next: () => Promise<unknown>) => { if (execution.callId === 'single-write') writes++; return next() })
    const release = f.agent.ctx.on('llm/stream', (request: any, next: () => AsyncIterable<unknown>) => (async function* () {
      if (updates < changes && nativeToolResults(request.messages ?? []).some(result => result.toolCallId === 'single-write') && JSON.stringify(request.messages).includes(memory.body)) {
        memory = updateCandidateEntry(db, { workspace, entryId: memory.id, expectedRevision: memory.revision, kind: 'lesson', title: memory.title,
          body: `RACECODE revised parser guidance ${++updates}.`, scope: memory.scope, provenance: memory.provenance })
      }
      yield* next()
    })(), { prepend: true })
    f.responses.push(...codingPrelude(f.mock, 'memory-race'), f.mock.toolCallResponse('single-write', 'kioku_write', { path: 'src/parser.mjs', content: 'export const value = 42\n' }),
      (request: any) => {
        assert.equal(nativeToolResults(request.messages).filter(result => result.toolCallId === 'single-write').length, 1)
        assert.equal(nativeToolResults(request.messages).find(result => result.toolCallId === 'single-write').isError, false)
        assert.ok(!JSON.stringify(request.messages).includes('RACECODE original parser guidance.'))
        if (changes === 1) assert.ok(JSON.stringify(request.messages).includes(memory.body), 'refreshed execution correction reaches the provider')
        else assert.ok(!request.messages.some((m: any) => m.source?.sections?.some((s: any) => s.name.startsWith('memory:memory:'))))
        return f.mock.textResponse('The file is written; verification remains pending.')
      })
    await f.turn('Implement the RACECODE parser in src/parser.mjs. 通常実行で。')
    assert.equal(updates, changes === 1 ? 1 : 2)
    assert.equal(writes, 1, 'a memory rebuild never reexecutes the completed file write')
    assert.equal(f.responses.length, 0)
    release(); releaseWrite()
    if (changes === 3) {
      const deadline = Date.now() + 10000
      while (readRepositoryLearning(db, f.dir).revision === 0 && Date.now() < deadline) await delay(10)
      assert.ok(reflections >= 1, 'memory generation still runs after memory-free request recovery')
      assert.match(readRepositoryLearning(db, f.dir).compact, /RECOVERED_RACECODE/)
      assert.deepEqual(f.memoryQuestions.map(q => q.options[0].label), ['この内容を保存する'])
      assert.match(f.memoryQuestions[0].detail, /RECOVERED_RACECODE/, 'the exact generated content is displayed before storage')
      f.responses.push((request: any) => {
        assert.match(JSON.stringify(request.messages), /RECOVERED_RACECODE/, 'approved learning is usable on the next turn')
        return f.mock.textResponse('The saved parser observation is available.')
      })
      await f.turn('Explain the saved RACECODE observation. Do not change files.')
    }
  } finally { db.close(); await f.close() }
})
