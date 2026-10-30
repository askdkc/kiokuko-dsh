import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deepNativeFixture } from '../helpers/deep-native-fixture.js';
import { recordEntryInTransaction as recordEntry, updateCandidateEntry, type EntryRecord } from '../../../src/memory/entries.js';
import { configureIndex, saveIndexFact } from '../../../src/memory/index-reasoning/store.js';
import { withImmediateTransaction } from '../../../src/db/transaction.js';
import { isolateSkillHome } from '../helpers/skill-home.js';
isolateSkillHome();
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules');
const available = existsSync(join(packages, '@deepseek-ai/dsh-agent-loop/lib/index.js'));
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !available)
    throw new Error('Pinned DSH runtime required');
test('historical bridge citations remain readable through the native command without automatic request injection', { skip: !available, timeout: 60000 }, async () => {
    const previous = process.env.KIOKUKO_DSH_PACKAGE_ROOT;
    process.env.KIOKUKO_DSH_PACKAGE_ROOT = packages;
    const f = await deepNativeFixture(mock => Array.from({ length: 4 }, () => (request: any) => mock.textResponse(request.purpose === 'compaction' ? JSON.stringify({schemaVersion:request.system.includes('Use schemaVersion 4')?4:3,memoryOperations:[]}) : 'Driver explanation.')), { questions: async (request) => request.questions[0]?.id.startsWith('task-startup:') ? answerTaskStartup(request, 'decision OFF / Lisp OFF') : ({ answers: request.questions.map((q: any) => ({ id: q.id, selected: [q.id === 'taskType' ? 'chat' : q.options?.[0]?.value ?? q.options?.[0]?.label ?? 'chat'] })) }) });
    let original: EntryRecord, bridgeId: string;
    try {
        await f.adapter.host.runtime!.withDatabase(db => withImmediateTransaction(db, () => {
            configureIndex(db, 'deep-cases', 'active');
            const a = recordEntry(db, { workspace: 'deep-cases', kind: 'fact', title: 'Widget driver', body: 'Widget uses SQLite in fixture-v1.', scope: { visibility: 'project' }, createdBy: 'fixture' });
            original = a;
            const b = recordEntry(db, { workspace: 'deep-cases', kind: 'fact', title: 'SQLite constraint', body: 'SQLite uses a write lock in fixture-v1.', scope: { visibility: 'project' }, createdBy: 'fixture' });
            bridgeId = saveIndexFact(db, 'deep-cases', { role: 'bridge', text: 'Widget writes use the SQLite write lock in fixture-v1.', applicability: 'fixture-v1 only', entities: [{ type: 'package', value: 'SQLite' }], sources: [a, b].map(e => ({ entryId: e.id, revision: e.revision, contentHash: e.contentHash, supportingText: e.body })) }).id;
        }));
        f.parent.followup(f.llm.createUserMessage({ content: [{ type: 'text', text: '通常実行で、Widget SQLite write lock in fixture-v1 の関係を説明してください。' }], source: { kind: 'user' } }));
        await f.parent.whenIdle();
        assert.equal(f.provider.requests.length, 1);
        const text = JSON.stringify(f.provider.requests[0].messages);
        assert.ok(!text.includes('Widget writes use the SQLite write lock in fixture-v1'));
        const explainedExecution = await f.command(`/kioku-memory explain ${bridgeId!} --json`);
        assert.ok(explainedExecution, 'the native command must resolve');
        const explained = explainedExecution.result;
        assert.equal(explained.kind, 'success', JSON.stringify(explained));
        const detail = JSON.parse(explained.text);
        assert.match(detail.body, /Widget writes use the SQLite write lock in fixture-v1/);
        assert.equal(detail.derivation.manifest.applicability, 'fixture-v1 only');
        assert.equal(detail.lineage.sources.length, 2);
        assert.equal(detail.derivation.manifest.sources.length, 2);
        assert.ok(detail.derivation.manifest.sources.every((source: any) => source.supportingText.includes('fixture-v1')));
        assert.equal(detail.trust, 'untrusted');assert.equal(detail.semanticVerification, 'not_proven');assert.equal(detail.eligible, true);
        assert.equal(await f.adapter.host.runtime!.withDatabase(db => db.prepare('SELECT COUNT(*) AS n FROM ledger_runs').get()?.n), 0);
        await f.adapter.host.runtime!.withDatabase(db => updateCandidateEntry(db, { workspace: 'deep-cases', entryId: original.id, expectedRevision: original.revision, kind: original.kind, title: original.title, body: 'Widget now uses another driver in fixture-v2.', scope: original.scope }));
        const staleExecution = await f.command(`/kioku-memory explain ${bridgeId!} --json`);
        assert.ok(staleExecution, 'the native command must resolve after source correction');
        const stale = staleExecution.result;
        assert.equal(stale.kind, 'success', JSON.stringify(stale));
        assert.equal(JSON.parse(stale.text).eligible, false);
        assert.equal(JSON.parse(stale.text).reason, 'index_sources_or_settings_ineligible');
        f.parent.followup(f.llm.createUserMessage({ content: [{ type: 'text', text: '通常実行で、更新後の Widget driver in fixture-v2 を説明してください。' }], source: { kind: 'user' } }));
        await f.parent.whenIdle();
        const updatedRequests = f.provider.requests.slice(1).filter(request => request.purpose !== 'compaction');
        assert.equal(updatedRequests.length, 1);
        for (const request of updatedRequests)
            assert.ok(!JSON.stringify(request.messages).includes('Widget writes use the SQLite write lock in fixture-v1'));
    }
    finally {
        await f.close();
        if (previous === undefined)
            delete process.env.KIOKUKO_DSH_PACKAGE_ROOT;
        else
            process.env.KIOKUKO_DSH_PACKAGE_ROOT = previous;
    }
});

// Positive post-task native approval is covered by replay-memory-review.test.ts
// and replay-unowned-native-review.test.ts. Historical bridge retrieval above remains supported.
test('ordinary native requests do not automatically derive a bridge or persist memory proposals', { skip: !available, timeout: 60000 }, async () => {
    const previous = process.env.KIOKUKO_DSH_PACKAGE_ROOT;
    process.env.KIOKUKO_DSH_PACKAGE_ROOT = packages;
    let generationCalls = 0;
    const explain = 'Widget writes need the SQLite write lock in fixture-v1.';
    const f = await deepNativeFixture(mock => Array.from({ length: 12 }, () => (request: any) => {
        let output: unknown = { schemaVersion: request.system.includes('Use schemaVersion 4')?4:3, memoryOperations: [] };
        if (request.system?.startsWith('Extract up to')) {
            generationCalls++;
            output = JSON.parse(request.messages[0].content[0].text).map((e: EntryRecord) => ({ role: 'atomic', text: e.body, applicability: 'fixture-v1 only', entities: [{ type: 'package', value: 'SQLite' }], sources: [{ entryId: e.id, revision: e.revision, contentHash: e.contentHash, supportingText: e.body }] }));
        } else if (request.system?.startsWith('Return JSON array')) {
            generationCalls++;
            const pair = JSON.parse(request.messages[0].content[0].text)[0];
            output = [{ role: 'bridge', text: explain, applicability: 'fixture-v1 only', entities: [{ type: 'package', value: 'SQLite' }], sources: pair.flatMap((d: any) => d.sources) }];
        } else if (request.system?.startsWith('Check each supplied')) {
            generationCalls++;
            output = JSON.parse(request.messages[0].content[0].text).drafts.map((_: unknown, index: number) => ({ index, verdict: 'supported' }));
        }
        return mock.textResponse(request.purpose === 'compaction' ? JSON.stringify(output) : 'Driver explanation.');
    }), { questions: async request => request.questions[0]?.id.startsWith('task-startup:') ? answerTaskStartup(request, 'decision OFF / Lisp OFF') : ({ answers: request.questions.map((q: any) => ({ id: q.id, selected: [q.id === 'taskType' ? 'chat' : q.options?.[0]?.value ?? q.options?.[0]?.label ?? 'chat'] })) }) });
    f.provider.resolveModel = async (provider: string, model: string) => ({ provider, id: model, name: model, context: { contextWindow: 131072 } });
    try {
        await f.adapter.host.runtime!.withDatabase(db => withImmediateTransaction(db, () => {
            for (const [title, body] of [['Widget driver', 'Widget uses SQLite in fixture-v1.'], ['SQLite constraint', 'SQLite uses a write lock in fixture-v1.']])
                recordEntry(db, { workspace: 'deep-cases', kind: 'fact', title: title!, body: body!, scope: { visibility: 'project' }, createdBy: 'fixture' });
        }));
        const ask = () => f.parent.followup(f.llm.createUserMessage({ content: [{ type: 'text', text: '通常実行で、Widget SQLite write lock in fixture-v1 の関係を説明してください。' }], source: { kind: 'user' } }));
        ask();
        await f.parent.whenIdle();
        await f.adapter.host.memoryFinalizer!.whenIdle();
        assert.equal(generationCalls, 0);
        assert.equal(await f.adapter.host.runtime!.withDatabase(db => db.prepare("SELECT count(*) AS n FROM memory_index_facts WHERE role='bridge'").get()?.n), 0);
        ask();
        await f.parent.whenIdle();
        const normal = f.provider.requests.filter(request => request.purpose !== 'compaction');
        assert.equal(normal.length, 2);
        const input = JSON.stringify(normal[1].messages);
        assert.ok(!input.includes(explain));
        assert.equal(await f.adapter.host.runtime!.withDatabase(db => db.prepare("SELECT count(*) AS n FROM dsh_memory_finalizations").get()?.n), 0);
        assert.equal(await f.adapter.host.runtime!.withDatabase(db => db.prepare("SELECT count(*) AS n FROM memory_index_jobs").get()?.n), 0);
        assert.equal(generationCalls, 0);
    } finally {
        await f.close();
        if (previous === undefined) delete process.env.KIOKUKO_DSH_PACKAGE_ROOT;
        else process.env.KIOKUKO_DSH_PACKAGE_ROOT = previous;
    }
});
