import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../../src/errors.js';
import { reviewCompletedReplay, type ReplayMemoryProposal } from '../../../src/memory/replay-review.js';

const proposal = (): ReplayMemoryProposal => ({ schemaVersion: 1, proposalId: 'fixture', revision: 1,
  source: { workspace: 'project:fixture', taskId: 'task', sessionId: 'session', traces: [] },
  request: { text: 'Inspect parser result', evidenceRefs: [] }, languages: [], attempts: [], findings: [], tags: [], keywords: [] });

for (const failedPhase of ['organize', 'extract', 'save'] as const) {
  test(`memory ${failedPhase} failure retains its cause and phase without claiming a save`, async () => {
    const failure = new KiokukoError('DATABASE_ERROR', 'SQLITE_BUSY while writing the approved memory');
    const failures: Array<{ error: unknown; phase: string }> = [];
    let saves = 0;
    const receipt = await reviewCompletedReplay({ completed: true, taskId: 'task', sessionId: 'session', workspace: 'project:fixture',
      ask: async q => { if (failedPhase === 'organize') throw failure; return { questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'approve' }; },
      extract: async () => { if (failedPhase === 'extract') throw failure; return proposal(); },
      save: async () => { saves++; throw failure; },
      onFailure: (error: unknown, phase: string) => { failures.push({ error, phase }); },
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(saves, failedPhase === 'save' ? 1 : 0);
    assert.equal(Boolean(receipt.approvalKey), failedPhase === 'save');
    assert.deepEqual(failures, [{ error: failure, phase: failedPhase }]);
  });
}

test('a broken diagnostic sink cannot upgrade a failed save to success', async () => {
  const receipt = await reviewCompletedReplay({ completed: true, taskId: 'task', sessionId: 'session', workspace: 'project:fixture',
    extract: async () => proposal(), ask: async q => ({ questionId: q.id, choice: q.phase === 'organize' ? 'organize' : 'approve' }),
    save: async () => { throw new Error('commit outcome unknown'); }, onFailure: () => { throw new Error('logger unavailable'); } });
  assert.equal(receipt.status, 'unavailable');
  assert.ok(receipt.approvalKey);
});
