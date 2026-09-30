import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
test('four paired evaluation arms remain unmeasured and never communicate without config', () => {
    const script = pathToFileURL(join(process.cwd(), 'scripts/run-index-reasoning-evaluation.mjs')).href;
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `globalThis.fetch=()=>{throw new Error('offline network forbidden')};await import(${JSON.stringify(script)})`], { encoding: 'utf8', timeout: 30000 });
    const report = JSON.parse(stdout);
    assert.equal(report.status, 'unmeasured');
    assert.equal(report.qualityMetrics, null);
    assert.equal(report.model, null);
    assert.equal(report.trials.length, 16);
    assert.deepEqual(Object.keys(report.deliveryMetrics), ['current', 'atomic', 'atomic+bridge', 'bridge-metadata-only']);
    assert.ok(report.generation.every((row: any) => row.calls === 3 && row.inputTokens === null && row.outputTokens === null));
});
