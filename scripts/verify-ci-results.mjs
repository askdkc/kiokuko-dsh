import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, sourceDigest } from './verification-contract.mjs';
import { readCiPlan, lanePlan, validateCiPlan, nativeSelection } from './ci-plan.mjs';
import { sourceDigest as nativeSourceDigest, validateNativeArtifact } from './micro-judge-artifacts.mjs';

export const requiredJobs = ['select', 'micro-judge-native', 'checks'];
export function requiredJobsSucceeded(needs, selection) {
  if (!Array.isArray(selection?.lanes) || !Array.isArray(selection?.nativeTargets) || !needs || Object.keys(needs).length !== requiredJobs.length) return false;
  return requiredJobs.every(id => needs[id]?.result === (id === 'select' ||
    (id === 'checks' ? selection.lanes.length : selection.nativeTargets.length) > 0 ? 'success' : 'skipped'));
}
const key = report => [report.profile, report.partition, report.platform, report.architecture].join('/');
// Diagnostics precede the job gate: a failed matrix still publishes its report.
// Keep validation below authoritative; diagnostics must never make a run pass.
function reportCiFailures(needs, selection, directory) {
  for (const id of requiredJobs) {
    const expected = id === 'select' || (id === 'checks' ? selection.lanes.length : selection.nativeTargets.length) > 0 ? 'success' : 'skipped';
    const actual = needs?.[id]?.result || (needs?.[id] ? 'unknown' : 'missing');
    if (actual !== expected) console.error(`job ${id}: ${actual} (expected ${expected})`);
  }
  const reports = [];
  for (const item of existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []) {
    if (!item.isDirectory()) continue;
    const file = path.join(directory, item.name, 'result.json');
    try { reports.push({ file, report: JSON.parse(readFileSync(file, 'utf8')) }); }
    catch { console.error(`CI report missing or unreadable: ${file}`); }
  }
  for (const lane of selection.lanes) {
    const entries = reports.filter(({ report }) => report && key(report) === key({ ...lane, profile: 'ci-selected', partition: lane.id }));
    if (!entries.length) console.error(`lane ${lane.id}: missing report`);
    for (const { file, report } of entries) {
      if (report.status !== 'passed') console.error(`lane ${lane.id}: ${report.status}; report=${file}`);
      for (const check of Array.isArray(report.checks) ? report.checks : []) {
        if (['passed', 'scope-excluded', 'platform-excluded'].includes(check.status)) continue;
        console.error(`lane ${lane.id}: check ${check.id}: ${check.status}; exitCode=${check.exitCode ?? 'unknown'}; report=${file}`);
        // Node's structured reporter keeps test names without arbitrary stdout.
        if (!/^[a-zA-Z0-9_-]+$/.test(check.id)) continue;
        console.error(`check log: ${path.join(path.dirname(file), `${check.id}.log`)}`);
        for (const name of Array.isArray(check.reportFiles) ? check.reportFiles : []) {
          if (typeof name !== 'string' || name !== path.basename(name) || !name.endsWith('.json')) continue;
          try {
            const result = JSON.parse(readFileSync(path.join(path.dirname(file), check.id, name), 'utf8'));
            if (result.schema !== 'verification-node-v1' || !Array.isArray(result.tests)) continue;
            for (const test of result.tests.filter(test => test.type === 'test:fail'))
              console.error(`failed test: ${JSON.stringify({ file: test.file, name: test.name })}`);
          } catch { /* The report/log path above remains available for diagnosis. */ }
        }
      }
    }
  }
}
export function validateCiEvidence(contract, entries, state, selection) {
  if (!Array.isArray(entries) || !validateCiPlan(contract, selection, state?.selectionIdentity)) return false;
  const expected = selection.lanes.map(lane => ({ ...lane, ...lanePlan(contract, selection, lane.id) }));
  if (entries.length !== expected.length || new Set(entries.map(entry => key(entry.report ?? {}))).size !== expected.length) return false;
  return expected.every(plan => {
    const entry = entries.find(entry => key(entry.report ?? {}) === key(plan)), report = entry?.report;
    if (!report || report.schema !== 'verification-result-v1' || report.package !== contract.package || report.status !== 'passed'
      || report.completeScope !== false || report.completionReady !== false || report.commit !== state.commit
      || report.sourceDigest !== state.sourceDigest || report.contractDigest !== state.contractDigest || report.runtime !== state.runtime
      || report.selectionDigest !== selection.digest || report.bundleScope !== selection.bundleScope
      || !Array.isArray(report.checks) || report.checks.length !== plan.checks.length || new Set(report.checks.map(c => c.id)).size !== plan.checks.length
      || !plan.checks.every(check => report.checks.some(observed => observed.id === check.id && (observed.status === 'passed'
        || observed.status === check.status && ['scope-excluded', 'platform-excluded'].includes(check.status))))) return false;
    if (!plan.checks.some(check => check.packed)) return !report.artifact;
    const receipt = entry.artifactReceipt;
    return !!(report.artifact && entry.artifactHash === report.artifact.hash && receipt?.hash === entry.artifactHash
      && receipt.sourceDigest === state.sourceDigest && receipt.distDigest === report.artifact.distDigest
      && receipt.selectionDigest === selection.digest && receipt.bundleScope === selection.bundleScope
      && [receipt.buildExecution, receipt.packExecution].every(command => command?.exitCode === 0 && !command.timedOut && !command.signal));
  });
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const [flag, selectedFile, evidenceDirectory] = process.argv.slice(2);
    assert.ok(flag === '--ci-plan' && selectedFile && evidenceDirectory && process.argv.length === 5,
      'Usage: verify-ci-results.mjs --ci-plan selected.json report-directory');
    const root = path.resolve(import.meta.dirname, '..'), selection = readCiPlan(root, selectedFile);
    const needs = JSON.parse(process.env.NEEDS_JSON ?? 'null'), directory = path.resolve(evidenceDirectory);
    reportCiFailures(needs, selection, directory);
    assert.ok(requiredJobsSucceeded(needs, selection), 'A selected required job failed, was cancelled/skipped, or is missing');
    if (selection.nativeTargets.length) {
      const folder = path.join(root, 'micro-judge'), manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json')));
      const marker = JSON.parse(readFileSync(path.join(folder, 'selection.json')));
      assert.deepEqual(marker, { planDigest: selection.digest, identity: selection.identity, bundleScope: selection.bundleScope,
        targets: selection.nativeTargets.map(t => t.key).sort() }, 'Native bundle is not bound to this selected plan');
      assert.deepEqual(manifest.artifacts.map(e => `${e.platform}-${e.arch}`).sort(), marker.targets);
      const nativeSource = await nativeSourceDigest(root);
      for (const entry of manifest.artifacts) { await validateNativeArtifact(folder, entry, nativeSource); nativeSelection(selection, entry); }
    }
    const entries = (existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []).map(item => {
      assert.ok(item.isDirectory(), 'Unexpected CI evidence entry');
      const folder = path.join(directory, item.name), report = JSON.parse(readFileSync(path.join(folder, 'result.json')));
      if (!report.artifact) return { report };
      const archive = path.join(folder, path.basename(report.artifact.path));
      assert.ok(existsSync(archive), 'Tested archive is missing');
      return { report, artifactHash: digest(readFileSync(archive)), artifactReceipt: JSON.parse(readFileSync(path.join(folder, 'artifact.json'))) };
    });
    const bytes = readFileSync(path.join(root, 'scripts/verification.json')), contract = JSON.parse(bytes);
    const state = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDigest: sourceDigest(root),
      contractDigest: digest(bytes), runtime: process.version, selectionIdentity: selection.identity };
    assert.ok(validateCiEvidence(contract, entries, state, selection), 'Selected CI evidence is incomplete, unsuccessful, stale, or altered');
    console.log(JSON.stringify({ status: 'passed', scope: selection.mode, bundleScope: selection.bundleScope, completionReady: false,
      reports: entries.length, jobs: selection.jobCount, selectionDigest: selection.digest, notSelected: selection.mode === 'docs'
        ? ['native and executable checks: prose-only documentation'] : [], ...state }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
