import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '../dist/db/connection.js';
import { migrateDatabase } from '../dist/db/migrate.js';
import { registerRepositoryAndLocation } from '../dist/repository/binding.js';
import { DshRunIntakeService } from '../dist/dsh/run-intake-service.js';
import { AkinatorMemoryConfig } from '../dist/akinator/memory-probe-types.js';

export function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'akinator-measure-')));
  writeFileSync(join(root, 'target.ts'), 'export {};');
  const database = openConnection(':memory:'); migrateDatabase(database);
  const scope = { workspace: 'project:synthetic', repositoryId: 'repo-synthetic', repositoryRoot: root,
    allowed: true, verifiedTargets: ['target.ts'] };
  registerRepositoryAndLocation(database, { repositoryId: scope.repositoryId, workspace: scope.workspace,
    displayName: 'synthetic', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 });
  const now = '2026-09-13T00:00:00.000Z';
  const config = AkinatorMemoryConfig.parse({ mode: 'resolve', maxElapsedMs: 1000 });
  let sequence = 0;
  const service = new DshRunIntakeService(database, { now: () => now, runIdFactory: () => `run-${++sequence}`, sessionIdFactory: () => `intake-${sequence}` });
  function request(key, target, task = 'Implement target.ts', expected = 'checks pass') {
    return { idempotencyKey: key, dshSessionId: `native-${key}`, request: {
      apiVersion: '1', workspace: scope.workspace, task: { title: task, query: task,
        profileHints: { taskType: 'build', target, expected, constraints: null } },
      captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      metadata: { kiokukoProjectManifestBinding: { version: 1, repositoryId: scope.repositoryId, manifestDigest: 'a'.repeat(64) } },
    } };
  }
  function seed(key, target = 'target.ts', task = `Implement ${target}`) {
    const result = service.openRun(request(key, target, task));
    database.prepare("UPDATE ledger_runs SET status='completed', ended_at=? WHERE run_id=?").run(now, result.runId);
    return result;
  }
  return { database, scope, root, now, config, request, seed,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}
