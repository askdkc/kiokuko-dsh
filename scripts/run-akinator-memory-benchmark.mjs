import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createFixture } from './akinator-memory-fixture.mjs';
import { recordEntryInTransaction, readEntry } from '../dist/memory/entries.js';
import { isRetrievableEntry } from '../dist/memory/hybrid-retrieval.js';
import { taggedEntries, getAkinatorStateService } from '../dist/akinator/service.js';
import { prepareAgentTask } from '../dist/dsh/task-intake.js';
import { probeProfileMemory } from '../dist/akinator/memory-probe.js';

const large = process.argv.includes('--large');
const entries = large ? 100_000 : 10_000;
const profiles = large ? 10_000 : 1_000;
const runs = large ? 5 : 10;
const f = createFixture();
const counts = { sql: 0, entryReads: 0, profileReads: 0 };
let writeStarted = null, writeMs = 0;
const db = { ...f.database, filePath: f.database.filePath, exec(sql) {
    if (/BEGIN IMMEDIATE/u.test(sql)) writeStarted = performance.now();
    f.database.exec(sql);
    if (writeStarted !== null && /COMMIT|ROLLBACK/u.test(sql)) { writeMs += performance.now() - writeStarted; writeStarted = null; }
  }, close() {},
  prepare(sql) {
    const statement = f.database.prepare(sql);
    const count = () => { counts.sql++; if (sql.includes('AS revision_count')) counts.entryReads++;
      if (/FROM akinator_sessions\s+WHERE id/u.test(sql)) counts.profileReads++; };
    return { get(...args) { count(); return statement.get(...args); }, all(...args) { count(); return statement.all(...args); }, run(...args) { count(); return statement.run(...args); } };
  } };
function oldTags() {
  return db.prepare('SELECT id FROM entries WHERE workspace = ? ORDER BY updated_at DESC, id ASC').all(f.scope.workspace)
    .map(row => readEntry(db, { workspace: f.scope.workspace, entryId: row.id }))
    .filter(entry => isRetrievableEntry(db, entry) && entry.status !== 'superseded' && entry.tags.includes('skill:tdd')).slice(0, 12);
}
function measure(name, fn, samples = runs) {
  const times = [], countSamples = [];
  const cpu = process.cpuUsage();
  let value;
  for (let i = 0; i < samples; i++) {
    Object.assign(counts, { sql: 0, entryReads: 0, profileReads: 0 });
    const start = performance.now(); value = fn(); times.push(performance.now() - start); countSamples.push({ ...counts });
  }
  const sorted = [...times].sort((a,b) => a-b), usedCpu = process.cpuUsage(cpu);
  return { name, samples, firstMs: times[0], warmP50Ms: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    sql: countSamples[0].sql, entryReads: countSamples[0].entryReads, profileReads: countSamples[0].profileReads,
    scannedCandidates: value?.scannedCandidates ?? null, expandedProfiles: value?.expandedProfiles ?? null,
    status: value?.status ?? null };
}
try {
  console.error(`Building synthetic corpus: ${entries} entries, ${profiles} profiles.`);
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.database.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < entries; i++) {
      if (i > 0 && i % 10000 === 0) console.error(`Created ${i} entries.`);
      recordEntryInTransaction(f.database, {
      workspace: f.scope.workspace, kind: 'lesson', title: `Synthetic entry ${i}`, body: `Synthetic body ${i}: 日本語 English`,
      tags: i < 12 ? ['skill:tdd'] : ['unrelated'], scope: { visibility: 'project' }, createdBy: 'benchmark',
    }, { now: f.now, idFactory: () => `entry-${String(i).padStart(7, '0')}` });
    }
    f.database.exec('COMMIT');
  } catch (e) { f.database.exec('ROLLBACK'); throw e; }
  console.error('Entries ready; projecting synthetic profiles.');
  const source = f.seed('profile-0');
  for (let i = 1; i < profiles; i++) {
    if (i % 1000 === 0) console.error(`Projected ${i} profiles.`);
    f.seed(`profile-${i}`, `unrelated-${i}.ts`, `Distinct subject ${i} 別の対象`);
  }
  // Exclude fixture generation from the event-loop observation.
  await new Promise(resolve => setTimeout(resolve, 20)); loop.reset();
  console.error('Measuring legacy/indexed tag search and bounded profile probes.');
  const timerStarted = performance.now();
  const timerDelay = new Promise(resolve => setTimeout(() => resolve(performance.now() - timerStarted), 0));
  const baseline = measure('old-full-tag-scan', oldTags, large ? 2 : 3);
  const indexed = measure('indexed-tag-scan', () => taggedEntries(db, f.scope.workspace, ['skill:tdd']));
  assert.equal(baseline.entryReads, entries); assert.equal(indexed.entryReads, 12);
  assert.deepEqual(oldTags().map(e => e.id), taggedEntries(db, f.scope.workspace, ['skill:tdd']).map(e => e.id));
  const measurements = [baseline, indexed];
  for (const mode of ['off', 'shadow', 'suggest', 'resolve']) {
    measurements.push(measure(`probe-${mode}`, () => probeProfileMemory(db, { task: 'Implement target.ts',
      profile: { taskType: 'build', target: null, expected: 'current checks', constraints: null },
      config: { ...f.config, mode }, scope: f.scope, now: f.now })));
  }
  Object.assign(counts, { sql: 0, entryReads: 0, profileReads: 0 });
  await getAkinatorStateService(db, { workspace: f.scope.workspace, sessionId: source.intakeSessionId });
  assert.equal(counts.entryReads, 0);
  const stateLookup = { ...counts };
  const synchronousWorkloadTimerDelayMs = await timerDelay;
  const prepareMeasurements = [];
  for (const mode of ['off', 'shadow', 'suggest', 'resolve']) {
    Object.assign(counts, { sql: 0, entryReads: 0, profileReads: 0 }); writeMs = 0;
    console.error(`Measuring full grounded prepare (${mode}); existing scoped validation may take time at this corpus size.`);
    const begin = performance.now();
    let prepared;
    try { prepared = await prepareAgentTask(db, { requestId: `prepare-${mode}`, dshSessionId: `session-${mode}`,
      task: 'Implement target.ts', cwd: f.root, profileHints: { taskType: 'build', target: f.root, expected: 'current checks' },
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }], skillDiscoveryMode: 'off' },
      { akinatorMemory: { ...f.config, mode } });
    } catch (error) {
      if (error?.code !== 'INTEGRITY_ERROR' || error.message !== 'Context selection state exceeds the policy bound') throw error;
      prepareMeasurements.push({ mode, elapsedMs: performance.now() - begin, writeTransactionMs: writeMs,
        ...counts, status: 'blocked', errorCode: error.code, reason: 'existing-context-selection-state-bound' });
      console.error('Full prepare reached the existing context selection state bound; preserving completed search measurements.');
      break;
    }
    prepareMeasurements.push({ mode, elapsedMs: performance.now() - begin, writeTransactionMs: writeMs,
      ...counts, status: prepared.intake.status, deliveredItems: prepared.context?.items.length ?? 0 });
  }
  await new Promise(resolve => setTimeout(resolve, 20)); loop.disable();
  const output = { version: 1, seed: 'synthetic-profile-v1', node: process.version,
    sqlite: f.database.prepare('SELECT sqlite_version() AS version').get().version,
    platform: process.platform, architecture: process.arch, entries, profiles, measurements, stateLookup,
    eventLoopDelayMaxMs: loop.max / 1e6, synchronousWorkloadTimerDelayMs, prepareMeasurements, rssMiB: process.memoryUsage().rss / 1024 / 1024,
    limitations: ['In-memory SQLite, first-query/warm samples; not disk cold-cache measurements.',
      'Event-loop delay covers the combined synchronous search workload, including the baseline.',
      'Prepare measurements use explicit grounded inputs, local synthetic entries, discovery off and no embedding runtime; no network or model latency.'] };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(`artifacts/akinator-memory-benchmark${large ? '-large' : ''}.json`, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
} finally { f.close(); }
