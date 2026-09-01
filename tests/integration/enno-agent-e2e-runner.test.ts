import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const runner = path.resolve(import.meta.dirname, '../../scripts/run-enno-agent-e2e.mjs');

async function fakeCodex(directory: string, name: string, versionOutput: string): Promise<string> {
  const executable = path.join(directory, name);
  await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(versionOutput)});\n`);
  await chmod(executable, 0o755);
  return executable;
}

test('an explicitly requested Codex E2E fails when the executable version is unavailable or too old', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-codex-e2e-preflight-'));
  const cases = [
    { command: path.join(directory, 'missing-codex'), reason: 'codex_version_unavailable' },
    { command: await fakeCodex(directory, 'old-codex', 'codex-cli 0.150.0\n'), reason: 'codex_version_below_0.151.0' },
    { command: await fakeCodex(directory, 'invalid-codex', 'codex-cli unknown\n'), reason: 'codex_version_unavailable' },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      execute(process.execPath, [runner, 'codex'], {
        env: { ...process.env, RUN_CODEX_E2E: '1', CODEX_E2E_COMMAND: fixture.command },
      }),
      (error: unknown) => {
        const failure = error as { code?: unknown; stdout?: unknown };
        if (failure.code !== 1 || typeof failure.stdout !== 'string') return false;
        const result = JSON.parse(failure.stdout) as { results?: Array<{ status?: string; reason?: string }> };
        return result.results?.[0]?.status === 'failed' && result.results[0].reason === fixture.reason;
      },
    );
  }
});
