import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, seed, NOW } from './fixture.js'
import { openConnection } from '../../../../src/db/connection.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { resolveProjectWorkspace } from '../../../../src/memory/workspaces.js'
import { configureEvolution, evolutionSettings, scheduleEvolution } from '../../../../src/memory/evolution/store.js'
import { MemoryEvolutionConfig } from '../../../../src/memory/evolution/contracts.js'
import { DshMemoryFinalizer, type DshLlm } from '../../../../src/dsh/session-memory-finalizer.js'
import { prepareAgentTask } from '../../../../src/dsh/task-intake.js'
import { injectDshContext } from '../../../../src/dsh/context-injection.js'
import { readEntry, updateCandidateEntry } from '../../../../src/memory/entries.js'
import type { DshRuntime } from '../../../../src/dsh/runtime.js'

test('default host startup reuses an observed lesson in a new session after reopening the database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-next-session-'))
  await mkdir(join(root, '.git'))
  const databasePath = join(root, 'memory.sqlite3')
  let db = fixture(databasePath).db
  const runtime: Pick<DshRuntime, 'withDatabase'> = {
    withDatabase: async operation => operation(db, undefined as never),
  }
  let host: DshMemoryFinalizer | undefined
  let calls = 0
  try {
    const project = (await resolveProjectWorkspace(db, root))!
    const episodes = ['prior-a', 'prior-b', 'prior-c'].map(id => seed(db, id, { workspace: project.workspace }))
    const draft = episodes[0]!.draft
    const llm: DshLlm = { async *stream() {
      calls++
      yield { type: 'text-delta', text: JSON.stringify({
        applicability: draft.applicability, procedure: draft.procedure, verification: draft.verification,
        boundary: draft.boundary, evidence: episodes.map(e => e.runId), conflict: false,
      }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    // Produce a candidate using the public observe configuration, then close the host.
    host = new DshMemoryFinalizer({ runtime, llm, memoryEvolution: MemoryEvolutionConfig.parse({ mode: 'observe' }), now: () => NOW })
    withImmediateTransaction(db, () => scheduleEvolution(db, 'prior-c', { provider: 'original', model: 'original', contextWindow: 100000 }, NOW))
    await host.start()
    await host.whenIdle()
    const lessonId = db.prepare("SELECT entry_id AS id FROM memory_derivations WHERE kind='positive'").get<{ id: string }>()!.id
    assert.equal(calls, 1)
    assert.equal(evolutionSettings(db).mode, 'observe')
    await host.dispose()
    db.close()

    // Startup with default public config repairs the former forced-observe state.
    db = openConnection(databasePath)
    host = new DshMemoryFinalizer({ runtime, llm, now: () => NOW })
    const generation = evolutionSettings(db).generation
    await host.start()
    await host.whenIdle()
    assert.equal(evolutionSettings(db).mode, 'active')
    assert.equal(evolutionSettings(db).generation, generation + 1)
    assert.equal(calls, 1, 'Stored candidates must not need another model request')

    const task = 'Diagnose SQLITE_BUSY in sqlite migration 3.46 using prior observations.'
    const prepare = (session: string) => prepareAgentTask(db, {
      cwd: root, requestId: session, dshSessionId: session, task, executionSelection: true,
      profileHints: { taskType: 'debug', target: 'sqlite migration', expected: 'Migration completes without SQLITE_BUSY', constraints: 'Keep existing data' },
      capabilities: ['kiokuko-soul', 'kiokuko-single-purpose-functions', 'memory-reasoning'].map(name => ({ kind: 'skill', name })),
      skillDiscoveryMode: 'off', maxContextChars: 16000,
    })
    const prepared = await prepare('new-native-session')
    assert.equal(prepared.nextAction, 'proceed')
    assert.ok(prepared.context?.items.some(item => item.entryId === lessonId), JSON.stringify({ expectedLesson: lessonId, project: prepared.project.workspace, context: prepared.context, policy: prepared.memoryPolicy }))
    const messages = await injectDshContext({ prepared, task, runtime })
    const memory = messages.filter(message => message.source === 'memory').map(message => message.content).join('\n')
    assert.ok(memory.includes(draft.procedure), 'The observed procedure must reach the model context')
    assert.match(memory, /Unverified|未検証/u)
    assert.equal(calls, 1, 'Retrieval and injection do not call the generation model')
    const lesson = readEntry(db, { workspace: project.workspace, entryId: lessonId })
    assert.equal(lesson.status, 'candidate')
    assert.equal(lesson.trustLevel, 'untrusted')

    configureEvolution(db, 'off')
    await assert.rejects(injectDshContext({ prepared, task, runtime }), /no longer retrievable/u)
    configureEvolution(db, 'observe')
    const observed = await prepare('explicit-observe-session')
    assert.ok(!observed.context?.items.some(item => item.entryId === lessonId))
    assert.ok(observed.context?.items.some(item => episodes.some(e => e.sources.some(s => s.entryId === item.entryId))))

    configureEvolution(db, 'active')
    const source = readEntry(db, { workspace: project.workspace, entryId: episodes[0]!.sources[0]!.entryId })
    updateCandidateEntry(db, { workspace: source.workspace, entryId: source.id, expectedRevision: source.revision,
      kind: source.kind, title: source.title, body: 'This source has changed.', now: '2026-09-10T00:00:01.000Z' })
    const stale = await prepare('source-changed-session')
    assert.ok(!stale.context?.items.some(item => item.entryId === lessonId), 'Active must still exclude invalidated lessons')
  } finally {
    await host?.dispose()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
