import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reasonSummary } from './verification-diagnostics.mjs';

// CI preparation only. Never turn a dependency/lifecycle failure into success.
const [directory, reportFile] = process.argv.slice(2);
if (!directory || !reportFile || process.argv.length !== 4)
  throw new Error('Usage: ci-install.mjs package-directory report.json');
mkdirSync(path.dirname(reportFile), { recursive: true });
const report = { schema: 'ci-install-v1', status: 'failed', attempts: [] };
for (let attempt = 1; attempt <= 2; attempt++) {
  const started = Date.now();
  const result = spawnSync('npm', ['ci', '--prefix', directory, '--prefer-offline', '--no-audit', '--no-fund',
    '--fetch-timeout=30000', '--fetch-retries=1', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000'],
  { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
  const internalExit = result.status === 1 && !result.error && !result.signal
    && /^npm error Exit handler never called!/m.test(result.stderr ?? '');
  const outcome = { attempt, exitCode: result.status, signal: result.signal,
    elapsedMs: Date.now() - started, internalExit,
    reason: reasonSummary([result.error, result.stderr]) };
  report.attempts.push(outcome);
  report.status = result.status === 0 && !result.error && !result.signal ? 'passed' : 'failed';
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(outcome));
  if (report.status === 'passed') break;
  if (!internalExit || attempt === 2) { process.exitCode = result.status || 1; break; }
  console.error('npm internal exit-handler failure; retrying locked installation once.');
}
