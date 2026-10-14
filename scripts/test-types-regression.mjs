import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'], {encoding:'utf8', timeout:120000, maxBuffer:16*1024*1024});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error || result.signal) process.exit(2);
if (result.status !== 0) {
 const diagnostics=(result.stdout+'\n'+result.stderr).split('\n').filter(line=>/error TS/.test(line));
 const allowed = /^tests\/dsh\/unit\/(code-profile-package-version\.test\.ts|lisp\/code-intelligence-docs\.test\.ts)\(/;
 if (!diagnostics.length || diagnostics.some(line=>!allowed.test(line))) process.exit(2);
}
assert.equal(result.status, 0, 'all current source and new documentation/package regressions must typecheck');
console.log('Whole-source strict typecheck passed.');
