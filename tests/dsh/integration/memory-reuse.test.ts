import { CURRENT_MIGRATION_VERSIONS } from '../../fixtures/current-migrations.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { DeepConfigurationSchema, DEEP_ROLES } from '../../../src/deep-thinker/core/contracts.js'
import { recordEntry, updateCandidateEntry, readEntry } from '../../../src/memory/entries.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { queryScopedContextGated, type ScopedContextQuery } from '../../../src/context/scoped-broker.js'
import { prepareAgentTask, refreshContinuedTaskContext } from '../../../src/dsh/task-intake.js'
import type { MemoryReuseRuntime } from '../../../src/memory/reuse.js'
import { recallScopedMemory } from '../../../src/memory/scoped-memory.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { DecisionService, databaseDecisionStore } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import type { DecisionBatch, DecisionBatchResult, DecisionProvider } from '../../../src/dsh/decisions/contracts.js'

const capabilities = ['kiokuko-soul', 'memory-reasoning', 'kiokuko-single-purpose-functions', 'one-shot-software-completion'].map(name => ({ kind: 'skill' as const, name }))
const profile = { taskType: 'debug' as const, target: 'sqlite', expected: 'Resolve SQLITE_BUSY', constraints: 'Preserve data' }
async function setup(migrationsDirectory?: string) {
  const db = openConnection(':memory:'); migrateDatabase(db, migrationsDirectory)
  const runtime = { withDatabase: async <T>(operation: (db: SqliteDatabase) => T) => operation(db) }
  const root = await mkdtemp(join(tmpdir(), 'memory-reuse-'))
  await mkdir(join(root, '.git'))
  const project = (await resolveProjectWorkspace(db, root))!
  const entries = ['first', 'second', 'third'].map(name => recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: 'SQLITE_BUSY',
    body: `SQLITE_BUSY ${name}: read-only inspection; never delete data. /Users/fixture/internal-path`, createdBy: 'fixture', scope: { visibility: 'project' } }))
  const prepared = await prepareAgentTask(db, { requestId: 'setup', task: 'SQLITE_BUSY', cwd: root, dshSessionId: 'fixture-session',
    executionSelection: true, profileHints: profile, capabilities, skillDiscoveryMode: 'off' })
  const query: ScopedContextQuery = { project, task: 'SQLITE_BUSY', taskProfile: prepared.intake.profile, runId: prepared.run.runId, limit: 3, characterBudget: 1000 }
  return { db, root, runtime, project, entries, prepared, query, cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }) } }
}

test('scoped selection is before fitting, projected, versioned, and replayable with semantic omissions', async () => {
  const f = await setup()
  try {
    let calls = 0, rejected = '', promoted = ''
    const runtime: MemoryReuseRuntime = { identity: 'fixture-v1', maxCandidates: 3, select: async input => {
      calls++; assert.equal(input.candidates.length, 3)
      assert.ok(input.candidates.every(c => !c.text.includes('/Users/fixture')))
      rejected = input.candidates[0]!.entryId; promoted = input.candidates[2]!.entryId
      return { status: 'completed', verdicts: ['not_applicable', 'uncertain', 'applicable'] }
    } }
    const effects = { memoryReuse: { runtime, authorize: () => true } }
    const query = { ...f.query, limit: 1 }
    const first = (await queryScopedContextGated(f.db, query, value => ({ persist: true, value }), {}, effects)).context!
    assert.equal(first.policyVersion, 'context-ranking-v9'); assert.equal(first.items[0]?.entryId, promoted)
    assert.ok(first.omissions?.some(o => o.entryId === rejected && o.reason === 'semantic_not_applicable'))
    const replay = (await queryScopedContextGated(f.db, query, value => ({ persist: true, value }), {}, effects)).context!
    assert.equal(calls, 1); assert.equal(replay.deliveryId, first.deliveryId); assert.deepEqual(replay.items, first.items)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get()!.n, 3)
    assert.equal(readEntry(f.db, { workspace: f.project.workspace, entryId: rejected }).status, 'candidate')
  } finally { await f.cleanup() }
})

test('withheld full baseline and incomplete intake never disclose candidates', async () => {
  const f = await setup()
  try {
    let calls = 0
    const runtime: MemoryReuseRuntime = { identity: 'gate', maxCandidates: 3, select: async () => { calls++; return { status: 'completed', verdicts: [] } } }
    let baseline = 0
    await queryScopedContextGated(f.db, f.query, value => ({ persist: false, value }), {}, { memoryReuse: { runtime, authorize: all => { baseline = all.items.length; return false } } })
    assert.equal(baseline, 3); assert.equal(calls, 0)
    const blocked = await prepareAgentTask(f.db, { requestId: 'no-memory-skill', task: 'SQLITE_BUSY', cwd: f.root, dshSessionId: 'missing',
      executionSelection: true, profileHints: profile, capabilities: capabilities.filter(c => c.name !== 'memory-reasoning'), skillDiscoveryMode: 'off', memoryReuse: runtime })
    assert.equal(blocked.context, null); assert.equal(calls, 0)
    const pending = await prepareAgentTask(f.db, { requestId: 'pending', task: 'SQLITE_BUSY', cwd: f.root, dshSessionId: 'pending', capabilities, skillDiscoveryMode: 'off', memoryReuse: runtime })
    assert.equal(pending.intake.status, 'needs_answer'); assert.equal(calls, 0)
  } finally { await f.cleanup() }
})

test('service failure preserves baseline selection and unknown records keep their original order', async () => {
  const f = await setup()
  try {
    const baseline = (await queryScopedContextGated(f.db, f.query, value => ({ persist: false, value }))).value
    for (const result of [{ status: 'fallback' as const, reason: 'DECISION_TIMEOUT' }, { status: 'completed' as const, verdicts: ['uncertain', 'uncertain', 'uncertain'] as const }]) {
      const runtime: MemoryReuseRuntime = { identity: `result-${result.status}`, maxCandidates: 3, select: async () => result }
      const actual = (await queryScopedContextGated(f.db, f.query, value => ({ persist: false, value }), {}, { memoryReuse: { runtime, authorize: () => true } })).value
      assert.deepEqual(actual.items, baseline.items); assert.deepEqual(actual.omissions, baseline.omissions)
    }
  } finally { await f.cleanup() }
})

test('a revision change to a rejected candidate during the API wait prevents delivery', async () => {
  const f = await setup()
  try {
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM context_deliveries').get()!.n
    const runtime: MemoryReuseRuntime = { identity: 'stale', maxCandidates: 3, select: async input => {
      const entry = readEntry(f.db, { workspace: f.project.workspace, entryId: input.candidates[0]!.entryId })
      updateCandidateEntry(f.db, { workspace: entry.workspace, entryId: entry.id, expectedRevision: entry.revision, kind: entry.kind, title: entry.title, body: 'SQLITE_BUSY corrected condition' })
      return { status: 'completed', verdicts: ['not_applicable', 'applicable', 'applicable'] }
    } }
    await assert.rejects(queryScopedContextGated(f.db, f.query, value => ({ persist: true, value }), {}, { memoryReuse: { runtime, authorize: () => true } }), /changed during semantic selection/)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM context_deliveries').get()!.n, count)
  } finally { await f.cleanup() }
})

test('project recall preserves its old response on fallback and scopes semantic input to that project', async () => {
  const f = await setup()
  try {
    recordEntry(f.db, { workspace: 'global', kind: 'reference', title: 'SQLITE_BUSY', body: 'Global must not enter project-only recall', scope: { visibility: 'global' }, createdBy: 'fixture' })
    const request = { project: f.project, query: 'SQLITE_BUSY', scope: 'project' as const, readOnly: true, limit: 1, maxChars: 200 }
    const baseline = await recallScopedMemory(f.db, request)
    const runtime: MemoryReuseRuntime = { identity: 'core', maxCandidates: 3, select: async input => {
      assert.equal(input.candidates.length, 3); assert.ok(input.candidates.every(c => !c.text.includes('Global must')))
      return { status: 'fallback', reason: 'offline' }
    } }
    assert.deepEqual(await recallScopedMemory(f.db, request, {}, { runtime, constraints: 'preserve', assertCurrent: () => {} }), baseline)
    const selected = await recallScopedMemory(f.db, request, {}, { runtime: { ...runtime, select: async () => ({ status: 'completed', verdicts: ['not_applicable', 'uncertain', 'applicable'] }) }, constraints: 'preserve', assertCurrent: () => {} })
    assert.notEqual(selected.project!.memory.items[0]!.id, baseline.project!.memory.items[0]!.id)
  } finally { await f.cleanup() }
})

test('continued normal requests consume the same optional selector', async () => {
  const f = await setup()
  try {
    let called = 0
    const runtime: MemoryReuseRuntime = { identity: 'continued', maxCandidates: 3, select: async () => { called++; return { status: 'completed', verdicts: ['not_applicable', 'not_applicable', 'not_applicable'] } } }
    const result = await refreshContinuedTaskContext({ database: f.db, prepared: f.prepared, task: 'SQLITE_BUSY', capabilities, memoryReuse: runtime,
      assertCurrent: () => {}, validateCapabilities: async () => {} })
    assert.equal(called, 1); assert.equal(result.context?.items.length, 0)
  } finally { await f.cleanup() }
})

for (const mode of ['normal', 'deep'] as const) test(`${mode} initial intake injects semantic selection`, async () => {
  const f = await setup()
  try {
    let called = 0
    const memoryReuse: MemoryReuseRuntime = { identity: mode, maxCandidates: 24, select: async input => {
      called++; assert.equal(input.candidates.length, 3)
      return { status: 'completed', verdicts: input.candidates.map(() => 'not_applicable') }
    } }
    const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, { provider: 'fixture', model: role }])) })
    const prepared = await prepareAgentTask(f.db, { requestId: mode, task: 'SQLITE_BUSY', cwd: f.root, dshSessionId: mode,
      ...(mode === 'deep' ? { deepSelection: { startId: mode, configuration } } : { executionSelection: true }),
      profileHints: profile, capabilities, skillDiscoveryMode: 'off', memoryReuse })
    assert.notEqual(prepared.intake.status, 'needs_answer'); assert.equal(called, 1); assert.equal(prepared.context?.items.length, 0)
  } finally { await f.cleanup() }
})

test('incompatible applicability never leaves the host, even when lexical retrieval finds it', async () => {
  const f = await setup()
  try {
    const blocked = recordEntry(f.db, { workspace: f.project.workspace, kind: 'lesson', title: 'SQLITE_BUSY', body: 'SQLITE_BUSY requires an unavailable runtime.',
      scope: { visibility: 'project', applicability: { runtimes: ['missing-runtime'] } }, createdBy: 'fixture' })
    const runtime: MemoryReuseRuntime = { identity: 'applicability', maxCandidates: 24, select: async input => {
      assert.equal(input.candidates.some(c => c.entryId === blocked.id), false); assert.equal(input.candidates.length, 3)
      return { status: 'completed', verdicts: input.candidates.map(() => 'uncertain') }
    } }
    await queryScopedContextGated(f.db, f.query, value => ({ persist: false, value }), {}, { memoryReuse: { runtime, authorize: () => true } })
    await recallScopedMemory(f.db, { project: f.project, query: 'SQLITE_BUSY', scope: 'project', readOnly: true }, {}, { runtime, constraints: '', assertCurrent: () => {} })
  } finally { await f.cleanup() }
})

test('migration 22 preserves historical deliveries and omissions with their immutability and foreign keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reuse-version21-'))
  for (const name of await readdir('migrations')) if (/^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 21) await copyFile(join('migrations', name), join(directory, name))
  const f = await setup(directory)
  try {
    await queryScopedContextGated(f.db, { ...f.query, limit: 1 }, value => ({ persist: true, value }))
    const before = f.db.prepare('SELECT * FROM context_delivery_omissions ORDER BY delivery_id, entry_id').all()
    const deliveries = f.db.prepare('SELECT * FROM context_deliveries ORDER BY delivery_id').all()
    assert.ok(before.length > 0); assert.deepEqual(migrateDatabase(f.db).applied, CURRENT_MIGRATION_VERSIONS.filter(version => version > 21))
    assert.deepEqual(f.db.prepare('SELECT * FROM context_delivery_omissions ORDER BY delivery_id, entry_id').all(), before)
    assert.deepEqual(f.db.prepare('SELECT * FROM context_deliveries ORDER BY delivery_id').all(), deliveries)
    assert.throws(() => f.db.prepare("UPDATE context_delivery_omissions SET reason='semantic_not_applicable'").run(), /immutable/)
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await f.cleanup(); await rm(directory, { recursive: true, force: true }) }
})

test('native CoreTasks delivers semantic selection without any embedding service', async () => {
  const f = await setup()
  try {
    let probes = 0, evaluations = 0
    const provider: DecisionProvider = { capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144 }, evaluate: async (batch: DecisionBatch): Promise<DecisionBatchResult> => {
      if (batch.questions[0]!.id === 'fruit') probes++; else if (batch.purpose === 'memory-reuse') evaluations++
      return { provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q =>
        q.id === 'fruit' ? { id: q.id, status: 'selected' as const, choiceId: 'apple' } : batch.purpose === 'memory-reuse'
          ? { id: q.id, status: 'selected' as const, choiceId: 'not_applicable' } : { id: q.id, status: 'abstained' as const, reason: 'insufficient' as const }) }
    } }
    const decisions = new DecisionService(TypedDecisionsConfig.parse({}), () => provider, databaseDecisionStore(f.runtime))
    const tasks = new CoreTasks(f.runtime as any, undefined, [], decisions)
    const prepared = await tasks.prepare({ requestId: 'native-core', sessionId: 'core', turn: 1, task: 'SQLITE_BUSY', cwd: f.root, capabilities, profileHints: profile, signal: new AbortController().signal })
    assert.equal(prepared.admitted, true); assert.equal(probes, 1); assert.equal(evaluations, 1)
    assert.equal(prepared.memory?.project?.memory.items.length, 0)
    assert.equal(prepared.memory?.combined?.items.length, 0, 'Rejected memory must not survive in the combined context')
    await tasks.finish(prepared, 'completed')
  } finally { await f.cleanup() }
})
