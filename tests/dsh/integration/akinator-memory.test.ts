import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '../../../src/db/connection.js';
import { migrateDatabase } from '../../../src/db/migrate.js';
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js';
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js';
import { AkinatorMemoryConfig, MemoryProbeResultSchema } from '../../../src/akinator/memory-probe-types.js';
import { getAkinatorStateService, taggedEntries } from '../../../src/akinator/service.js';
import { backfillProfileMemory, readMemoryHints } from '../../../src/akinator/profile-memory-store.js';
import { probeProfileMemory, verifyTaskTargets } from '../../../src/akinator/memory-probe.js';
import { readAkinatorSession, readRunIntakeLink } from '../../../src/akinator/store.js';
import { createDshIntakeAnswerer } from '../../../src/dsh/user-interaction.js';

function fixture(migrationsDirectory?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'profile-probe-')));
  writeFileSync(join(root, 'target.ts'), 'export const target = 1;');
  const db = openConnection(join(root, 'fixture.sqlite3'));
  migrateDatabase(db, migrationsDirectory);
  registerRepositoryAndLocation(db, { repositoryId: 'repo-test', workspace: 'project:test', displayName: 'test',
    canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 });
  const now = '2026-09-13T00:00:00.000Z';
  const scope = { repositoryId: 'repo-test', workspace: 'project:test', repositoryRoot: root, allowed: true,
    verifiedTargets: verifyTaskTargets('Implement target.ts', root) };
  const config = AkinatorMemoryConfig.parse({ mode: migrationsDirectory ? 'off' : 'resolve', maxElapsedMs: 1000 });
  const service = new DshRunIntakeService(db, { now: () => now, akinatorMemory: config, memoryScope: scope });
  const request = (key: string, target: string | null = null, expected: string | null = 'checks pass') => ({
    idempotencyKey: key, dshSessionId: `native-${key}`, request: {
      apiVersion: '1', workspace: scope.workspace,
      task: { title: 'Implement target.ts', query: 'Implement target.ts', profileHints: { taskType: 'build', target, expected, constraints: null } },
      captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      metadata: { kiokukoProjectManifestBinding: { version: 1, repositoryId: scope.repositoryId, manifestDigest: 'a'.repeat(64) } },
    },
  });
  const seed = (key = 'source', target = 'target.ts') => {
    const run = service.openRun(request(key, target));
    db.prepare("UPDATE ledger_runs SET status = 'completed', ended_at = ? WHERE run_id = ?").run(now, run.runId);
    return run;
  };
  return { root, db, now, scope, config, service, request, seed, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('target adoption persists memory provenance without fake answers; replay ignores history and mode changes', () => {
  const f = fixture();
  try {
    f.seed();
    const input = f.request('current');
    const result = f.service.openRun(input);
    assert.equal(readRunIntakeLink(f.db, { workspace: f.scope.workspace, runId: result.runId }).profileSources.target, 'memory');
    assert.equal(readAkinatorSession(f.db, { workspace: f.scope.workspace, sessionId: result.intakeSessionId }).profile.target, 'target.ts');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM akinator_answers WHERE session_id = ?').get(result.intakeSessionId)?.n, 0);
    f.seed('conflicting', 'other.ts');
    assert.deepEqual(new DshRunIntakeService(f.db).openRun(input), result);
    assert.throws(() => f.service.openRun({ ...input, request: { ...input.request, task: { ...input.request.task, query: 'other request' } } }), { code: 'CONFLICT' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM akinator_memory_resolutions WHERE run_id = ?').get(result.runId)?.n, 1);
  } finally { f.close(); }
});

test('off, shadow, suggest, complete current profile and missing capability do not adopt', () => {
  const f = fixture();
  try {
    f.seed();
    for (const mode of ['off', 'shadow', 'suggest'] as const) {
      const run = new DshRunIntakeService(f.db, { now: () => f.now, memoryScope: f.scope,
        akinatorMemory: AkinatorMemoryConfig.parse({ mode, maxElapsedMs: 1000 }) }).openRun(f.request(mode));
      assert.equal(readAkinatorSession(f.db, { workspace: f.scope.workspace, sessionId: run.intakeSessionId }).profile.target, null);
      const hints = readMemoryHints(f.db, { runId: run.runId, ...f.scope, enabled: true });
      assert.equal(hints.length, mode === 'suggest' ? 1 : 0);
    }
    const denied = new DshRunIntakeService(f.db, { now: () => f.now, memoryScope: { ...f.scope, allowed: false }, akinatorMemory: f.config })
      .openRun(f.request('denied'));
    assert.equal(readAkinatorSession(f.db, { workspace: f.scope.workspace, sessionId: denied.intakeSessionId }).profile.target, null);
    const current = f.service.openRun(f.request('current-explicit', 'current.ts'));
    assert.equal(readAkinatorSession(f.db, { workspace: f.scope.workspace, sessionId: current.intakeSessionId }).profile.target, 'current.ts');
    const resolution = JSON.parse(f.db.prepare('SELECT result_json FROM akinator_memory_resolutions WHERE run_id = ?').get<{ result_json: string }>(current.runId)!.result_json);
    assert.equal(resolution.status, 'skipped'); assert.equal(resolution.queryCount, 0);
  } finally { f.close(); }
});

test('incomplete coverage, conflicting target and truncated candidate search prevent adoption', () => {
  const f = fixture();
  const profile = { taskType: 'build' as const, target: null, expected: 'current success', constraints: null };
  const probe = (config = f.config) => probeProfileMemory(f.db, { task: 'Implement target.ts', profile, scope: f.scope, config, now: f.now });
  try {
    const first = f.seed();
    const other = f.seed('other');
    f.db.prepare('DELETE FROM akinator_profile_documents WHERE run_id = ?').run(other.runId);
    assert.equal(probe().coverage, 'partial');
    assert.equal(probe().resolutions.some(r => r.decision === 'adopt'), false);
    while (!backfillProfileMemory(f.db, 1).complete) { /* bounded committed batches */ }
    assert.equal(probe().coverage, 'complete');
    const limited = probe({ ...f.config, maxCandidates: 1 });
    assert.equal(limited.truncated, true);
    assert.equal(limited.resolutions.some(r => r.decision === 'adopt'), false);
    f.seed('conflict', 'other.ts');
    assert.equal(probe().resolutions.some(r => r.decision === 'adopt'), false);
    f.db.prepare("UPDATE akinator_profile_documents SET profile_hash = ? WHERE run_id = ?").run('b'.repeat(64), first.runId);
    assert.throws(probe, { code: 'INTEGRITY_ERROR' });
  } finally { f.close(); }
});

test('resolution insert failure rolls back run, session, link and idempotency result', () => {
  const f = fixture();
  try {
    f.seed();
    const before = f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n;
    f.db.exec("CREATE TRIGGER fail_resolution BEFORE INSERT ON akinator_memory_resolutions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    assert.throws(() => f.service.openRun(f.request('failure')), /injected failure/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n, before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM akinator_sessions').get()?.n, before);
    f.db.exec('DROP TRIGGER fail_resolution');
    assert.equal(f.service.openRun(f.request('failure')).runStatus, 'active');
  } finally { f.close(); }
});

test('FTS update, delete, rebuild and source purge remove stale text including saved hints', () => {
  const f = fixture();
  try {
    const source = f.seed();
    const run = new DshRunIntakeService(f.db, { now: () => f.now, memoryScope: f.scope, akinatorMemory: { ...f.config, mode: 'suggest' } })
      .openRun(f.request('suggestion'));
    assert.equal(readMemoryHints(f.db, { ...f.scope, runId: run.runId, enabled: true }).length, 1);
    f.db.prepare("UPDATE akinator_profile_documents SET task_text = 'newuniqueterm', target_text = '' WHERE run_id = ?").run(source.runId);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM akinator_profile_fts WHERE akinator_profile_fts MATCH 'Implement'").get()?.n, 0);
    f.db.exec("INSERT INTO akinator_profile_fts(akinator_profile_fts) VALUES('rebuild'); INSERT INTO akinator_profile_trigram(akinator_profile_trigram) VALUES('rebuild');");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM akinator_profile_fts WHERE akinator_profile_fts MATCH 'newuniqueterm'").get()?.n, 1);
    f.db.prepare('DELETE FROM run_intakes WHERE run_id = ?').run(source.runId);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM akinator_profile_documents').get()?.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM akinator_profile_fts WHERE akinator_profile_fts MATCH 'newuniqueterm'").get()?.n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM akinator_memory_resolutions WHERE run_id = ?').get(run.runId)?.n, 0);
  } finally { f.close(); }
});

test('state lookup reads no entry bodies or search tables; empty tag search reads nothing', async () => {
  const f = fixture();
  try {
    const run = f.seed();
    const sql: string[] = [];
    const counted = { filePath: f.db.filePath, close() {}, exec(s: string) { f.db.exec(s); }, prepare(s: string) { sql.push(s); return f.db.prepare(s); } };
    const state = await getAkinatorStateService(counted, { workspace: f.scope.workspace, sessionId: run.intakeSessionId });
    assert.equal(state.status, 'ready');
    assert.equal('entries' in state, false);
    assert.equal(sql.some(s => /entries|fts|embedding|profile_documents/u.test(s)), false);
    const count = sql.length;
    assert.deepEqual(taggedEntries(counted, f.scope.workspace, []), []);
    assert.equal(sql.length, count);
  } finally { f.close(); }
});

test('UI preserves free input, existing task-type options and previous-example provenance', async () => {
  let displayed: any;
  const answerer = createDshIntakeAnswerer({ async ask(request) { displayed = request; return { answers: [{ id: 'target', selected: [], custom: 'different.ts' }] }; } });
  const answer = await answerer.ask({ id: 'target', prompt: '対象は？', required: true, options: null }, undefined, undefined,
    [{ field: 'target', value: 'target.ts', source: { runId: 'previous-run', observedAt: '2026-09-13T00:00:00.000Z' } }]);
  assert.equal(answer, 'different.ts');
  assert.equal(displayed.questions[0].options[0].label, 'target.ts');
  assert.match(displayed.questions[0].detail, /previous-run/);
});

test('probe rejects malformed serialized results and handles FTS operators, short and Japanese queries', () => {
  const f = fixture();
  try {
    f.seed();
    for (const task of ['" OR NOT *', 'あ', '対象', '対象の実装', 'target.ts '.repeat(1000)]) {
      const result = probeProfileMemory(f.db, { task, profile: { taskType: 'review', target: null, expected: null, constraints: null },
        scope: { ...f.scope, verifiedTargets: [] }, config: f.config, now: f.now });
      assert.equal(result.resolutions.some(r => r.decision === 'adopt'), false);
      assert.ok(result.queryCount <= 3); MemoryProbeResultSchema.parse(result);
      assert.equal(MemoryProbeResultSchema.safeParse({ ...result, extra: true }).success, false);
      assert.equal(MemoryProbeResultSchema.safeParse({ ...result, elapsedMs: Infinity }).success, false);
    }
  } finally { f.close(); }
});

test('tag keyset search skips unrelated bodies, old revisions, duplicates and ineligible pages', async () => {
  const { recordEntry, updateCandidateEntry } = await import('../../../src/memory/entries.js');
  const f = fixture();
  try {
    const record = (id: string, tags: string[], external = false) => recordEntry(f.db, { workspace: f.scope.workspace,
      kind: 'lesson', title: id, body: `body ${id}`, tags, createdBy: external ? 'kiokuko-skill-discovery' : 'test' },
      { now: f.now, idFactory: () => id });
    for (let i = 0; i < 40; i++) record(`a-ineligible-${i}`, ['skill:tdd'], true);
    for (let i = 0; i < 30; i++) record(`b-unrelated-${i}`, ['other']);
    const old = record('c-old', ['skill:tdd']);
    updateCandidateEntry(f.db, { workspace: f.scope.workspace, entryId: old.id, expectedRevision: old.revision,
      kind: 'lesson', title: 'changed', body: 'new revision', tags: ['other'], now: f.now });
    for (let i = 0; i < 15; i++) record(`d-match-${String(i).padStart(2, '0')}`, ['skill:tdd', 'bot:builder']);
    const readIds: unknown[] = [];
    const db = { filePath: f.db.filePath, close() {}, exec(s: string) { f.db.exec(s); }, prepare(s: string) {
      const statement = f.db.prepare(s);
      if (!s.includes('AS revision_count')) return statement;
      return { ...statement, all: statement.all.bind(statement), run: statement.run.bind(statement), get<T extends Record<string, unknown>>(...args: any[]) {
        readIds.push(args[0]); return statement.get<T>(...args);
      } };
    } };
    const found = taggedEntries(db, f.scope.workspace, ['skill:tdd', 'bot:builder']);
    assert.equal(found.length, 12);
    assert.equal(new Set(found.map(e => e.id)).size, 12);
    assert.deepEqual(found.map(e => e.id), Array.from({ length: 12 }, (_, i) => `d-match-${String(i).padStart(2, '0')}`));
    assert.equal(readIds.length, 52);
    assert.equal(readIds.some(id => String(id).startsWith('b-unrelated') || id === 'c-old'), false);
  } finally { f.close(); }
});

test('answering a suggestion marks user_answer and replay never restores the initial null profile', () => {
  const f = fixture();
  try {
    f.seed();
    const service = new DshRunIntakeService(f.db, { now: () => f.now, memoryScope: f.scope, akinatorMemory: { ...f.config, mode: 'suggest' } });
    const input = f.request('answer');
    const opened = service.openRun(input);
    service.answerIntake({ runId: opened.runId, idempotencyKey: 'answer-target', request: { apiVersion: '1', questionId: 'target', value: 'different.ts' } });
    service.openRun(input);
    const link = readRunIntakeLink(f.db, { workspace: f.scope.workspace, runId: opened.runId });
    assert.equal(link.profileSources.target, 'user_answer');
    assert.equal(readAkinatorSession(f.db, { workspace: f.scope.workspace, sessionId: opened.intakeSessionId }).profile.target, 'different.ts');
    const doc = f.db.prepare('SELECT target_text FROM akinator_profile_documents WHERE run_id = ?').get(opened.runId);
    assert.equal(doc?.target_text, 'different.ts');
  } finally { f.close(); }
});

test('a changed repository location is rejected before adoption and the run rolls back', () => {
  const f = fixture();
  try {
    f.seed();
    const count = f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n;
    const service = new DshRunIntakeService(f.db, { now: () => f.now, memoryScope: f.scope, akinatorMemory: f.config,
      onRunCreatedInTransaction({ database }) { database.exec('DELETE FROM repository_locations'); } });
    assert.throws(() => service.openRun(f.request('changed-location')), { code: 'CONFLICT' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n, count);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM repository_locations').get()?.n, 1);
  } finally { f.close(); }
});

test('native prepare capability boundary suppresses hints while permitted suggest reaches the answer consumer', async () => {
  const { prepareAgentTask, answerAgentTask } = await import('../../../src/dsh/task-intake.js');
  const f = fixture();
  try {
    f.seed();
    for (const allowed of [false, true]) {
      const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, ...(allowed ? [{ kind: 'skill', name: 'memory-reasoning' }] : [])];
      const input = { requestId: `native-${allowed}`, dshSessionId: `session-${allowed}`, task: 'Implement target.ts', cwd: f.root,
        profileHints: { taskType: 'build' as const, expected: 'checks pass' }, capabilities, skillDiscoveryMode: 'off' as const };
      const host = { akinatorMemory: { ...f.config, mode: 'suggest' as const } };
      const prepared = await prepareAgentTask(f.db, input, host);
      assert.equal(prepared.intake.memoryHints?.length ?? 0, allowed ? 1 : 0);
      assert.equal(prepared.intake.question?.id, 'target');
      const ready = await answerAgentTask(f.db, { ...input, sessionId: prepared.intake.sessionId, runId: prepared.run.runId,
        questionId: 'target', value: 'different.ts' }, host);
      assert.equal(ready.intake.profile.target, 'different.ts');
      assert.equal(ready.intake.status, 'ready');
      assert.equal(ready.intake.memoryHints, undefined);
    }
  } finally { f.close(); }
});

test('memory provenance cannot qualify a knowledge path even when the later run completes with tests', async () => {
  const { recordEntry } = await import('../../../src/memory/entries.js');
  const { recordKnowledgePathsInTransaction } = await import('../../../src/akinator/knowledge-path.js');
  const { withImmediateTransaction } = await import('../../../src/db/transaction.js');
  const f = fixture();
  try {
    f.seed();
    const run = f.service.openRun(f.request('derived'));
    f.db.prepare("UPDATE ledger_runs SET status = 'completed', ended_at = ? WHERE run_id = ?").run(f.now, run.runId);
    const entry = recordEntry(f.db, { workspace: f.scope.workspace, kind: 'lesson', title: 'Lesson', body: 'Verified behavior', createdBy: 'test' });
    const result = withImmediateTransaction(f.db, () => recordKnowledgePathsInTransaction(f.db, {
      workspace: f.scope.workspace, runId: run.runId, entries: [entry], outcome: 'completed', createdAt: f.now,
      verification: { fresh: true, passedTests: 1, passedCommands: 1, evidenceCount: 1 },
    }));
    assert.equal(result.recorded, 1); assert.equal(result.qualified, 0);
    assert.match(String(f.db.prepare('SELECT disqualification_reasons_json FROM akinator_reasoning_paths WHERE run_id = ?').get(run.runId)?.disqualification_reasons_json), /target-not-grounded/);
  } finally { f.close(); }
});

test('compatibility context skips tag retrieval once twelve regular search results fill the output', async () => {
  const { recordEntry } = await import('../../../src/memory/entries.js');
  const { getAkinatorContextService } = await import('../../../src/akinator/service.js');
  const f = fixture();
  try {
    const run = f.seed();
    for (let i = 0; i < 12; i++) recordEntry(f.db, { workspace: f.scope.workspace, kind: 'lesson', title: `Implement target.ts ${i}`,
      body: `Implement target.ts specific reference ${i}`, tags: ['skill:tdd'], createdBy: 'test' });
    let tagQueries = 0;
    const db = { filePath: f.db.filePath, close() {}, exec(s: string) { f.db.exec(s); }, prepare(s: string) {
      if (s.includes('INDEXED BY idx_entry_revision_tags_tag')) tagQueries++;
      return f.db.prepare(s);
    } };
    const context = await getAkinatorContextService(db, { workspace: f.scope.workspace, sessionId: run.intakeSessionId });
    assert.equal(context.entries.length, 12);
    assert.equal(tagQueries, 0);
  } finally { f.close(); }
});

test('v15 upgrades without scanning history; migration failure rolls back, then bounded backfill enables resolve', () => {
  const directory = mkdtempSync(join(tmpdir(), 'profile-v15-'));
  const migrations = join(directory, 'migrations'); mkdirSync(migrations);
  for (const name of readdirSync(join(process.cwd(), 'migrations')).filter(name => /^0(?:0\d|1[0-5])_/u.test(name))) {
    copyFileSync(join(process.cwd(), 'migrations', name), join(migrations, name));
  }
  const f = fixture(migrations);
  try {
    f.seed();
    assert.throws(() => migrateDatabase(f.db, undefined, { beforeMarkApplied(_db, migration) {
      if (migration.version === 16) throw new Error('injected migration failure');
    } }), /injected migration failure/);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'akinator_profile_documents'").get(), undefined);
    assert.equal(f.db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version, 15);
    assert.deepEqual(migrateDatabase(f.db).applied, [16, 17, 18, 19, 20, 21, 22]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM akinator_profile_documents').get()?.n, 0);
    assert.equal(backfillProfileMemory(f.db, 1).processed, 1);
    assert.equal(backfillProfileMemory(f.db, 1).complete, true);
    const service = new DshRunIntakeService(f.db, { now: () => f.now, memoryScope: f.scope, akinatorMemory: { ...f.config, mode: 'resolve' } });
    const result = service.openRun(f.request('after-upgrade'));
    assert.equal(readRunIntakeLink(f.db, { workspace: f.scope.workspace, runId: result.runId }).profileSources.target, 'memory');
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('the DSH gate passes a verified task-type example to the native question without replacing its choices', async () => {
  const { DshIntakeGate } = await import('../../../src/dsh/intake-gate.js');
  const { createDshCapabilityCatalog } = await import('../../../src/dsh/capability-catalog.js');
  const { createStandardSkillProvider } = await import('../../../src/dsh/standard-skill-provider.js');
  const provider = createStandardSkillProvider();
  let capabilities;
  try {
    const listed = await provider.list({});
    const candidates = 'complete' in listed ? listed.candidates : listed;
    capabilities = createDshCapabilityCatalog(candidates.map(({ name, description }) => ({ kind: 'skill' as const, name, description })));
  } finally { provider.dispose(); }
  const f = fixture();
  try {
    const source = f.seed();
    let detail = '', questions = 0;
    const answerer = createDshIntakeAnswerer({ async ask(request) {
      questions++;
      const question = request.questions[0];
      assert.equal(question.id, 'taskType');
      assert.equal(question.options?.[0]?.label, '実装・変更');
      detail = question.detail ?? '';
      return { answers: [{ id: question.id, selected: ['実装・変更'] }] };
    } });
    const gate = new DshIntakeGate({ withDatabase: async operation => await operation(f.db, undefined as never) },
      answerer, undefined, false, { ...f.config, mode: 'suggest' });
    const result = await gate.prepare({ agent: { id: 'agent' }, sessionId: 'gate-session', turn: 1, step: 1,
      task: 'target.ts の件', cwd: f.root, signal: new AbortController().signal, skillDiscoveryMode: 'off',
      capabilities });
    assert.equal(result.admitted, true);
    assert.equal(questions, 1);
    assert.ok(detail.includes(source.runId));
    assert.equal(result.prepared.intake.profile.taskType, 'build');
    assert.equal(readRunIntakeLink(f.db, { workspace: f.scope.workspace, runId: result.prepared.run.runId }).profileSources.taskType, 'user_answer');
  } finally { f.close(); }
});
