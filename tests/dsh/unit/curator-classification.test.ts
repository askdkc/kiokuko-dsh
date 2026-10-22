import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '../../../src/db/connection.js';
import { migrateDatabase } from '../../../src/db/migrate.js';
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js';
import { recordEntry, readEntry, updateCandidateEntry } from '../../../src/memory/entries.js';
import { canonicalContentHash } from '../../../src/serialization/validate.js';
import { curateMemoryCandidates, globalizeCuratorCandidate, curatorCandidateForEntry } from '../../../src/memory/curator.js';
import { classifyCuratorEntry, readCuratorAssessment, curatorClassificationBatch, type CuratorBackend } from '../../../src/memory/curator-classification.js';
import { isTrustedCuratorGlobalMemory } from '../../../src/memory/curator-trust.js';
import { DecisionService } from '../../../src/dsh/decisions/service.js';
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js';
import { curatorClassifier } from '../../../src/dsh/decisions/curator.js';

const signal = () => new AbortController().signal;
const configurationDigest = canonicalContentHash('scripted-offline-curator-fixture');
function result(choices = ['yes', 'yes', 'no']) { return { provider: 'fixture', requestedModel: 'scripted-not-live', policyVersion: 'fixture-v1',
  answers: ['reusable', 'procedural', 'project-bound'].map((id, i) => ({ id, status: 'selected' as const, choiceId: choices[i]! })) }; }
function backend(choices?: string[]): CuratorBackend { return { configurationDigest, async evaluate() { return { status: 'completed', result: result(choices) }; } }; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'curator-classification-')); await mkdir(join(root, '.git'));
  const file = join(root, 'memory.sqlite'), db = openConnection(file); migrateDatabase(db);
  const project = (await resolveProjectWorkspace(db, root))!;
  return { root, file, db, workspace: project.workspace,
    entry: (body = 'Check a reusable workflow.', structured = false) => recordEntry(db, { workspace: project.workspace, kind: structured ? 'lesson' : 'fact', title: 'Assessment', body,
      scope: structured ? { schemaVersion: 3, visibility: 'project', memoryClass: 'workflow', applicability: { frameworks: [{ name: 'node' }] } } : { visibility: 'project' },
      provenance: { type: 'fixture', reference: 'curator' } }),
    close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

test('offline oracle: matched metadata multilingual final scores and local penalties are equal, not live semantic accuracy', async () => {
  const generic = ['再利用可能な手順を確認する。', 'Check a reusable workflow.', '检查可重复使用的流程。', '재사용 가능한 절차를 확인한다.'];
  const local = ['このプロジェクトだけの設定を確認する。', 'Check settings only for this project.', '检查仅用于此项目的设置。', '이 프로젝트에서만 사용하는 설정을 확인한다.'];
  for (const [index, texts] of [generic, local].entries()) for (const body of texts) {
    const f = await fixture(); try {
      const entry = f.entry(body, index === 1), b = backend(index ? ['no', 'yes', 'yes'] : undefined);
      const view = await curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: b });
      assert.equal(view.count, 1); assert.equal(view.candidates[0]!.score, 4);
      assert.equal(view.candidates[0]!.warnings.some(w => w.includes('プロジェクト固有')), index === 1);
      assert.equal(view.candidates[0]!.knowledge.skillReady, false);
      assert.equal(readEntry(f.db, { workspace: f.workspace, entryId: entry.id }).status, 'candidate');
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM entries WHERE workspace='global'").get()?.n, 0);
    } finally { await f.close(); }
  }
});

test('no classifier is explicit failclosed; byte length cannot supply missing semantic admission', async () => {
  const f = await fixture(); try {
    f.entry('再利用可能な手順を確認する。'.repeat(20));
    const missing = await curateMemoryCandidates(f.db, { workspace: f.workspace });
    assert.equal(missing.count, 0); assert.deepEqual(missing.classificationStatus, { classified: 0, unavailable: 1, reasons: ['classifier_disabled_or_unavailable'] });
    const neutral = await curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: backend(['no', 'no', 'no']) });
    assert.equal(neutral.count, 0);
  } finally { await f.close(); }
});

test('local semantic penalty crosses threshold despite structured metadata; exact threshold 4 is admitted', async () => {
  const f = await fixture(); try {
    f.entry('仅用于此项目的设置。', true);
    const view = await curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: backend(['no', 'no', 'yes']) });
    assert.equal(view.classificationStatus.classified, 1); assert.equal(view.count, 0); // 6 - 3 = 3
  } finally { await f.close(); }
});

test('persisted assessment replays without inference and human review digest plus current configuration are required', async () => {
  const f = await fixture(); try {
    const entry = f.entry(), b = backend(); const first = await classifyCuratorEntry(f.db, entry, b, signal()); assert.equal(first.status, 'classified');
    if (first.status !== 'classified') throw new Error();
    const reopened = openConnection(f.file); try {
      const replay = await classifyCuratorEntry(reopened, entry, { configurationDigest, async evaluate() { throw new Error('must not dispatch'); } }, signal());
      assert.deepEqual(replay, first);
    } finally { reopened.close(); }
    const input = { workspace: f.workspace, entryId: entry.id, expectedRevision: entry.revision, expectedClassificationDigest: first.assessment.digest };
    assert.throws(() => globalizeCuratorCandidate(f.db, input, { configurationDigest: canonicalContentHash('changed provider') }), { code: 'CONFLICT' });
    assert.throws(() => globalizeCuratorCandidate(f.db, { ...input, expectedClassificationDigest: '0'.repeat(64) }, { configurationDigest }), { code: 'CONFLICT' });
    const approved = globalizeCuratorCandidate(f.db, input, { configurationDigest });
    assert.ok(isTrustedCuratorGlobalMemory(approved.global));
    assert.equal(globalizeCuratorCandidate(f.db, input, { configurationDigest }).idempotent, true);
    assert.equal(readEntry(f.db, { workspace: f.workspace, entryId: entry.id }).status, 'candidate');
  } finally { await f.close(); }
});

test('stale revision/content, tampered store, malformed/abstained results, provider failure and timeout fail closed', async () => {
  const f = await fixture(); const keepAlive = setInterval(() => {}, 100); try {
    const entry = f.entry(); const accepted = await classifyCuratorEntry(f.db, entry, backend(), signal()); assert.equal(accepted.status, 'classified');
    if (accepted.status !== 'classified') throw new Error();
    f.db.prepare("UPDATE curator_classifications SET result_json='{}'").run();
    assert.equal(readCuratorAssessment(f.db, entry, { digest: accepted.assessment.digest }), undefined);
    assert.throws(() => curatorCandidateForEntry(f.db, { workspace: f.workspace, entryId: entry.id, classificationDigest: accepted.assessment.digest }), { code: 'CONFLICT' });
    f.db.prepare('DELETE FROM curator_classifications').run();
    for (const output of [{ ...result(), trustLevel: 'system_verified' }, result(['yes', 'yes', 'uncertain']), { ...result(), answers: [] },
      { ...result(), answers: [{ id: 'reusable', status: 'abstained', reason: 'uncertain' }, ...result().answers.slice(1)] }]) {
      const outcome = await classifyCuratorEntry(f.db, entry, { configurationDigest, async evaluate() { return { status: 'completed', result: output }; } }, signal());
      assert.equal(outcome.status, 'unavailable');
    }
    assert.equal((await classifyCuratorEntry(f.db, entry, { configurationDigest, async evaluate() { return { status: 'fallback', reason: 'DECISION_UNAVAILABLE' }; } }, signal())).status, 'unavailable');
    const timeout = await classifyCuratorEntry(f.db, entry, { configurationDigest, evaluate() { return new Promise(() => {}); } }, signal(), 5);
    assert.deepEqual(timeout, { status: 'unavailable', reason: 'timeout' });
    updateCandidateEntry(f.db, { workspace: f.workspace, entryId: entry.id, expectedRevision: entry.revision, kind: entry.kind, title: entry.title, scope: entry.scope, provenance: entry.provenance, body: 'Changed source.' });
    assert.deepEqual(await classifyCuratorEntry(f.db, entry, backend(), signal()), { status: 'unavailable', reason: 'entry_changed' });
    assert.throws(() => globalizeCuratorCandidate(f.db, { workspace: f.workspace, entryId: entry.id, expectedRevision: entry.revision, expectedClassificationDigest: accepted.assessment.digest }, { configurationDigest }), { code: 'CONFLICT' });
  } finally { clearInterval(keepAlive); await f.close(); }
});

test('dedicated provider-neutral purpose through DecisionService is opt-in, not correction classification', async () => {
  const f = await fixture(); try {
    const provider = { capabilities: { maxQuestions: 3, maxChoices: 3, maxBytes: 100000 }, async evaluate(batch: any) {
      assert.equal(batch.purpose, 'curator-classification'); assert.equal(batch.questions.length, 3); return result();
    } };
    const defaults = new DecisionService(TypedDecisionsConfig.parse({}), () => provider);
    assert.equal(await curatorClassifier(defaults), undefined);
    const service = new DecisionService(TypedDecisionsConfig.parse({ mode: 'auto', provider: 'typesafe', typesafe: { model: 'fixture' }, curatorClassification: { mode: 'auto' } }), () => provider);
    const b = await curatorClassifier(service); assert.ok(b);
    const entry = f.entry(); assert.equal(curatorClassificationBatch(entry).purpose, 'curator-classification');
    const classified = await classifyCuratorEntry(f.db, entry, b, signal()); assert.equal(classified.status, 'classified');
  } finally { await f.close(); }
});

test('project-bound admitted previews cannot globalize; provider changes and cancellation invalidate cached previews', async () => {
  const f = await fixture(); try {
    const entry = f.entry('Check settings only for this project.', true), b = backend(['no', 'yes', 'yes']);
    const view = await curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: b }); assert.equal(view.count, 1);
    const digest = view.candidates[0]!.classification.digest;
    assert.throws(() => globalizeCuratorCandidate(f.db, { workspace: f.workspace, entryId: entry.id, expectedRevision: 1, expectedClassificationDigest: digest }, { configurationDigest }), { code: 'CONFLICT' });
    const stale = await curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: { ...b, isCurrent: () => false } });
    assert.equal(stale.count, 0); assert.equal(stale.classificationStatus.unavailable, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: b, signal: controller.signal }));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM entries WHERE workspace='global'").get()?.n, 0);
  } finally { await f.close(); }
});

test('configuration switch during inference is not persisted under the prior provider identity', async () => {
  const f = await fixture(); try {
    const entry = f.entry(); let current = true;
    const changed = await classifyCuratorEntry(f.db, entry, { configurationDigest, isCurrent: () => current, async evaluate() { current = false; return { status: 'completed', result: result() }; } }, signal());
    assert.deepEqual(changed, { status: 'unavailable', reason: 'configuration_changed' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM curator_classifications').get()?.n, 0);
  } finally { await f.close(); }
});

test('missing storage and stale classification policy cannot fall back to lexical or caller metadata', async () => {
  const f = await fixture(); try {
    const entry = f.entry(); const first = await classifyCuratorEntry(f.db, entry, backend(), signal()); assert.equal(first.status, 'classified');
    if (first.status !== 'classified') throw new Error();
    f.db.prepare("UPDATE curator_classifications SET policy_version='obsolete'").run();
    assert.equal(readCuratorAssessment(f.db, entry, { digest: first.assessment.digest }), undefined);
    f.db.prepare('DROP TABLE curator_classifications').run();
    assert.deepEqual(await classifyCuratorEntry(f.db, entry, backend(), signal()), { status: 'unavailable', reason: 'storage_unavailable' });
    const view = await curateMemoryCandidates(f.db, { workspace: f.workspace }, { backend: backend() });
    assert.equal(view.count, 0); assert.deepEqual(view.classificationStatus.reasons, ['storage_unavailable']);
  } finally { await f.close(); }
});
