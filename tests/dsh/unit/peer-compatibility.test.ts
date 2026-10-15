import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import semver from 'semver';
const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));

test('published peers have supported minimums and lock metadata agrees', () => {
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  for (const [name, range] of Object.entries(manifest.peerDependencies) as [string, string][]) {
    assert.equal(semver.valid(range), null, `${name} must not pin consumers to one version`);
    const minimum = semver.minVersion(range);
    assert.ok(minimum, `${name} must have a supported minimum`);
    assert.equal(semver.satisfies(minimum, range, {includePrerelease:true}), true);
    if (name.startsWith('@deepseek-ai/dsh-')) {
      // A future release label is eligible until an actual incompatibility is established.
      assert.equal(semver.satisfies('0.3.0', range), true, `${name} allows a future stable release`);
    } else {
      const breaking = minimum.major ? `${minimum.major + 1}.0.0-0` : `0.${minimum.minor + 1}.0-0`;
      assert.equal(semver.satisfies(breaking, range, {includePrerelease:true}), false, `${name} rejects a breaking prerelease`);
      assert.equal(semver.satisfies('99.0.0', range), false);
    }
  }
});

test('DSH peer ranges cover tested releases without an unproven future ceiling', () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies) as [string,string][]) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    for (const version of ['0.2.1-alpha.2','0.2.1-alpha.3','0.2.1','0.2.2']) {
      assert.equal(semver.satisfies(version, range), true, `${name} npm ${version}`);
      assert.equal(semver.satisfies(version, range, {includePrerelease:true}), true, `${name} boot ${version}`);
    }
    for (const version of ['0.1.9','0.2.0','0.2.1-alpha.1']) {
      assert.equal(semver.satisfies(version, range), false, `${name} npm ${version}`);
      assert.equal(semver.satisfies(version, range, {includePrerelease:true}), false, `${name} boot ${version}`);
    }
    for (const version of ['0.3.0','1.0.0']) {
      assert.equal(semver.satisfies(version, range), true, `${name} npm ${version}`);
      assert.equal(semver.satisfies(version, range, {includePrerelease:true}), true, `${name} boot ${version}`);
    }
    // npm excludes a new prerelease tuple by default; native boot explicitly includes it.
    // Range eligibility does not prove that a future release's API works.
    for (const version of ['0.2.2-alpha.1', '0.3.0-alpha.1']) {
      assert.equal(semver.satisfies(version, range), false, `${name} npm ${version}`);
      assert.equal(semver.satisfies(version, range, {includePrerelease:true}), true, `${name} boot ${version}`);
    }
  }
});
