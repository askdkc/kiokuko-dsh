import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { DshMemoryFinalizer, type DshSessionLogSnapshot } from '../../../src/dsh/session-memory-finalizer.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { type EfficiencyObservation, DshEfficiencyObserver } from '../../../src/dsh/efficiency.js'
import { FINALIZATION_STREAM_MAX_BYTES } from '../../../src/dsh/finalization-request.js'

async function fixture(migrationsDirectory = join(process.cwd(), 'migrations')): Promise<{ root: string; database: SqliteDatabase; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-finalizer-'))
  await mkdir(join(root, '.git'))
  const database = openConnection(join(root, 'data.sqlite3'))
  migrateDatabase(database, migrationsDirectory)
  registerRepositoryAndLocation(database, {
    repositoryId: 'repo-finalizer', workspace: 'workspace-finalizer', displayName: 'finalizer',
    canonicalRoot: realpathSync(root), remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1,
  })
  new LedgerStore(database).createRun({
    runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', protocolVersion: '1',
    captureProfile: 'minimal',
    coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
    task: { title: 'finish work', query: 'finish work', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
  })
  return {
    root,
    database,
    cleanup: async () => { database.close(); await rm(root, { recursive: true, force: true }) },
  }
}

function snapshot(): DshSessionLogSnapshot {
  const user = { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Implement the durable design.' }], source: { kind: 'user' } }
  const result = {
    id: 'tool-result-1', role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: `important\n${'x'.repeat(70_000)}` }] }],
    source: { kind: 'tool', callId: 'read-1' },
  }
  const assistant = {
    id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'Implemented and verified.' }],
    source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
  }
  return {
    session: { id: 'archived-dsh-session', createdAt: 1, cwd: '/archived/project' },
    inheritedEventCount: 0,
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: user, surfaceOp: 'append' },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'test-provider', model: 'test-model' }, system: 'system-prefix', tools: [{ name: 'Read', description: 'read', parameters: {} }] }, reason: 'initial' } },
      { type: 'request/context', seq: 3, time: 4, data: { provider: 'test-provider', model: 'test-model', contextWindow: 1_000_000 } },
      { type: 'tool/call', seq: 4, time: 5, data: { callId: 'read-1', name: 'Read', arguments: '{"path":"large.txt"}' } },
      { type: 'tool/result', seq: 5, time: 6, data: { message: result }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 6, time: 7, data: { message: assistant, usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 18_000 } }, surfaceOp: 'append' },
      { type: 'goal/change', seq: 7, time: 8, data: { kind: 'goal/change', version: 1, operation: 'complete', goal: { objective: 'Durable memory', phase: 'complete' } } },
      { type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 9, time: 10, data: { turn: 2 } },
      { type: 'user/message', seq: 10, time: 11, data: { id: 'future-user', role: 'user', content: [{ type: 'text', text: 'FUTURE RUN MUST NOT LEAK' }], source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 11, time: 12, data: { turn: 2, reason: { kind: 'completed' } } },
    ],
  }
}

test('version-10 pending finalization upgrades with prefix mode and unchanged job identity', async () => {
  const legacy = await mkdtemp(join(tmpdir(), 'kiokuko-finalizer-v10-'))
  const source = join(process.cwd(), 'migrations')
  for (const file of await readdir(source)) if (/^00\d_|^010_/u.test(file)) await copyFile(join(source, file), join(legacy, file))
  const f = await fixture(legacy)
  try {
    f.database.prepare('INSERT INTO dsh_run_log_boundaries (run_id, workspace, dsh_session_id, source_start_seq, source_start_turn, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)')
      .run('run-finalizer', 'workspace-finalizer', 'archived-dsh-session', '2026-09-09', '2026-09-09')
    new LedgerStore(f.database).updateRunStatusInTransaction('run-finalizer', 'completed')
    f.database.prepare("INSERT INTO dsh_memory_finalizations (run_id, workspace, dsh_session_id, source_start_seq, source_end_seq, status, attempt_count, scheduled_at, updated_at) VALUES (?, ?, ?, 0, 8, 'pending', 1, ?, ?)")
      .run('run-finalizer', 'workspace-finalizer', 'archived-dsh-session', '2026-09-09', '2026-09-09')
    assert.deepEqual(migrateDatabase(f.database, source).applied, [11, 12, 13])
    const row = f.database.prepare('SELECT input_mode AS mode, attempt_count AS attempts, status, source_end_seq AS end FROM dsh_memory_finalizations').get()
    assert.deepEqual({ ...row }, { mode: 'prefix_reuse', attempts: 1, status: 'pending', end: 8 })
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await f.cleanup(); await rm(legacy, { recursive: true, force: true }) }
})

function runtime(database: SqliteDatabase) {
  return {
    async withDatabase<T>(operation: (database: SqliteDatabase, embedding: never) => T | PromiseLike<T>): Promise<T> {
      return await operation(database, undefined as never)
    },
  }
}

test('new DSH run creation and its turn-start boundary commit atomically', async () => {
  const f = await fixture()
  try {
    const beforeRuns = f.database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()!.count
    await assert.rejects(prepareAgentTask(f.database, {
      requestId: 'atomic-invalid-boundary',
      task: 'hello',
      cwd: f.root,
      profileHints: { taskType: 'chat', target: null, expected: null, constraints: null },
      capabilities: [],
      dshSessionId: 'atomic-session',
      dshLogStart: { sourceStartSeq: -1, sourceStartTurn: 1 },
      skillDiscoveryMode: 'off',
    }), /sourceStartSeq/u)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get<{ count: number }>()!.count, beforeRuns)
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM dsh_run_log_boundaries').get<{ count: number }>()!.count, 0)

    const prepared = await prepareAgentTask(f.database, {
      requestId: 'atomic-valid-boundary',
      task: 'hello',
      cwd: f.root,
      profileHints: { taskType: 'chat', target: null, expected: null, constraints: null },
      capabilities: [],
      dshSessionId: 'atomic-session',
      dshLogStart: { sourceStartSeq: 12, sourceStartTurn: 2 },
      skillDiscoveryMode: 'off',
    })
    const boundary = f.database.prepare(`
      SELECT source_start_seq AS sourceStartSeq, source_start_turn AS sourceStartTurn
        FROM dsh_run_log_boundaries WHERE run_id = ?
    `).get<{ sourceStartSeq: number; sourceStartTurn: number }>(prepared.run.runId)
    assert.equal(boundary?.sourceStartSeq, 12)
    assert.equal(boundary?.sourceStartTurn, 2)
  } finally {
    await f.cleanup()
  }
})

test('completed run finalizes once from an archived DSH log and stores a self-contained bounded capsule', async () => {
  const f = await fixture()
  const calls: Array<Record<string, unknown>> = []
  let reads = 0
  const finalizer = new DshMemoryFinalizer({
    runtime: runtime(f.database),
    sessionQuery: { async readSession(sessionId) { reads += 1; assert.equal(sessionId, 'archived-dsh-session'); return snapshot() } },
    llm: { async * stream(options) {
      calls.push(options as Record<string, unknown>)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({
        schemaVersion: 1,
        memories: [{ kind: 'decision', title: 'Use the DSH log as source of truth', body: 'Finalize memory only after DSH completes and persists its canonical log.', summary: 'Post-completion DSH-log finalization.', confidence: 0.98, tags: ['architecture'] }],
      }) }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 800, cacheWriteTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    now: () => '2026-09-04T00:00:00.000Z',
  })
  try {
    await finalizer.start()
    await finalizer.bindRunStart({ runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceStartSeq: 0, sourceStartTurn: 1 })
    withImmediateTransaction(f.database, () => {
      new LedgerStore(f.database).updateRunStatusInTransaction('run-finalizer', 'completed')
      finalizer.scheduleInTransaction(f.database, { runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceEndSeq: 8 })
    })
    finalizer.kick()
    await finalizer.whenIdle()

    const job = f.database.prepare(`
      SELECT status, source_start_seq AS sourceStartSeq, source_end_seq AS sourceEndSeq,
             log_event_count AS logEventCount,
             capsule_bytes AS capsuleBytes, cache_read_tokens AS cacheReadTokens
        FROM dsh_memory_finalizations WHERE run_id = ?
    `).get<{ status: string; sourceStartSeq: number; sourceEndSeq: number; logEventCount: number; capsuleBytes: number; cacheReadTokens: number }>('run-finalizer')
    assert.equal(job?.status, 'completed')
    assert.equal(job?.sourceStartSeq, 0)
    assert.equal(job?.sourceEndSeq, 8)
    assert.equal(job?.logEventCount, 9)
    assert.equal(job?.cacheReadTokens, 800)
    assert.ok(job!.capsuleBytes <= 65_536)
    assert.equal(reads, 1)
    assert.equal(calls.length, 1)
    const request = calls[0]!
    assert.equal(request.provider, 'test-provider')
    assert.equal(request.model, 'test-model')
    assert.equal(request.system, 'system-prefix')
    assert.equal((request.tools as unknown[]).length, 1)
    const messages = request.messages as Array<Record<string, unknown>>
    assert.equal(messages[0]?.id, 'user-1')
    assert.equal(messages[1]?.id, 'tool-result-1')
    assert.equal(messages[2]?.id, 'assistant-1')
    assert.match(JSON.stringify(messages.at(-1)), /weighted-dsh-log-evidence/u)
    assert.doesNotMatch(JSON.stringify(messages), /FUTURE RUN MUST NOT LEAK/u)
    assert.throws(() => f.database.prepare(`
      UPDATE dsh_run_log_boundaries SET source_start_seq = 1 WHERE run_id = ?
    `).run('run-finalizer'), /scheduled log boundary is immutable/u)
    assert.throws(() => f.database.prepare(`
      UPDATE dsh_memory_finalizations SET source_end_seq = 11 WHERE run_id = ?
    `).run('run-finalizer'), /source range is immutable/u)

    const entry = f.database.prepare(`
      SELECT revision.title, revision.body, revision.provenance_json AS provenance
        FROM dsh_memory_finalization_entries AS link
        JOIN entries AS entry ON entry.id = link.entry_id
        JOIN entry_revisions AS revision ON revision.entry_id = entry.id AND revision.revision = entry.current_revision
       WHERE link.run_id = ?
    `).get<{ title: string; body: string; provenance: string }>('run-finalizer')
    assert.equal(entry?.title, 'Use the DSH log as source of truth')
    assert.match(entry?.body ?? '', /after DSH completes/u)
    assert.match(entry?.provenance ?? '', /archived-dsh-session/u)
    assert.equal(new LedgerStore(f.database).readEvents('run-finalizer').some((event) => event.event_type === 'source.event'), false)

    // Repeated scheduling is idempotent and never re-reads the archived log.
    withImmediateTransaction(f.database, () => finalizer.scheduleInTransaction(f.database, { runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceEndSeq: 8 }))
    finalizer.kick()
    await finalizer.whenIdle()
    assert.equal(reads, 1)
  } finally {
    await finalizer.dispose()
    await f.cleanup()
  }
})

test('summary failure is contained, leaves the DSH run completed, and can be retried', async () => {
  const f = await fixture()
  let fail = true
  const finalizer = new DshMemoryFinalizer({
    runtime: runtime(f.database),
    sessionQuery: { async readSession() { return snapshot() } },
    llm: { async * stream() {
      if (fail) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: '{"schemaVersion":1,"memories":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  })
  try {
    await finalizer.bindRunStart({ runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceStartSeq: 0, sourceStartTurn: 1 })
    withImmediateTransaction(f.database, () => {
      new LedgerStore(f.database).updateRunStatusInTransaction('run-finalizer', 'completed')
      finalizer.scheduleInTransaction(f.database, { runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceEndSeq: 8 })
    })
    finalizer.kick()
    await finalizer.whenIdle()
    assert.equal(new LedgerStore(f.database).readRun('run-finalizer')?.status, 'completed')
    assert.equal(f.database.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id = ?').get<{ status: string }>('run-finalizer')?.status, 'failed')

    fail = false
    await finalizer.retryFailed('run-finalizer')
    await finalizer.whenIdle()
    assert.equal(f.database.prepare('SELECT status FROM dsh_memory_finalizations WHERE run_id = ?').get<{ status: string }>('run-finalizer')?.status, 'completed')
  } finally {
    await finalizer.dispose()
    await f.cleanup()
  }
})

for (const failure of ['capsule', 'finish', 'throw', 'limit', 'storage', 'abort'] as const) {
test(`finalizer observes consumed usage after ${failure} failure without changing native completion`, async () => {
  const f = await fixture()
  const observations: EfficiencyObservation[] = []
  let entered!: () => void
  const streaming = new Promise<void>(resolve => { entered = resolve })
  const observer = new DshEfficiencyObserver()
  const finalizer = new DshMemoryFinalizer({ runtime: runtime(f.database), inputMode: 'bounded_evidence',
    sessionQuery: { async readSession() { return snapshot() } },
    onObservation: observation => { observations.push(observation); throw new Error('telemetry sink failed') },
    llm: { stream: options => observer.stream(options, { sessionId: 'archived-dsh-session', task: 'auxiliary' }, async function* () {
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2 } }
      entered()
      if (failure === 'abort') await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
      if (failure === 'throw' || failure === 'abort') throw new Error('stream failed')
      yield { type: 'text-delta', text: failure === 'capsule' ? 'not json' : failure === 'limit' ? 'x'.repeat(FINALIZATION_STREAM_MAX_BYTES + 1) : '{"schemaVersion":1,"memories":[]}' }
      if (failure !== 'finish') yield { type: 'finish', reason: { kind: 'stop' } }
    }) },
  })
  try {
    await finalizer.bindRunStart({ runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceStartSeq: 0, sourceStartTurn: 1 })
    withImmediateTransaction(f.database, () => {
      new LedgerStore(f.database).updateRunStatusInTransaction('run-finalizer', 'completed')
      finalizer.scheduleInTransaction(f.database, { runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceEndSeq: 8 })
    })
    if (failure === 'storage') f.database.exec(`CREATE TRIGGER reject_finalization_completion BEFORE UPDATE OF status ON dsh_memory_finalizations WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;`)
    finalizer.kick()
    if (failure === 'abort') { await streaming; await finalizer.dispose() }
    await finalizer.whenIdle()
    assert.equal(new LedgerStore(f.database).readRun('run-finalizer')!.status, 'completed')
    assert.equal(f.database.prepare('SELECT status FROM dsh_memory_finalizations').get<{ status: string }>()!.status, 'failed')
    assert.equal(observations.length, 1)
    assert.equal(observations[0]!.usage.outputTokens, 9)
    assert.equal(observations[0]!.usage.logicalInputTokens, 8)
    assert.equal(observations[0]!.usage.reasoningTokens, 2)
    assert.equal(observations[0]!.status, failure === 'abort' ? 'cancelled' : 'failed')
    assert.equal(observer.snapshot().observations.length, 0, 'owned auxiliary usage is not observed twice')
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalization_entries').get<{ n: number }>()!.n, 0)
  } finally { await finalizer.dispose(); await f.cleanup() }
})
}

test('bounded finalization keeps latest surface evidence and its persisted mode across reload and retry', async () => {
  const f = await fixture()
  const observations: EfficiencyObservation[] = []
  const calls: any[] = []
  let fail = true
  const common = { runtime: runtime(f.database), sessionQuery: { async readSession() { return snapshot() } },
    onObservation: (observation: EfficiencyObservation) => { observations.push(observation) },
    llm: { async *stream(options: any) {
      calls.push(options)
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'text-delta', text: fail ? 'not json' : JSON.stringify({ schemaVersion: 1, memories: [{
        kind: 'fact', title: 'Verified result', body: 'Implemented and verified.', summary: null, confidence: 0.8, tags: [],
      }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } }
  const first = new DshMemoryFinalizer({ ...common, inputMode: 'bounded_evidence' })
  const second = new DshMemoryFinalizer({ ...common, inputMode: 'prefix_reuse' })
  try {
    await first.bindRunStart({ runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceStartSeq: 0, sourceStartTurn: 1 })
    withImmediateTransaction(f.database, () => {
      new LedgerStore(f.database).updateRunStatusInTransaction('run-finalizer', 'completed')
      first.scheduleInTransaction(f.database, { runId: 'run-finalizer', workspace: 'workspace-finalizer', dshSessionId: 'archived-dsh-session', sourceEndSeq: 8 })
    })
    first.kick(); await first.whenIdle(); await first.dispose()
    assert.throws(() => first.configure('prefix_reuse'), /already bound/u)
    assert.throws(() => f.database.prepare("UPDATE dsh_memory_finalizations SET input_mode = 'prefix_reuse'").run(), /immutable/u)
    fail = false
    await second.start(); await second.whenIdle()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].messages, calls[1].messages)
    for (const call of calls) {
      assert.equal(call.tools, undefined)
      assert.notEqual(call.system, 'system-prefix')
      const text = JSON.stringify(call.messages)
      assert.match(text, /Implement the durable design/u)
      assert.match(text, /Implemented and verified/u)
      assert.doesNotMatch(text, /FUTURE RUN MUST NOT LEAK/u)
      assert.ok(Buffer.byteLength(text) < 10_000)
    }
    assert.deepEqual(observations.map(item => [item.attempt, item.inputMode, item.status]), [[1, 'bounded_evidence', 'failed'], [2, 'bounded_evidence', 'completed']])
    assert.equal(f.database.prepare('SELECT status FROM dsh_memory_finalizations').get<{ status: string }>()!.status, 'completed')
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM dsh_memory_finalization_entries').get<{ n: number }>()!.n, 1)
  } finally { await first.dispose(); await second.dispose(); await f.cleanup() }
})
