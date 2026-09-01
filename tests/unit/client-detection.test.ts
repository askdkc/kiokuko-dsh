import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectInstalledClients, isHermesAgentInstalled } from '../../src/setup/client-detection.js';

test('detects Hermes only from an executable path without writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-detection-'));
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes');
  await mkdir(hermesHome, { recursive: true });

  assert.equal(await isHermesAgentInstalled({ platform: 'linux', env: { HOME: home, PATH: '' } }), false);

  await writeFile(path.join(hermesHome, 'config.yaml'), 'mcp_servers: {}\n');
  assert.equal(await isHermesAgentInstalled({ platform: 'linux', env: { HOME: home, PATH: '' } }), false);

  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'hermes');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);
  assert.equal(await isHermesAgentInstalled({ platform: 'linux', env: { HOME: path.join(root, 'other-home'), PATH: bin } }), true);
});

test('ignores Hermes profile markers and detects executables on macOS without writing', async () => {
  for (const marker of ['config.yaml', 'active_profile', 'profiles']) {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-darwin-detection-'));
    const home = path.join(root, 'home');
    const hermesHome = path.join(home, '.hermes');
    await mkdir(hermesHome, { recursive: true });
    if (marker === 'profiles') await mkdir(path.join(hermesHome, marker));
    else await writeFile(path.join(hermesHome, marker), marker === 'active_profile' ? 'default\n' : 'mcp_servers: {}\n');

    assert.equal(await isHermesAgentInstalled({ platform: 'darwin', env: { HOME: home, PATH: '' } }), false);
  }

  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-darwin-executable-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'hermes');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);
  assert.equal(await isHermesAgentInstalled({ platform: 'darwin', env: { HOME: path.join(root, 'home'), PATH: bin } }), true);
});

test('detects only supported clients whose executables are on PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-client-detection-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  for (const client of ['codex', 'claude']) {
    const executable = path.join(bin, client);
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);
  }

  assert.deepEqual(await detectInstalledClients({ platform: 'linux', env: { PATH: bin } }), ['codex', 'claude']);
});

test('client detection propagates unexpected filesystem failures', async () => {
  const sentinel = Object.assign(new Error('programmer-bug-sentinel'), { code: 'EIO' });
  await assert.rejects(
    detectInstalledClients({ platform: 'linux', env: { PATH: '/bounded/bin' } }, {
      stat: async () => { throw sentinel; },
    }),
    (error: unknown) => error === sentinel,
  );
});
