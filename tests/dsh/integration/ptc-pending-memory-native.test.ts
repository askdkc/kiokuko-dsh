/** Actual published native PTC regression; the model is scripted and no paid API is called. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { mountCore } from '../../../src/dsh/core/index.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { DshIntakeGate } from '../../../src/dsh/intake-gate.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { openConnection } from '../../../src/db/connection.js'
import { nativeMock } from '../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const available = packages !== undefined && existsSync(join(packages, '@deepseek-ai/dsh/package.json'))
if (!available && (packages !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1')) throw new Error('PTC memory native coverage requires an installed pinned DSH package root')
async function runPendingMemory(hostMode: 'core' | 'full') {
  const checkout = process.cwd()
  const version = JSON.parse(await readFile(join(packages!, '@deepseek-ai/dsh/package.json'), 'utf8')).version
  assert.ok(['0.1.5-rc.1', '0.2.0-rc.2'].includes(version))
  if (process.env.KIOKUKO_EXPECTED_DSH_VERSION) assert.equal(version, process.env.KIOKUKO_EXPECTED_DSH_VERSION)
  const load = (name: string) => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)
  const [cordis, llm, sessions, projections, prompt, tools, agents, loop, skills, commands] = await Promise.all([
    'cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-skill', 'dsh-commands',
  ].map(load))
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'native-ptc-memory-')))
  execFileSync('git', ['init', '-q', root]); await mkdir(join(root, 'src'))
  const databasePath = join(root, 'memory.sqlite3'), ctx = new cordis.Context(), fibers: any[] = []
  let core: any, adapter: any, composition: any, handle: any, restoreRuntime: (() => void) | undefined, restoreGate: (() => void) | undefined
  const row: any = { mode: 'global', hostMode, requests: [], errors: [], runtimePrograms: [], questions: [], results: [] }
  try {
    if (hostMode === 'full') {
      const originalPrepare = DshIntakeGate.prototype.prepare
      row.prepareInputs = []
      DshIntakeGate.prototype.prepare = function (event: any) {
        row.prepareInputs.push({ sessionId: event.sessionId, agentId: event.agent.id, turn: event.turn, sourceStartSeq: event.sourceStartSeq ?? null, task: event.task, cwd: event.cwd, profileHints: event.profileHints, deferTaskTypeInference: event.deferTaskTypeInference, evidence: event.evidence, skillDiscoveryMode: event.skillDiscoveryMode, capabilities: event.capabilities })
        return originalPrepare.call(this, event)
      }
      restoreGate = () => { DshIntakeGate.prototype.prepare = originalPrepare }
    }
    const runtimePlugins: any[][] = []
    if (version.startsWith('0.1.5')) runtimePlugins.push([(await load('dsh-code-runtime-worker-thread')).default])
    else for (const [name, config] of [['dsh-fs-local', { cwd: root }], ['dsh-subprocess-local', undefined], ['dsh-sandbox-local', undefined], ['dsh-sandbox-policy', { mode: 'read-only', workspaceRoot: root }], ['dsh-ptc-runtime-node', { timeoutMs: 10000 }]] as const) runtimePlugins.push([(await load(name)).default, config])
    for (const [plugin, config] of [[llm.default], [sessions.default], [projections.default], [prompt.default, { persona: '' }], ...runtimePlugins,
      [tools.default, { mode: 'ptc' }], [agents.default], [skills.default], [commands.default], [loop.default, { agents: [] }]]) {
      const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber
    }
    const runtime = ctx.get(version.startsWith('0.1.5') ? 'codeRuntime' : 'ptcRuntime', false)
    const originalRun = runtime.run
    runtime.run = function (...args: any[]) { row.runtimePrograms.push(args[0]?.code ?? args[0]?.source?.code); return originalRun.apply(this, args) }
    restoreRuntime = () => { runtime.run = originalRun }
    const q = ctx.plugin({ name: 'ptc-memory-questions', apply(c: any) { return c.provide('userQuestions', { async ask(request: any) { row.questions.push(request.questions); return { answers: request.questions.map((question: any) => { if (question.id !== 'enno-execution-mode') throw new Error('Unexpected interactive question'); return { id: question.id, selected: ['通常実行'] } }) } } }) } }); fibers.push(q); await q
    ctx.on('agent/error', ({ error }: any) => row.errors.push(String(error?.stack ?? error)))
    const mock = nativeMock(llm)
    function messageResult(callId: string) {
      const event = handle.agent.session.snapshotEvents().filter((e: any) => e.type === 'tool/result' && (e.data.message?.toolCallId === callId || e.data.message?.source?.callId === callId)).at(-1)
      assert.ok(event, `missing native result ${callId}`)
      const message = event.data.message
      const content = message.role === 'tool' ? message.content : message.content.flatMap((block: any) => block.type === 'tool-result' ? block.content : [])
      const text = content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
      return { message, text, isError: message.isError ?? message.content.find((block: any) => block.type === 'tool-result')?.isError }
    }
    class Scripted extends llm.LlmAdapter {
      async listModels(provider: string) { return [{ provider, id: 'fixture', name: 'fixture' }] }
      async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
      async *stream(options: any) {
        if (options.purpose === 'compaction') { yield* mock.textResponse('[]'); return }
        const names = options.tools.map((t: any) => t.name)
        const step = row.requests.push({ tools: names, sessionId: options.sessionId })
        let response: any[]
        if (step === 1) {
          assert.deepEqual(names, ['run_code'])
          response = mock.toolCallResponse('prepare', 'run_code', { description: 'Prepare requested work only', code: 'return await tools.prepare_requested_work({"taskType":"build"})' })
        } else if (step === 2) {
          row.registryModeAfterPreparation = ctx.tools.modeFor(handle.agent)
          const diagnostic = openConnection(databasePath)
          try { row.bindingsAfterPreparation = diagnostic.prepare('SELECT mode,required_json FROM task_memory_bindings').all() } finally { diagnostic.close() }
          row.preparation = messageResult('prepare')
          assert.equal(row.runtimePrograms.length, 0, 'carrier must not invoke interpreter')
          assert.ok(names.includes('task_memory_review'), 'pending memory must expose the direct review surface')
          assert.ok(names.includes('run_code'), 'pending presentation must preserve the bound capability inventory')
          row.preparation = messageResult('prepare')
          assert.equal(row.preparation.isError, false)
          response = mock.toolCallResponse('status', 'task_memory_review', { action: 'status' })
        } else if (step === 3) {
          row.status = JSON.parse(messageResult('status').text)
          assert.equal(row.status.pending[0]?.problem, 'decision_missing')
          response = mock.toolCallResponse('premature', 'run_code', { description: 'Attempt arbitrary program before memory review', code: 'return "MUST_NOT_RUN"' })
        } else if (step === 4) {
          row.premature = messageResult('premature'); assert.equal(row.premature.isError, false)
          assert.ok(row.premature.text.includes('MUST_NOT_RUN'), 'an unresolved decision must never block the program')
          assert.equal(row.runtimePrograms.length, 1, 'the program runs while the decision is unresolved')
          assert.ok(names.includes('task_memory_review'))
          const item = row.status.pending[0]
          response = mock.toolCallResponse('review', 'task_memory_review', { action: 'review', review: {
            generation: row.status.generation, entryId: item.entryId, entryRevision: item.revision, expectedRevision: 0,
            decision: 'not_applicable', paths: [], basis: 'The stored production-migration lesson does not apply to this fixed isolated protocol fixture.',
          } })
        } else if (step === 5) {
          row.review = messageResult('review'); assert.equal(row.review.isError, false)
          assert.deepEqual(names, ['run_code'], 'PTC-only presentation must return after memory decisions')
          response = mock.toolCallResponse('work', 'run_code', { description: 'Perform prepared work after memory review', code: 'return "PTC_MEMORY_REVIEW_COMPLETE"' })
        } else if (step === 6) {
          row.work = messageResult('work'); assert.equal(row.work.isError, false)
          assert.ok(row.work.text.includes('PTC_MEMORY_REVIEW_COMPLETE'))
          assert.equal(row.runtimePrograms.length, 2, 'the unresolved-decision program and the approved later program both invoke the actual PTC runtime')
          response = mock.textResponse('SCRIPTED_COMPLETION')
        } else throw new Error('Unexpected native model request')
        yield* response
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Scripted())
    const config = { repositoryRoot: root, databasePath, migrationsDirectory: join(checkout, 'migrations'), typedDecisions: { mode: 'off' }, modelAutoMode: { mode: 'off' }, answerReview: { mode: 'off' }, semanticCompaction: { mode: 'off' }, memoryReuse: { mode: 'off' } } as const
    assert.equal(Object.hasOwn(config, 'intakeMode'), false)
    if (hostMode === 'core') core = await mountCore(ctx, config)
    else {
      adapter = createDshHostAdapter(ctx, { ...config, orca: { enabled: false }, memoryIndexReasoning: { mode: 'off' }, llm: { async *stream() { throw new Error('Optional finalizer disabled for isolated PTC protocol proof') } } })
      composition = await mountDshComposition(ctx, adapter.host)
    }
    const db = openConnection(databasePath)
    try {
      const workspace = db.prepare('SELECT workspace FROM repositories LIMIT 1').get<{ workspace: string }>()!.workspace
      row.memory = recordEntry(db, { workspace, kind: 'lesson', title: 'migration expectations', body: 'Current migration expectations must include the next migration.', createdBy: 'fixture', scope: { visibility: 'project' } })
    } finally { db.close() }
    handle = await ctx.agents.create({ sessionId: sessions.SessionId(`ptc-memory-${hostMode}`), agentOptions: { provider: 'fixture', model: 'fixture' }, meta: { cwd: root } })
    handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Implement migration expectations' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    row.results = handle.agent.session.snapshotEvents().filter((e: any) => e.type === 'tool/result').map((e: any) => e.data.message)
    assert.deepEqual(row.errors, [])
    assert.equal(row.requests.length, 6)
    assert.equal(row.questions.length, hostMode === 'core' ? 0 : 1)
    const final = openConnection(databasePath)
    try { row.bindings = final.prepare('SELECT mode,required_json FROM task_memory_bindings').all(); row.reviews = final.prepare('SELECT review_json FROM task_memory_reviews').all() } finally { final.close() }
    assert.equal(row.reviews.length, 1)
    if (hostMode === 'full') assert.equal(new Set(row.prepareInputs.map((input: any) => input.capabilities.digest)).size, 1, 'host-owned review presentation must not change bound catalog identity')
    row.passed = true
  } finally {
    restoreRuntime?.(); restoreGate?.()
    try {
      await composition?.dispose(); await adapter?.dispose(); await core?.dispose(); await handle?.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

for (const hostMode of ['core', 'full'] as const) test(`native ${hostMode}: pending memory never blocks prepared PTC work and direct review completes the obligation`, {
  skip: available ? false : 'requires explicit pinned DSH native package root', timeout: 120_000,
}, () => runPendingMemory(hostMode))
