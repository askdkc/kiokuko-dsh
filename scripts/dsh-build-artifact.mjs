// Transfer compiled upstream outputs, not a runner's node_modules or credentials.
// Consumers install the unchanged frozen graph, then restore this exact build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { upstreamIdentity } from './stage-dsh-upstream.mjs';
import { readCiPlan } from './ci-plan.mjs';

const omitted = new Set(['.git', 'node_modules', '.pnpm-store', '.cache']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveName = 'dsh-build.tar.gz';

function buildIdentity(sourceRoot, selection) {
  const identity = upstreamIdentity(sourceRoot, selection.request.dshSha);
  assert.ok(selection.dshTargets?.some(target => target.key === `${process.platform}-${process.arch}`), 'Unselected DSH build platform');
  assert.equal(process.version, selection.identity.toolchain.node, 'DSH build Node version differs from selected toolchain');
  const manifest = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.match(manifest.packageManager ?? '', /^pnpm@\d/, 'Official DSH must declare its package manager');
  return { schema: 'dsh-build-artifact-v1', selectionDigest: selection.digest,
    repository: identity.repository, sha: identity.sha, version: identity.version,
    platform: process.platform, architecture: process.arch, node: process.version, abi: process.versions.modules,
    packageManager: manifest.packageManager, lockHash: hash(readFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'))) };
}

function assertBuildEntries(root) {
  for (const entry of ['apps/cli/lib/bin.js', 'packages/core/agent-loop/lib/index.js', 'packages/core/tools/lib/index.js'])
    assert.ok(existsSync(path.join(root, entry)), `Missing compiled DSH entry: ${entry}`);
}

// Official source/build files may contain relative links, but no runner-local
// symlinks, sockets, device nodes, or credential files belong in this transport.
function assertPortableTree(root, relative = '') {
  for (const name of readdirSync(path.join(root, relative))) {
    if (omitted.has(name)) continue;
    assert.ok(!/[\x00-\x1f]/.test(name), 'Invalid DSH artifact path');
    assert.ok(name.endsWith('.example') || !/^\.env(?:\.|$)|\.(?:p12|pfx|pem|key)$/.test(name), 'Credential-shaped file in DSH build');
    const file = path.join(relative, name), absolute = path.join(root, file), stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(absolute), target = path.resolve(path.dirname(absolute), link);
      assert.ok(!path.isAbsolute(link) && target.startsWith(root + path.sep), 'DSH artifact link escapes its checkout');
    } else if (stat.isDirectory()) assertPortableTree(root, file);
    else assert.ok(stat.isFile(), 'Unsupported DSH artifact entry');
  }
}

export function packBuiltDsh(sourceRoot, artifactRoot, selection) {
  const root = realpathSync(sourceRoot), output = path.resolve(artifactRoot);
  assert.ok(output !== root && !output.startsWith(root + path.sep), 'DSH artifact output must be outside its source');
  const identity = buildIdentity(root, selection);
  assertBuildEntries(root);
  assertPortableTree(root);
  mkdirSync(output, { recursive: true });
  const archive = path.join(output, archiveName);
  execFileSync('tar', ['-czf', archive, ...[...omitted].map(name => `--exclude=${name}`), '-C', root, '.'], { stdio: 'inherit' });
  const receipt = { ...identity, archive: archiveName, archiveHash: hash(readFileSync(archive)) };
  writeFileSync(path.join(output, 'dsh-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export function restoreBuiltDsh(sourceRoot, artifactRoot, selection) {
  const root = realpathSync(sourceRoot), expected = buildIdentity(root, selection);
  const receipt = JSON.parse(readFileSync(path.join(artifactRoot, 'dsh-build.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) assert.equal(receipt[key], value, `DSH build identity mismatch: ${key}`);
  assert.equal(receipt.archive, archiveName, 'Unexpected DSH archive name');
  const archive = path.resolve(artifactRoot, archiveName);
  assert.equal(hash(readFileSync(archive)), receipt.archiveHash, 'DSH build archive hash mismatch');
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
  assert.ok(members.length > 1, 'Empty DSH build archive');
  for (const member of members) {
    const parts = member.replace(/^\.\//, '').split('/');
    assert.ok(!path.isAbsolute(member) && !parts.some(part => part === '..' || omitted.has(part)), 'Unsafe DSH archive member');
  }
  assertPortableTree(root);
  execFileSync('tar', ['-xzf', archive, '--no-same-owner', '-C', root], { stdio: 'inherit' });
  assertPortableTree(root);
  // The archive must not alter the selected tracked source or frozen lockfile.
  assert.deepEqual(buildIdentity(root, selection), expected);
  assertBuildEntries(root);
  return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [operation, source, artifacts, plan] = process.argv.slice(2);
  assert.ok(['pack', 'restore'].includes(operation) && source && artifacts && plan && process.argv.length === 6,
    'Usage: dsh-build-artifact.mjs pack|restore SOURCE ARTIFACT_DIRECTORY SELECTED_PLAN');
  const selection = readCiPlan(path.resolve(import.meta.dirname, '..'), plan);
  const receipt = operation === 'pack' ? packBuiltDsh(source, artifacts, selection) : restoreBuiltDsh(source, artifacts, selection);
  console.log(JSON.stringify({ operation, ...receipt }));
}
