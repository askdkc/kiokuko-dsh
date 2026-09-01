import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const launcherPath = path.join(repositoryRoot, '.codex', 'kiokuko-dev-mcp.mjs');
const testRulesPath = path.join(repositoryRoot, '.codex', 'rules', 'kiokuko-tests.rules');

test('tracked Codex test rules cover focused and full listener-dependent entry points', async () => {
  const rules = await readFile(testRulesPath, 'utf8');
  assert.match(rules, /pattern = \["node", "scripts\/run-tests\.mjs"\]/u);
  assert.match(rules, /pattern = \["npm", "test"\]/u);
  assert.match(rules, /pattern = \["npm", "run", "prepublishOnly"\]/u);
  assert.doesNotMatch(rules, /pattern = \["node"\]/u);
  assert.doesNotMatch(rules, /pattern = \["npm"\]/u);
});

test('Codex development launcher resolves the sample database from its clone', async () => {
  const launcher = await import(pathToFileURL(launcherPath).href) as {
    resolveSampleDatabasePath(moduleUrl?: string | URL): string;
  };
  const cloneRoot = path.join(path.parse(repositoryRoot).root, 'portable-clone', 'kiokuko');
  const cloneLauncher = pathToFileURL(path.join(cloneRoot, '.codex', 'kiokuko-dev-mcp.mjs'));
  assert.equal(
    launcher.resolveSampleDatabasePath(cloneLauncher),
    path.join(cloneRoot, 'tests', 'sampledb', 'kiokuko.sqlite3'),
  );
});

test('Codex development launcher tests against a disposable copy of the sample database', async () => {
  const launcher = await import(pathToFileURL(launcherPath).href) as {
    createDevelopmentDatabaseCopy(moduleUrl?: string | URL): Promise<{
      dataDirectory: string;
      databasePath: string;
      remove(): Promise<void>;
    }>;
    resolveSampleDatabasePath(moduleUrl?: string | URL): string;
  };
  const sourcePath = launcher.resolveSampleDatabasePath();
  const sourceBefore = await readFile(sourcePath);
  const databaseCopy = await launcher.createDevelopmentDatabaseCopy();
  try {
    assert.notEqual(databaseCopy.databasePath, sourcePath);
    assert.deepEqual(await readFile(databaseCopy.databasePath), sourceBefore);
    await writeFile(databaseCopy.databasePath, 'modified disposable copy');
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
  } finally {
    await databaseCopy.remove();
  }
  await assert.rejects(access(databaseCopy.dataDirectory));
});
