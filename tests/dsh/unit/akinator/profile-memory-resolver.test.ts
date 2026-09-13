import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProfileMemory } from '../../../../src/akinator/profile-memory-resolver.js';
import { AkinatorMemoryConfig, FieldResolutionSchema, type ProfileMemoryCandidate } from '../../../../src/akinator/memory-probe-types.js';
const config = AkinatorMemoryConfig.parse({ mode: 'resolve' });
const profile = { taskType: 'build' as const, target: null, expected: null, constraints: null };
const source: ProfileMemoryCandidate = { profile: { taskType: 'build', target: 'target.ts', expected: 'old success', constraints: 'old approval' },
  sources: { taskType: 'client_supplied', target: 'user_answer', expected: 'client_supplied', constraints: 'user_answer' },
  completed: true, exactTarget: true, rankingScore: 100,
  evidence: { runId: 'source', sessionId: 'intake', workspace: 'project:test', repositoryId: 'repo', profileHash: 'a'.repeat(64),
    sourceMapHash: 'b'.repeat(64), snapshotHash: 'c'.repeat(64), originalSource: 'user_answer', observedAt: '2026-09-13T00:00:00.000Z' } };

test('only a complete, grounded, exact target can be adopted; previous success and permission never are', () => {
  const result = resolveProfileMemory({ profile, candidates: [source], complete: true, config });
  assert.deepEqual(result.filter(r => r.decision === 'adopt').map(r => r.field), ['target']);
  assert.equal(result.some(r => r.field === 'constraints'), false);
  assert.equal(result.find(r => r.field === 'expected')?.decision, 'suggest');
  for (const candidate of [{ ...source, exactTarget: false }, { ...source, completed: false },
    { ...source, sources: { ...source.sources, target: 'inferred' as const } },
    { ...source, sources: { ...source.sources, target: 'memory' as const } }]) {
    assert.equal(resolveProfileMemory({ profile, candidates: [candidate], complete: true, config }).some(r => r.decision === 'adopt'), false);
  }
  assert.equal(resolveProfileMemory({ profile, candidates: [source], complete: false, config }).some(r => r.decision === 'adopt'), false);
});

test('current values, chat and non-target fields survive any number of repeated high-score memories', () => {
  const copies = Array.from({ length: 64 }, (_, i) => ({ ...source, evidence: { ...source.evidence, runId: `source-${i}` } }));
  assert.deepEqual(resolveProfileMemory({ profile: { ...profile, target: 'current.ts', expected: 'current success' }, candidates: copies, complete: true, config }), []);
  assert.deepEqual(resolveProfileMemory({ profile: { ...profile, taskType: 'chat' }, candidates: copies, complete: true, config }), []);
  const result = resolveProfileMemory({ profile: { ...profile, taskType: 'review' }, candidates: copies.map(s => ({ ...s, exactTarget: false })), complete: true, config });
  assert.equal(result.some(r => r.field === 'taskType' || r.decision === 'adopt'), false);
});

test('ties have stable order, limits hold and caller-owned data is not changed', () => {
  const candidates = ['z', 'a', 'b', 'c'].map(id => ({ ...source, profile: { ...source.profile, target: `${id}.ts` }, evidence: { ...source.evidence, runId: id } }));
  const before = structuredClone(candidates);
  const resolve = (items: ProfileMemoryCandidate[]) => resolveProfileMemory({ profile, candidates: items, complete: true, config });
  assert.deepEqual(resolve(candidates), resolve([...candidates].reverse()));
  assert.deepEqual(resolve(candidates).filter(r => r.field === 'target').map(r => r.value), ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(resolve(candidates).some(r => r.decision === 'adopt'), false);
  assert.deepEqual(candidates, before);
  const field = resolve(candidates)[0]!;
  assert.equal(FieldResolutionSchema.safeParse({ ...field, rankingScore: Infinity }).success, false);
  assert.equal(FieldResolutionSchema.safeParse({ ...field, evidence: [{ ...field.evidence[0], originalSource: 'trusted' }] }).success, false);
  assert.equal(FieldResolutionSchema.safeParse({ ...field, value: 'x'.repeat(1025) }).success, false);
});
