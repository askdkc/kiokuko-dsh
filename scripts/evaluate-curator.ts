/** Explicit offline oracle or live configured-provider benchmark; never promotes memory. */
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '../src/db/connection.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { resolveProjectWorkspace } from '../src/memory/workspaces.js';
import { recordEntry } from '../src/memory/entries.js';
import { curateMemoryCandidates } from '../src/memory/curator.js';
import { canonicalContentHash } from '../src/serialization/validate.js';
import { classifyCuratorEntry, type CuratorBackend } from '../src/memory/curator-classification.js';
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.js';
import { DecisionService } from '../src/dsh/decisions/service.js';
import { curatorClassifier } from '../src/dsh/decisions/curator.js';
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from '../src/dsh/decisions/providers.js';
import { LayaCoreMLDecisionProvider } from '../src/dsh/decisions/laya-coreml.js';
import { LayaV1DecisionProvider } from '../src/dsh/decisions/laya-v1.js';

const [mode, configurationFile] = process.argv.slice(2);
if (mode !== '--oracle' && (mode !== '--live' || !configurationFile)) throw new Error('Usage: node --import tsx scripts/evaluate-curator.ts --oracle | --live config.json');
const cases = JSON.parse(await readFile(new URL('../tests/fixtures/curator/semantic-cases.json', import.meta.url), 'utf8')) as Array<{ language: string; case: string; body: string; expected: boolean[] }>;
let live: CuratorBackend | undefined;
if (mode === '--live') {
  const config = TypedDecisionsConfig.parse(JSON.parse(await readFile(configurationFile!, 'utf8')));
  if (config.curatorClassification?.mode !== 'auto') throw new Error('Explicit curatorClassification.mode:auto required for the live benchmark');
  const service = new DecisionService(config, (c, observer) => {
    if (c.provider === 'typesafe') return new TypeSafeDecisionProvider(c.typesafe, async () => { const value = process.env.TYPESAFE_API_KEY; if (!value) throw new Error('Missing TYPESAFE_API_KEY'); return value; }, undefined, observer);
    if (c.provider === 'nimble') return new NimbleDecisionProvider(c.nimble, async () => c.nimble.credentialRef ? process.env[c.nimble.credentialRef] : undefined, undefined, observer);
    if (!c['laya-coreml']) throw new Error('Missing Laya configuration');
    return c['laya-coreml'].protocol === 'v1' ? new LayaV1DecisionProvider(c['laya-coreml'], undefined, observer) : new LayaCoreMLDecisionProvider(c['laya-coreml'], undefined, observer);
  });
  live = await curatorClassifier(service); if (!live) throw new Error('Classifier unavailable');
}
const observations = [];
for (const item of cases) {
  const root = await mkdtemp(join(tmpdir(), 'curator-benchmark-')); await mkdir(join(root, '.git'));
  const db = openConnection(':memory:'); migrateDatabase(db);
  try {
    const project = (await resolveProjectWorkspace(db, root))!;
    // Matched metadata across languages, no language-encoded title/tags/length bonus.
    const entry = recordEntry(db, { workspace: project.workspace, kind: 'fact', title: 'Assessment', body: item.body,
      scope: { visibility: 'project' }, provenance: { type: 'fixture', reference: 'curator-benchmark' } });
    const backend: CuratorBackend = live ?? { configurationDigest: canonicalContentHash('offline-oracle'), async evaluate(_id, batch) {
      return { status: 'completed', result: { provider: 'offline-oracle', requestedModel: 'none', policyVersion: 'oracle-v1',
        answers: batch.questions.map((q, i) => ({ id: q.id, status: 'selected', choiceId: item.expected[i] ? 'yes' : 'no' })) } };
    } };
    const started = performance.now();
    const classification = await classifyCuratorEntry(db, entry, backend, new AbortController().signal);
    // Never retry an unavailable/abstained sample while computing admission.
    const view = classification.status === 'classified' ? await curateMemoryCandidates(db, { workspace: project.workspace }, { backend }) : undefined;
    const actual = classification.status === 'classified' ? [classification.assessment.reusable, classification.assessment.procedural, classification.assessment.projectBound] : null;
    observations.push({ language: item.language, case: item.case, expected: item.expected, actual, status: classification.status,
      reason: classification.status === 'unavailable' ? classification.reason : null,
      exactMatch: actual !== null && JSON.stringify(actual) === JSON.stringify(item.expected),
      missedLocalBoundary: item.expected[2] && actual !== null && !actual[2],
      configurationDigest: backend.configurationDigest,
      provider: classification.status === 'classified' ? classification.assessment.provider : null,
      requestedModel: classification.status === 'classified' ? classification.assessment.requestedModel : null,
      score: view?.candidates[0]?.score ?? null, admitted: (view?.count ?? 0) > 0, elapsedMs: performance.now() - started,
      inputTokens: null, outputTokens: null, cost: null });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ measurementScope: mode === '--oracle' ? 'offline-plumbing-not-semantic-quality' : 'live-provider-semantic-quality',
  inputDigest: canonicalContentHash(cases), observations, exactMatches: observations.filter(o => o.exactMatch).length,
  missedLocalBoundaries: observations.filter(o => o.missedLocalBoundary).length, liveRequested: mode === '--live', samplesAttempted: observations.length, samplesClassified: observations.filter(o => o.status === 'classified').length,
  liveQualityMeasured: mode === '--live' && observations.some(o => o.status === 'classified') }, null, 2));
