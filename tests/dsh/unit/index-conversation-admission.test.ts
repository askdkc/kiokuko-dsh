import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, createRun } from '../integration/evolution/fixture.js';
import { recordEntry } from '../../../src/memory/entries.js';
import { MemoryIndexReasoningConfig } from '../../../src/memory/index-reasoning/contracts.js';
import { IndexReasoningService } from '../../../src/memory/index-reasoning/service.js';
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js';

const workspace = 'project:test';
const envelope = { provider: 'fixture', model: 'fixed', contextWindow: 131072 };

test('trusted conversation admission runs all three indexing stages without a ledger run', async () => {
    const { db, runtime } = fixture();
    const originals = ['Widget uses SQLite.', 'SQLite uses a write lock.'].map((body, index) => recordEntry(db, {
        workspace, kind: 'fact', title: `Source ${index}`, body, scope: { visibility: 'project' }, createdBy: 'fixture',
    }));
    const sources = originals.map(entry => ({ entryId: entry.id, revision: entry.revision, contentHash: entry.contentHash, supportingText: entry.body }));
    const entities = [{ type: 'package', value: 'SQLite' }];
    const atomic = sources.map(source => ({ role: 'atomic', text: source.supportingText, applicability: null, entities, sources: [source] }));
    const bridge = { role: 'bridge', text: 'Widget uses SQLite, which uses a write lock.', applicability: null, entities, sources };
    let calls = 0;
    const service = new IndexReasoningService(runtime, MemoryIndexReasoningConfig.parse({}), {
        async *stream(request) {
            assert.equal(request.sessionId, 'conversation');
            const output = [atomic, [bridge], [0, 1, 2].map(index => ({ index, verdict: 'supported' }))][calls++];
            yield { type: 'text-delta', text: JSON.stringify(output) };
            yield { type: 'finish', reason: { kind: 'stop' } };
        },
    });
    try {
        await service.admitConversation(workspace, 'conversation', envelope, () => true);
        await service.whenIdle();
        assert.equal(calls, 3);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_facts').get()?.n, 3);
        assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_memory_finalizations').get()?.n, 0);
        const status = await service.indexCommand('conversation', 'status --json');
        assert.equal((status.calls as { count: number }).count, 3);
    } finally { await service.dispose(); db.close(); }
});

test('ledger admission still requires a run, and conversation authority is checked inside its transaction', async () => {
    const { db, runtime } = fixture();
    let current = true, inTransaction = false, checks = 0;
    const execute = db.exec.bind(db);
    db.exec = sql => {
        execute(sql);
        if (sql === 'BEGIN IMMEDIATE') inTransaction = true;
        if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false;
    };
    const service = new IndexReasoningService({ withDatabase: async operation => {
        current = false; // Native identity changed while admission waited for database access.
        return runtime.withDatabase(operation);
    } }, MemoryIndexReasoningConfig.parse({}));
    try {
        await service.admitIndex(workspace, 'conversation', envelope);
        await service.admitConversation(workspace, 'conversation', envelope, () => {
            checks++;
            assert.equal(inTransaction, true);
            return current;
        });
        await service.whenIdle();
        assert.equal(checks, 1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_settings').get()?.n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_jobs').get()?.n, 0);
        await assert.rejects(service.indexCommand('conversation', 'status'), /workspace_unknown/);
    } finally { await service.dispose(); db.close(); }
});

test('conversation model validation and explicit indexing mode are preserved', async () => {
    const { db, runtime } = fixture();
    recordEntry(db, { workspace, kind: 'fact', title: 'Source', body: 'Widget uses SQLite.', scope: { visibility: 'project' }, createdBy: 'fixture' });
    let calls = 0;
    const service = new IndexReasoningService(runtime, MemoryIndexReasoningConfig.parse({ mode: 'off' }), {
        async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } }; },
    });
    try {
        await service.admitConversation(workspace, 'conversation', envelope, () => true);
        await service.whenIdle();
        assert.equal(calls, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM memory_index_jobs').get()?.n, 0);
        const status = await service.indexCommand('conversation', 'status');
        assert.equal((status.settings as { mode: string }).mode, 'off');
        await service.admitConversation(workspace, 'conversation', { provider: 'fixture', model: 'fixed' }, () => true);
        assert.equal(db.prepare('SELECT model_json FROM memory_index_settings').get()?.model_json, null);
        await service.indexCommand('conversation', 'mode observe');
        await service.admitConversation(workspace, 'conversation', { provider: 'fixture', model: 'fixed' }, () => true);
        assert.equal(db.prepare('SELECT mode FROM memory_index_settings').get()?.mode, 'observe');
        const waiting = (await service.indexCommand('conversation', 'status')).waiting as { reason: string };
        assert.equal(waiting.reason, 'model_unknown');
        assert.equal(calls, 0);
    } finally { await service.dispose(); db.close(); }
});

test('conversation commands reject stale, ambiguous, and cross-workspace bindings', async () => {
    const { db, runtime } = fixture();
    const service = new IndexReasoningService(runtime, MemoryIndexReasoningConfig.parse({ mode: 'off' }));
    let current = true;
    try {
        await service.admitConversation(workspace, 'conversation', envelope, () => current);
        await service.indexCommand('conversation', 'status');
        current = false;
        await assert.rejects(service.indexCommand('conversation', 'mode active'), /workspace_unknown/);
        assert.equal(db.prepare('SELECT mode FROM memory_index_settings').get()?.mode, 'off');
        await service.admitConversation(workspace, 'ambiguous', envelope, () => true);
        await service.admitConversation('project:other', 'ambiguous', envelope, () => true);
        await assert.rejects(service.indexCommand('ambiguous', 'status'), /workspace_unknown/);
        createRun(db, 'ledger', 'project:other');
        await service.admitConversation(workspace, 'session-ledger', envelope, () => true);
        await assert.rejects(service.indexCommand('session-ledger', 'status'), /workspace_unknown/);
        await service.admitConversation(workspace, 'retired', envelope, () => true);
        await service.dispose();
        await assert.rejects(service.indexCommand('retired', 'status'), /workspace_unknown/);
    } finally { await service.dispose(); db.close(); }
});

test('memory finalizer forwards trusted conversation indexing without run finalization', async () => {
    const { db, runtime } = fixture();
    const finalizer = new DshMemoryFinalizer({ runtime, memoryIndexReasoning: MemoryIndexReasoningConfig.parse({ mode: 'off' }), autoGlobalizationEnabled: false });
    try {
        await finalizer.start();
        await finalizer.admitConversationIndex(workspace, 'conversation', envelope, () => true);
        const status = await finalizer.indexCommand('conversation', 'status --json');
        assert.equal((status.settings as { mode: string }).mode, 'off');
        assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_runs').get()?.n, 0);
    } finally { await finalizer.dispose(); db.close(); }
});
