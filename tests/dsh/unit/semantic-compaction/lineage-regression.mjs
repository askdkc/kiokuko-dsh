import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const args = ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-name-pattern=packing retains protected result: child|a main conversation branch remains eligible for semantic compaction', 'tests/dsh/unit/semantic-compaction/observation.test.ts', 'tests/dsh/unit/semantic-compaction/coordinator.test.ts']
const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
assert.equal(result.error, undefined); assert.equal(result.signal, null)
assert.equal(result.status, 0, 'main lineage and actual subagent must remain distinct')
for (const [key, value] of [['tests', 2], ['pass', 2], ['fail', 0], ['cancelled', 0], ['skipped', 0]]) {
 const found = result.stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))
 assert.ok(found); assert.equal(Number(found[1]), value)
}
