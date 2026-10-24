import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = realpathSync(process.argv[2] ?? process.cwd())
const fixture = join(root, 'tests/fixtures/dsh-runtime')
const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(fixture, 'node_modules')
const metadata = JSON.parse(readFileSync(join(packageRoot, '@deepseek-ai/dsh/package.json'), 'utf8'))
const preload = join(root, 'tests/dsh/helpers/offline-skill-catalog.mjs')
const pattern = '^real DSH agent loop: persisted resume, verification retry, completion \\((text|default_resume)\\)$'
const args = ['--import', preload, '--import', 'tsx', '--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, 'tests/dsh/e2e/native-agent-loop.test.ts']
const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  KIOKUKO_DSH_PACKAGE_ROOT: packageRoot, KIOKUKO_REQUIRE_DSH_NATIVE: '1',
  KIOKUKO_EXPECTED_DSH_VERSION: metadata.version,
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
delete env.KIOKUKO_SKILL_PACKAGE_ROOT
console.log(JSON.stringify({ executable: process.execPath, args, root, expectedDshVersion: env.KIOKUKO_EXPECTED_DSH_VERSION }))
const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 150_000, maxBuffer: 32 * 1024 * 1024 })
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
assert.equal(result.error, undefined, 'selected native resume tests must finish')
assert.equal(result.signal, null, 'selected native resume tests must not be killed')
assert.equal(result.status, 0, 'the exact cold persisted task must reach verified native completion')
for (const [name, count] of [['tests', 2], ['pass', 2], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
  const match = result.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))
  assert.ok(match, `missing TAP ${name} counter`); assert.equal(Number(match[1]), count, `unexpected ${name} count`)
}
