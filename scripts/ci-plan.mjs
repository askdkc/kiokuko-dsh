// A small, conservative ownership map. Unknown inputs select the complete CI
// inventory; this schedules existing checks and never invents weaker variants.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, sourceDigest, partitionPlans, partitionPlan, verificationPlan } from './verification-contract.mjs';

export const ciPlatforms = Object.freeze({
  'linux-x64': { runner: 'ubuntu-24.04', platform: 'linux', architecture: 'x64' },
  'linux-arm64': { runner: 'ubuntu-24.04-arm', platform: 'linux', architecture: 'arm64' },
  'darwin-arm64': { runner: 'macos-15', platform: 'darwin', architecture: 'arm64' },
});
export const ciToolchain = Object.freeze({ node: 'v24.16.0', npm: '11.13.0', rust: 'rustc 1.85.0 (4d91de4e4 2025-02-17)' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ordinaryRoots = /^(?:src\/(?:akinator|context|deep-thinker|diff-review|embedding|enno-oduno|ledger|memory|model-tools)\/|src\/dsh\/(?:answer-review|coding-workflow|decisions|model-auto|models|observation-pack|orchestration|semantic-compaction|typesafe)\/)/;
const ordinaryFiles = /^src\/dsh\/(?:agenticreplay-|answer-|context-|continuity-|correction-|enno-|execution-|intake-|memory-|request-|session-|task-|tool-|turn-)[^/]+\.ts$/;
const shared = /^(?:src\/(?:config|db|repository|security|serialization|skills)\/|src\/(?:index|errors)\.ts$|src\/dsh\/(?:core\/|modules\/|generated\/|(?:composition|index|core-runtime|runtime|database|tools|commands|config|task-authority-context|lisp-tool-identity)\.ts$))/;
const fullInputs = /^(?:\.github\/|scripts\/|tests\/|skills\/|migrations\/|dsh\/|docs\/guardrail-licenses\/)|(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|Cargo\.(?:toml|lock)|tsconfig[^/]*\.json|\.npmrc)$/;
const ui = /^src\/(?:client|models-client)\.ts$|^src\/dsh\/(?:model-selection-ui|session-log-surface|diff-review-surface)\.ts$/;
const native = /^(?:crates\/|lisp\/|guardrail\/|micro-judge\/|src\/dsh\/(?:lisp\/|host-adapter\/|native-[^/]+\.ts$|lisp-[^/]+\.ts$|[^/]*host[^/]*\.ts$|(?:host-adapter|owned-execution|paths|startup-recovery)\.ts$))/;

export function selectChanges(request) {
  const changes = request.changes;
  const full = reason => ({ mode: 'full', reason, browser: true, platforms: Object.keys(ciPlatforms) });
  if (request.full) return full('manual, release, tag, or explicit complete coverage');
  if (!request.available || !Array.isArray(changes) || !changes.length) return full('diff is unavailable or empty');
  let browser = false, application = false;
  const platforms = new Set(['linux-x64']);
  for (const entry of changes) {
    const file = entry?.path;
    if (!['A', 'M'].includes(entry?.status) || typeof file !== 'string' || file.length > 1024
      || /[\x00-\x1f\\]/.test(file) || file.startsWith('/') || file.split('/').includes('..')) return full('rename, deletion, or ambiguous path/status');
    if (fullInputs.test(file) || shared.test(file) || /\/(?:types|contracts|shared|utils)\.[cm]?tsx?$/.test(file)) return full('dependency, build, runtime asset, test contract, or shared input');
    if (/^(?:docs\/.+\.md|README(?:\.[\w-]+)?\.md|CHANGELOG\.md)$/.test(file)) continue;
    if (ui.test(file)) { browser = true; application = true; continue; }
    if (native.test(file)) {
      application = true;
      const affected = /(?:darwin|macos)/.test(file) ? ['darwin-arm64'] : /linux/.test(file)
        ? ['linux-x64', 'linux-arm64'] : Object.keys(ciPlatforms);
      affected.forEach(key => platforms.add(key)); continue;
    }
    if ((ordinaryRoots.test(file) || ordinaryFiles.test(file)) && file.endsWith('.ts')) { application = true; continue; }
    return full('unowned or ambiguous input');
  }
  return application ? { mode: 'representative', reason: 'known affected application/host ownership', browser, platforms: [...platforms].sort() }
    : { mode: 'docs', reason: 'prose-only documentation', browser: false, platforms: [] };
}

export function lanePlan(contract, selection, id) {
  const lane = selection.lanes.find(lane => lane.id === id);
  assert.ok(lane, `Unknown selected lane: ${id}`);
  const checks = new Map();
  for (const selector of lane.selectors) {
    const plan = selector.partition ? partitionPlan(contract, selector.profile, selector.partition, lane.platform)
      : verificationPlan(contract, selector.profile, lane.platform);
    for (const check of plan.checks) {
      if (checks.has(check.id)) assert.ok(same(checks.get(check.id), check), `Conflicting check ownership: ${check.id}`);
      else checks.set(check.id, check);
    }
  }
  assert.ok(checks.size > 0);
  assert.ok([...checks.values()].every(check => (check.dependsOn ?? []).every(id => checks.has(id))), 'Missing selected dependency');
  if (selection.bundleScope !== 'release-review') assert.ok(!checks.has('pack-check'), 'Complete package acceptance needs all native targets');
  return { schema: 'verification-plan-v1', package: contract.package, profile: 'ci-selected', partition: id,
    platform: lane.platform, completeScope: false, checks: [...checks.values()] };
}

export function createCiPlan(contract, request, identity) {
  const chosen = selectChanges(request), lanes = [];
  if(identity.validationPlatform) {
    assert.notEqual(chosen.mode, 'full', 'Local validation cannot claim a complete release bundle');
    chosen.platforms = [...new Set(chosen.platforms.map(key => key === 'linux-x64' ? identity.validationPlatform : key))].sort();
  }
  const baseline = identity.validationPlatform ?? 'linux-x64';
  const select = (profile, partition) => ({ profile, ...(partition ? { partition } : {}) });
  const add = (id, key, selectors, release = false) => lanes.push({ id, key, ...ciPlatforms[key], selectors, release });
  if (chosen.mode === 'full') {
    for (const plan of partitionPlans(contract, 'ci-main', 'linux')) add(`main-${plan.partition}`, 'linux-x64', [select('ci-main', plan.partition)], plan.partition === 'consumers');
    for (const key of Object.keys(ciPlatforms)) {
      for (const plan of partitionPlans(contract, 'lisp', ciPlatforms[key].platform)) {
        add(`lisp-${key}-${plan.partition}`, key, [select('lisp', plan.partition)]);
        if(key === 'darwin-arm64') lanes.at(-1).runner = 'macos-latest';
      }
      add(`semantic-${key}`, key, [select('semantic')]);
    }
    add('runtime-darwin-arm64', 'darwin-arm64', [select('runtime')]);
    add('browser', 'linux-x64', [select('browser')]);
  } else if (chosen.mode === 'representative') {
    add(`core-${baseline}`, baseline, [select('ci-main', 'unit-evaluations'), select('ci-main', 'integration'), select('lisp', 'native')]);
    add(`consumer-${baseline}`, baseline, [select('runtime')]);
    for (const key of chosen.platforms.filter(key => key !== baseline))
      add(`host-${key}`, key, [select('lisp', 'native'), select('semantic'), select('runtime')]);
    if (chosen.browser) add('browser', 'linux-x64', [select('browser')]);
  }
  const result = { schema: 'selected-ci-v1', request, ...chosen, identity,
    bundleScope: identity.validationPlatform ? 'local-validation' : chosen.mode === 'full' ? 'release-review' : 'representative',
    nativeTargets: chosen.platforms.map(key => ({ key, ...ciPlatforms[key] })), lanes };
  for (const lane of lanes) {
    const checks = lanePlan(contract, result, lane.id).checks;
    lane.fixture = checks.some(check => check.requires?.includes('dsh-native'));
    lane.sbcl = checks.some(check => check.requires?.includes('sbcl'));
    lane.browser = lane.selectors.some(selector => selector.profile === 'browser');
    lane.pnpm = checks.some(check => check.requires?.includes('pnpm')) || lane.browser;
    lane.pnpmVersion = lane.browser ? '11.24.0' : '11.7.0';
    lane.timeout = chosen.mode === 'representative' && (lane.id.startsWith('core-') || lane.id.startsWith('host-')) ? 40
      : lane.selectors.some(selector => selector.profile === 'lisp' && selector.partition === 'native') ? 25
      : lane.selectors.every(selector => selector.profile === 'semantic') ? 15 : 20;
  }
  result.jobCount = 2 + result.nativeTargets.length + lanes.length;
  result.digest = digest(JSON.stringify(result));
  return result;
}

export function validateCiPlan(contract, selection, identity) {
  if (!selection || selection.schema !== 'selected-ci-v1') return false;
  try { return same(selection, createCiPlan(contract, selection.request, identity)); }
  catch { return false; }
}
export function checkoutIdentity(root, validationPlatform) {
  const toolchain = { ...ciToolchain, node: process.version, npm: execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim() };
  if(validationPlatform) {
    assert.notEqual(process.env.GITHUB_ACTIONS, 'true', 'Local validation plans cannot be used by GitHub CI');
    assert.equal(validationPlatform, `${process.platform}-${process.arch}`, 'Local validation host mismatch');
    toolchain.rust = execFileSync('rustc', ['--version'], {cwd:root,encoding:'utf8'}).trim();
  }
  if (process.env.GITHUB_ACTIONS === 'true') assert.deepEqual(toolchain, ciToolchain, 'CI toolchain mismatch');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDigest: sourceDigest(root, { nativeTransport: false }),
    contractDigest: digest(readFileSync(path.join(root, 'scripts/verification.json'))), toolchain, ...(validationPlatform ? {validationPlatform} : {}) };
}
export function readCiPlan(root, file) {
  const selection = JSON.parse(readFileSync(file, 'utf8'));
  const contract = JSON.parse(readFileSync(path.join(root, 'scripts/verification.json')));
  assert.ok(validateCiPlan(contract, selection, checkoutIdentity(root, selection.identity?.validationPlatform)), 'Selected CI plan is stale, altered, or belongs to another source/contract');
  assert.equal(process.version, selection.identity.toolchain.node, 'Selected Node toolchain mismatch');
  assert.equal(execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(), selection.identity.toolchain.npm, 'Selected npm toolchain mismatch');
  return selection;
}
export function nativeSelection(selection, entry) {
  assert.ok(selection.nativeTargets.some(target => target.key === `${entry.platform}-${entry.arch}`), 'Unselected native target');
  assert.equal(entry.compiler, selection.identity.toolchain.rust, 'Selected Rust toolchain mismatch');
  return { schema: 'selected-native-v1', planDigest: selection.digest, identity: selection.identity,
    bundleScope: selection.bundleScope, key: `${entry.platform}-${entry.arch}`, binarySha256: entry.sha256, compiler: entry.compiler };
}

export function readChangedFiles(root, event, git = args => execFileSync('git', args, {cwd:root,encoding:'utf8'})) {
  try {
    const base = event.pull_request?.base?.sha ?? event.before;
    if (typeof base !== 'string' || !/^[0-9a-f]{40}$/.test(base) || /^0+$/.test(base)) return { available: false, changes: [] };
    const ancestor = event.pull_request ? git(['merge-base', base, 'HEAD']).trim() : base;
    if(!event.pull_request) git(['cat-file', '-e', `${base}^{commit}`]);
    const fields = git(['diff', '--name-status', '-z', '--find-renames', ancestor, 'HEAD']).split('\0');
    const changes = [];
    for (let i = 0; i < fields.length - 1;) {
      const status = fields[i++], file = fields[i++]; changes.push({ status, path: file });
      if (/^[RC]/.test(status)) i++;
    }
    return { available: true, changes, base: ancestor };
  } catch { return { available: false, changes: [] }; }
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(import.meta.dirname, '..'), output = process.argv[2];
  assert.ok(output, 'Usage: ci-plan.mjs output.json');
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)) : {};
  const request = { ...readChangedFiles(root, event), full: ['workflow_dispatch', 'release'].includes(process.env.GITHUB_EVENT_NAME)
    || String(process.env.GITHUB_REF ?? '').startsWith('refs/tags/') };
  execFileSync('git', request.base ? ['diff', '--check', request.base, 'HEAD'] : ['diff', '--check'], { cwd: root, stdio: 'inherit' });
  const selection = createCiPlan(JSON.parse(readFileSync(path.join(root, 'scripts/verification.json'))), request, checkoutIdentity(root));
  assert.equal(process.version, ciToolchain.node); assert.equal(execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), ciToolchain.npm);
  writeFileSync(output, JSON.stringify(selection, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `native=${JSON.stringify(selection.nativeTargets)}\nlanes=${JSON.stringify(selection.lanes)}\nhas_native=${selection.nativeTargets.length > 0}\nhas_lanes=${selection.lanes.length > 0}\nfull=${selection.mode === 'full'}\n`);
  console.log(JSON.stringify({ mode: selection.mode, reason: selection.reason, jobs: selection.jobCount, native: selection.nativeTargets.map(x => x.key), lanes: selection.lanes.map(x => x.id), digest: selection.digest }));
}
