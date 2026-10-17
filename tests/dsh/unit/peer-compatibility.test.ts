import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import semver from 'semver';
const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));

test('host peers do not use release identity as an API admission rule', () => {
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const [name, range] of Object.entries(manifest.peerDependencies) as [string, string][]) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    assert.equal(range, '*', `${name} is checked by its required APIs, not a release interval`);
    for (const version of ['0.0.0', '5.0.0', '99.0.0', '99.0.0-beta.1']) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${name}: ${version}`);
    }
  }
});

test('Cordis release labels do not replace the real lifecycle contract', async () => {
  const range = manifest.peerDependencies['@deepseek-ai/cordis'];
  const { Context } = await import('@deepseek-ai/cordis');
  const { mountDshRuntime } = await import('../../../src/dsh/index.js');
  for (const version of ['0.0.0', '4.0.5-alpha.1', '5.0.0', '99.0.0-beta.1']) {
    assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, version);
    const ctx = new Context(); let starts = 0, closes = 0;
    const effect = mountDshRuntime(ctx, { start: async () => { starts++ }, close: async () => { closes++ } } as any);
    await effect; assert.equal(starts, 1);
    await ctx.fiber.dispose(); assert.equal(closes, 1, 'the host owns and drains the actual runtime');
  }
  let starts = 0;
  assert.throws(() => mountDshRuntime({ version: '4.0.5-alpha.1' } as any,
    { start: async () => { starts++ }, close: async () => {} } as any), /effect/);
  assert.equal(starts, 0, 'a familiar release label cannot start a runtime without Context.effect');
});
