import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerRepositoryAndLocation } from '../dist/repository/binding.js';
import { mkdirSync as makeDirectory } from 'node:fs';
import { join } from 'node:path';
import { createFixture } from './akinator-memory-fixture.mjs';
import { probeProfileMemory } from '../dist/akinator/memory-probe.js';
import { DshRunIntakeService } from '../dist/dsh/run-intake-service.js';
import { readAkinatorSession } from '../dist/akinator/store.js';

const cases = [
  { name: 'exact-file', adopt: true, hints: true },
  { name: 'current-target', target: 'current.ts', adopt: false, hints: false },
  { name: 'current-complete', target: 'target.ts', expected: 'current checks', adopt: false, hints: false },
  { name: 'chat', taskType: 'chat', adopt: false, hints: false },
  { name: 'review-without-exact-id', taskType: 'review', exact: false, adopt: false, hints: true },
  { name: 'lexical-only', exact: false, adopt: false, hints: true },
  { name: 'missing-capability', allowed: false, adopt: false, hints: false },
  { name: 'conflicting-targets', conflict: true, adopt: false, hints: true },
  { name: 'partial-coverage', partial: true, adopt: false, hints: false },
  { name: 'bounded-truncated', duplicate: true, limit: 1, adopt: false, hints: true },
  { name: 'memory-is-not-confirmation', memory: true, adopt: false, hints: false },
  { name: 'previous-expected-only', expected: null, adopt: true, hints: true },
  { name: 'other-repository', foreign: true, adopt: false, hints: false },
];
const results = [];
for (const item of cases) {
  const f = createFixture();
  try {
    const source = f.seed('source');
    if (item.conflict) f.seed('other', 'different.ts', 'Implement target.ts elsewhere');
    if (item.duplicate) f.seed('duplicate');
    if (item.partial) f.database.exec('DELETE FROM akinator_profile_documents');
    if (item.memory) {
      f.database.prepare("UPDATE run_intakes SET profile_sources_json = ? WHERE run_id = ?")
        .run('{"expected":"client_supplied","target":"memory","taskType":"client_supplied"}', source.runId);
      const { projectProfileMemory } = await import('../dist/akinator/profile-memory-store.js');
      projectProfileMemory(f.database, f.scope.workspace, source.runId);
    }
    let scope = f.scope;
    if (item.foreign) {
      const otherRoot = join(f.root, 'other'); makeDirectory(otherRoot);
      registerRepositoryAndLocation(f.database, { repositoryId: 'repo-other', workspace: 'project:other', displayName: 'other',
        canonicalRoot: otherRoot, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 });
      scope = { ...scope, repositoryId: 'repo-other', workspace: 'project:other', repositoryRoot: otherRoot };
    }
    const profile = { taskType: item.taskType ?? 'build', target: item.target ?? null,
      expected: item.expected === undefined ? 'current checks' : item.expected, constraints: null };
    const result = probeProfileMemory(f.database, { task: 'Implement target.ts', profile, now: f.now,
      config: { ...f.config, maxCandidates: item.limit ?? 64 },
      scope: { ...scope, allowed: item.allowed ?? true, verifiedTargets: item.exact === false ? [] : f.scope.verifiedTargets } });
    const adopted = result.resolutions.some(r => r.decision === 'adopt');
    const targetHint = result.resolutions.some(r => r.field === 'target');
    assert.equal(adopted, item.adopt, item.name);
    assert.equal(targetHint, item.hints, item.name);
    assert.equal(result.resolutions.some(r => r.field !== 'target' && r.decision === 'adopt'), false);
    results.push({ name: item.name, correctAdoption: adopted === item.adopt, targetCandidateFound: targetHint,
      expectedCandidate: item.hints, scannedCandidates: result.scannedCandidates, queries: result.queryCount });
  } finally { f.close(); }
}
const questionModes = [];
for (const mode of ['off', 'shadow', 'suggest', 'resolve']) {
  const f = createFixture();
  try {
    f.seed('source');
    const service = new DshRunIntakeService(f.database, { now: () => f.now, akinatorMemory: { ...f.config, mode }, memoryScope: f.scope });
    const opened = service.openRun(f.request('current', null));
    const session = readAkinatorSession(f.database, { workspace: f.scope.workspace, sessionId: opened.intakeSessionId });
    questionModes.push({ mode, unresolvedRequiredFields: ['taskType', 'target', 'expected'].filter(field => session.profile[field] === null).length,
      needsAnswer: session.status === 'active' });
  } finally { f.close(); }
}
const positive = results.filter(r => r.expectedCandidate);
const output = { version: 1, seed: 'synthetic-profile-v1', cases: results,
  falseAdoptions: 0, candidateRecallAt64: positive.filter(r => r.targetCandidateFound).length / positive.length,
  questionModes, userCorrectionRate: null, postAdoptionCorrectionRate: null,
  limitations: ['Synthetic finite cases only; correction rates require user observations.', 'Unresolved field count is not a live user question count.', 'Ordinary scoped memory delivery is covered by integration tests, not this resolver dataset.'] };
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/akinator-memory-evaluation.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
