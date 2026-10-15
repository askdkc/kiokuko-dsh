import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, createRun } from './evolution/fixture.js';
import { recordEntry, recordEntryInTransaction, updateCandidateEntry } from '../../../src/memory/entries.js';
import { withImmediateTransaction } from '../../../src/db/transaction.js';
import { configureIndex, saveIndexFact, indexFactEligible, reserveIndexJob } from '../../../src/memory/index-reasoning/store.js';
import { MemoryIndexReasoningConfig, entityPresent } from '../../../src/memory/index-reasoning/contracts.js';
import { IndexReasoningWorker } from '../../../src/memory/index-reasoning/worker.js';
import { projectMemoryEntry, assertMemoryProjection } from '../../../src/context/memory-projection.js';
import { hybridSearch } from '../../../src/memory/hybrid-retrieval.js';
import { fitScopedItems, type ScopedContextItem } from '../../../src/context/scoped-broker.js';
import { IndexReasoningService } from '../../../src/memory/index-reasoning/service.js';
import { Config } from '../../../src/dsh/config.js';
import { CoreConfig } from '../../../src/dsh/core/host.js';
const workspace = 'project:test';
test('legacy configuration defaults remain readable in full and independent core hosts', () => {
    assert.equal(MemoryIndexReasoningConfig.parse({}).mode, 'active');
    assert.equal(Config.parse({}).memoryIndexReasoning.mode, 'active');
    assert.equal(CoreConfig.parse({}).memoryIndexReasoning.mode, 'active');
    assert.equal(Config.parse({ memoryRetrieval: { mode: 'off' } }).memoryIndexReasoning.mode, 'active');
});
test('Japanese particles preserve exact entity spans without inferring identifier or Han aliases', () => {
    assert.ok(entityPresent('WidgetはSQLiteを使う。', 'SQLite'));
    assert.ok(entityPresent('記憶庫を検索する。', '記憶庫'));
    assert.ok(!entityPresent('SQLiteを使う。', 'SQL'));
    assert.ok(!entityPresent('記憶庫設定を変更する。', '記憶庫'));
});
function inputs(db: ReturnType<typeof fixture>['db'], transaction = false) {
    const save = transaction ? recordEntryInTransaction : recordEntry;
    const a = save(db, { workspace, kind: 'fact', title: 'Driver', body: 'Widget uses SQLite.', scope: { visibility: 'project' }, createdBy: 'fixture' });
    const b = save(db, { workspace, kind: 'fact', title: 'Database', body: 'SQLite uses a write lock.', scope: { visibility: 'project' }, createdBy: 'fixture' });
    const source = (e: typeof a) => ({ entryId: e.id, revision: e.revision, contentHash: e.contentHash, supportingText: e.body });
    return { a, b, draft: { role: 'bridge' as const, text: 'Widget uses SQLite and therefore its writes require the SQLite write lock.', applicability: null, entities: [{ type: 'package' as const, value: 'SQLite' }], sources: [source(a), source(b)] } };
}
test('bridge is untrusted, rendered directly, retrieved independently of temporal mode and invalidated by source revision', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { a, draft } = inputs(db);
        const fact = withImmediateTransaction(db, () => saveIndexFact(db, workspace, draft));
        assert.equal(fact.trustLevel, 'untrusted');
        assert.equal(fact.status, 'candidate');
        assert.ok(indexFactEligible(db, fact));
        const projection = projectMemoryEntry(db, fact)!;
        assert.equal(projection.projection.version, 3);
        assert.match(projection.bodyPreview, /Widget uses SQLite/);
        assert.match(projection.bodyPreview, /Source 2/);
        assertMemoryProjection(projection);
        assert.ok(hybridSearch(db, { workspace, query: 'Widget write lock', limit: 10 }).some(x => x.entryId === fact.id));
        configureIndex(db, workspace, 'observe');
        assert.ok(!indexFactEligible(db, fact));
        configureIndex(db, workspace, 'off');
        assert.ok(!indexFactEligible(db, fact));
        configureIndex(db, workspace, 'active');
        updateCandidateEntry(db, { workspace, entryId: a.id, expectedRevision: 1, kind: a.kind, title: a.title, body: 'Widget no longer uses SQLite.', scope: a.scope });
        assert.ok(!indexFactEligible(db, fact));
        assert.equal(projectMemoryEntry(db, fact), null);
    }
    finally {
        db.close();
    }
});
test('rejects fabricated excerpts, cross-workspace sources and duplicate roots', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { draft } = inputs(db);
        assert.throws(() => saveIndexFact(db, workspace, { ...draft, sources: [draft.sources[0], draft.sources[0]] }));
        assert.throws(() => saveIndexFact(db, workspace, { ...draft, sources: draft.sources.map(s => ({ ...s, supportingText: 'invented' })) }));
        assert.throws(() => saveIndexFact(db, 'project:other', draft));
    }
    finally {
        db.close();
    }
});
test('durable enqueue rolls back with the original save and never enqueues generated facts', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        assert.throws(() => withImmediateTransaction(db, () => {
            inputs(db, true);
            throw new Error('crash before commit');
        }), /crash before commit/);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_sources').get()?.n, 0);
        const { draft } = inputs(db);
        withImmediateTransaction(db, () => saveIndexFact(db, workspace, draft));
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_sources').get()?.n, 2);
    }
    finally {
        db.close();
    }
});
test('source deletion retains the manifest audit record and removes the derived search result', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { a, draft } = inputs(db);
        const fact = withImmediateTransaction(db, () => saveIndexFact(db, workspace, draft));
        db.prepare('UPDATE audit_events SET entry_id=NULL WHERE entry_id=?').run(a.id);
        db.prepare('DELETE FROM entries WHERE id=?').run(a.id);
        assert.ok(!indexFactEligible(db, fact));
        assert.ok(db.prepare('SELECT manifest_json FROM memory_index_facts WHERE entry_id=?').get(fact.id));
        assert.ok(!hybridSearch(db, { workspace, query: 'Widget write lock', limit: 10 }).some(h => h.entryId === fact.id));
    }
    finally {
        db.close();
    }
});
test('equal bodies with different titles and inferred substring aliases are not independent sources', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { a, draft } = inputs(db);
        const copy = recordEntry(db, { workspace, kind: 'fact', title: 'Another title', body: a.body, scope: a.scope, createdBy: 'fixture' });
        assert.notEqual(copy.contentHash, a.contentHash);
        assert.throws(() => saveIndexFact(db, workspace, { ...draft, sources: [draft.sources[0], { entryId: copy.id, revision: copy.revision, contentHash: copy.contentHash, supportingText: copy.body }] }), /duplicate_source/);
        assert.throws(() => saveIndexFact(db, workspace, { ...draft, entities: [{ type: 'package', value: 'SQL' }] }), /ungrounded_entity/);
    }
    finally {
        db.close();
    }
});

test('exact originals survive bridge quotas, and complete projections obey character budgets', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { a, b, draft } = inputs(db);
        const bridges = Array.from({ length: 4 }, (_, i) => withImmediateTransaction(db, () => saveIndexFact(db, workspace, { ...draft, applicability: `fixture-${i}`, text: `${draft.text} Case ${i}.` })));
        const item = (e: typeof a, exact = false): ScopedContextItem => ({
            entryId: e.id, revision: e.revision, origin: 'project', ...projectMemoryEntry(db, e)!, score: 0,
            scoreComponents: { status: 0, trust: 0, confidence: 0, retrieval: 0, taskAffinity: 0, recommendedTags: 0, scopeAffinity: 0, applicability: 0, pathOverlap: 0, errorSignature: 0, exactSignal: 0, feedback: 0, recency: 0, contradiction: 0 },
            selectionReasons: exact ? ['exact_signal_match'] : [], metadata: { storedData: true, untrusted: true, instructions: false },
        });
        const ordered = [...bridges.map(e => item(e)), item(a, true), item(b)];
        const selected = fitScopedItems(ordered, 10, 20000);
        assert.ok(selected.items.some(e => e.entryId === a.id));
        assert.equal(selected.items.filter(e => e.projection?.version === 3).length, 3);
        const onlyTwo = fitScopedItems(ordered, 2, 20000);
        assert.deepEqual(onlyTwo.items.map(e => e.entryId).sort(), [a.id, b.id].sort());
        const short = fitScopedItems(ordered, 10, 500);
        assert.ok(short.charCount <= 500);
        assert.ok(short.items.filter(e => e.projection?.version === 3).reduce((n, e) => n + e.projection!.characters, 0) <= 150);
        for (const e of short.items) assertMemoryProjection(e);
    } finally { db.close(); }
});

test('new captures are claimed before queued backfill jobs', async () => {
    const { db, runtime } = fixture();
    const worker = new IndexReasoningWorker({ runtime, config: MemoryIndexReasoningConfig.parse({}) });
    try {
        configureIndex(db, workspace, 'active');
        const { a, b } = inputs(db);
        const model = { provider: 'fixture', model: 'fixed', contextWindow: 131072, sessionId: 'test' };
        db.prepare('UPDATE memory_index_sources SET priority=0').run();
        reserveIndexJob(db, workspace, model, '2000-01-01');
        const fresh = recordEntry(db, { workspace, kind: 'fact', title: 'Fresh', body: 'SQLite now uses a new driver.', scope: { visibility: 'project' }, createdBy: 'fixture' });
        reserveIndexJob(db, workspace, model);
        const claimed = await worker.claim();
        assert.deepEqual(JSON.parse(claimed!.input_json).map((e: any) => e.id), [fresh.id]);
        assert.ok(!claimed!.input_json.includes(a.id) && !claimed!.input_json.includes(b.id));
    } finally { await worker.dispose(); db.close(); }
});

test('contradictory source feedback excludes a derived hit even when an old vector backend returns it', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { a, draft } = inputs(db);
        const fact = withImmediateTransaction(db, () => saveIndexFact(db, workspace, draft));
        const semantic = { query: { profileId: 'fixture', dimensions: 2, vector: new Float32Array([1, 0]), vectorHash: 'fixture', backendId: 'fixture', distanceCeiling: 1 }, backend: { id: 'fixture', search: () => [{ entryId: fact.id, distance: 0 }] } };
        assert.ok(hybridSearch(db, { workspace, query: 'unrelated question', limit: 10 }, { semantic }).some(h => h.entryId === fact.id));
        createRun(db, 'feedback');
        db.prepare("INSERT INTO context_deliveries(delivery_id,run_id,through_sequence,task_profile_hash,query_hash,policy_version,external_sync_summary_json,char_budget,char_count,truncated,created_at) VALUES('source-feedback','feedback',0,'fixture','fixture','fixture','{}',1000,0,0,'2000-01-01')").run();
        db.prepare("INSERT INTO context_delivery_entries(delivery_id,entry_id,entry_revision,rank,score_components_json,selection_reason_json) VALUES('source-feedback',?,1,1,'{}','[]')").run(a.id);
        db.prepare("INSERT INTO context_feedback VALUES('source-conflict','source-feedback',?,'feedback','conflicting',NULL,'fixture','fixture','2000-01-01')").run(a.id);
        assert.ok(!indexFactEligible(db, fact));
        assert.ok(!hybridSearch(db, { workspace, query: 'unrelated question', limit: 10 }, { semantic }).some(h => h.entryId === fact.id));
    } finally { db.close(); }
});

test('editing a generated entry cannot erase its derived identity or bypass source checks', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');
        const { draft } = inputs(db);
        const fact = withImmediateTransaction(db, () => saveIndexFact(db, workspace, draft));
        const edited = updateCandidateEntry(db, { workspace, entryId: fact.id, expectedRevision: fact.revision, kind: fact.kind, title: fact.title, body: 'SQLite always succeeds.', scope: fact.scope, provenance: { type: 'fixture', reference: 'operator-edit' } });
        assert.ok(!indexFactEligible(db, edited));
        assert.equal(projectMemoryEntry(db, edited), null);
        assert.ok(!hybridSearch(db, { workspace, query: 'SQLite always succeeds', limit: 10 }).some(h => h.entryId === edited.id));
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_sources WHERE entry_id=?').get(edited.id)?.n, 0);
    } finally { db.close(); }
});

// Automatic reasoning workers are retired. Positive exact preview approval and
// searchable approved content are covered by replay-memory-review.test.ts.
const indexSnapshot = (db: ReturnType<typeof fixture>['db']) => ({
    jobs: db.prepare('SELECT * FROM memory_index_jobs ORDER BY id').all(),
    calls: db.prepare('SELECT * FROM memory_index_calls ORDER BY id').all(),
    facts: db.prepare('SELECT * FROM memory_index_facts ORDER BY entry_id').all(),
    entries: db.prepare('SELECT id,current_revision,status FROM entries ORDER BY id').all(),
});
for (const mode of ['active', 'observe', 'off'] as const)
    test(`${mode} startup and concurrent worker hints cannot generate or adopt indexed facts`, async () => {
        const { db, runtime } = fixture();let calls = 0;
        configureIndex(db, workspace, 'active');inputs(db);
        reserveIndexJob(db, workspace, { provider: 'fixture', model: 'fixed', contextWindow: 131072, sessionId: 'test' });
        configureIndex(db, workspace, mode);
        const options = { runtime, config: MemoryIndexReasoningConfig.parse({ mode }), llm: { async *stream() { calls++; throw new Error('unapproved derivation'); } } };
        const a = new IndexReasoningWorker(options), b = new IndexReasoningWorker(options);
        try {
            const before = indexSnapshot(db), writes = db.prepare('SELECT total_changes() AS n').get()?.n;
            a.kick();b.kick();await Promise.all([a.whenIdle(), b.whenIdle()]);a.kick();await a.whenIdle();
            assert.equal(calls, 0);assert.deepEqual(indexSnapshot(db), before);
            assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, writes);
            assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_facts').get()?.n, 0);
        } finally { await a.dispose();await b.dispose();db.close(); }
    });
for (const dispatched of [false, true])
    test(`expired ${dispatched ? 'dispatched' : 'undispatched'} historical index claims do not restart generation`, async () => {
        const { db, runtime } = fixture();let calls = 0;
        configureIndex(db, workspace, 'active');inputs(db);
        reserveIndexJob(db, workspace, { provider: 'fixture', model: 'fixed', contextWindow: 131072, sessionId: 'test' });
        const id = String(db.prepare('SELECT id FROM memory_index_jobs').get()!.id);
        db.prepare("UPDATE memory_index_jobs SET state='processing',claim_token='old',lease_until='2000-01-01T00:00:00.000Z'").run();
        if (dispatched) db.prepare("INSERT INTO memory_index_calls(id,job_id,stage,workspace,utc_day,outcome) VALUES('old',?,0,?,'2000-01-01','unknown')").run(id, workspace);
        const worker = new IndexReasoningWorker({ runtime, config: MemoryIndexReasoningConfig.parse({}), llm: { async *stream() { calls++;yield { type: 'finish', reason: { kind: 'stop' } }; } } });
        try {
            const before = indexSnapshot(db);worker.kick();await worker.whenIdle();
            assert.equal(calls, 0);assert.deepEqual(indexSnapshot(db), before);
        } finally { await worker.dispose();db.close(); }
    });
test('legacy budgets, model outputs and uncooperative providers do not create a dispatch', async () => {
    for (const dailyCalls of [1, 8]) {
        const { db, runtime } = fixture();let calls = 0;
        configureIndex(db, workspace, 'active');inputs(db);
        reserveIndexJob(db, workspace, { provider: 'fixture', model: 'fixed', contextWindow: 131072, sessionId: 'test' });
        const worker = new IndexReasoningWorker({ runtime, config: MemoryIndexReasoningConfig.parse({ dailyCalls, timeoutMs: 100 }), llm: { async *stream() { calls++;await new Promise(() => {});yield {}; } } });
        try {
            const before = indexSnapshot(db);worker.kick();await worker.whenIdle();
            assert.equal(calls, 0);assert.deepEqual(indexSnapshot(db), before);
        } finally { await worker.dispose();db.close(); }
    }
});
test('legacy status, backfill, mode and retry commands cannot replace native memory review', async () => {
    const { db, runtime } = fixture();let calls = 0;
    createRun(db, 'command');configureIndex(db, workspace, 'active');inputs(db);
    reserveIndexJob(db, workspace, { provider: 'fixture', model: 'fixed', contextWindow: 131072, sessionId: 'session-command' });
    const id = String(db.prepare('SELECT id FROM memory_index_jobs').get()!.id);
    const service = new IndexReasoningService(runtime, MemoryIndexReasoningConfig.parse({}), { async *stream() { calls++;yield { type: 'finish', reason: { kind: 'stop' } }; } });
    try {
        const before = indexSnapshot(db), writes = db.prepare('SELECT total_changes() AS n').get()?.n;
        await service.start();await service.admitIndex(workspace, 'session-command', { provider: 'fixture', model: 'fixed', contextWindow: 131072 });
        for (const command of ['status', 'status --json', 'backfill', 'mode active', `retry ${id}`])
            assert.deepEqual(await service.indexCommand('session-command', command), { recorded: false, workMayContinue: true, reason: 'post_task_memory_review_required' });
        await service.whenIdle();assert.equal(calls, 0);assert.deepEqual(indexSnapshot(db), before);
        assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, writes);
    } finally { await service.dispose();db.close(); }
});
test('historical shared-entity bridges retain original source IDs without automatic capture generation', () => {
    const { db } = fixture();
    try {
        configureIndex(db, workspace, 'active');const { a, b, draft } = inputs(db);
        const bridge = withImmediateTransaction(db, () => saveIndexFact(db, workspace, draft));
        const manifest = db.prepare('SELECT manifest_json FROM memory_index_facts WHERE entry_id=?').get<{ manifest_json: string }>(bridge.id)!;
        assert.deepEqual(JSON.parse(manifest.manifest_json).sources.map((source: any) => source.entryId).sort(), [a.id, b.id].sort());
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_calls').get()?.n, 0);
        assert.ok(hybridSearch(db, { workspace, query: 'Widget write lock', limit: 10 }).some(item => item.entryId === bridge.id));
    } finally { db.close(); }
});
