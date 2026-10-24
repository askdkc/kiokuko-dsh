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
const cases = [
  { path: 'tests/dsh/e2e/execution-support-loop.test.ts', count: 2,
    pattern: '^real DSH (research|writing): chat, scoped read, pause, other session, unload/reload, human resume and visible completion$' },
  { path: 'tests/dsh/e2e/model-routing-loop.test.ts', count: 4,
    pattern: '^(native eager compatibility: input recovery tolerates late-request(?:-and-update)? failure without interrupting or replaying executed work|native modular core applies model-auto to its first prepared prompt and request|native code normal execution: cancel, plugin reload, original input recovery, write, verification and fresh next-task choice)$' },
]
const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  KIOKUKO_DSH_PACKAGE_ROOT: packageRoot, KIOKUKO_REQUIRE_DSH_NATIVE: '1',
  KIOKUKO_EXPECTED_DSH_VERSION: metadata.version,
  NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
delete env.KIOKUKO_SKILL_PACKAGE_ROOT
const failures = []
for (const selected of cases) {
  const args = ['--import', preload, '--import', 'tsx', '--test', '--test-reporter=tap', `--test-name-pattern=${selected.pattern}`, selected.path]
  console.log(JSON.stringify({ executable: process.execPath, args, root, expectedDshVersion: env.KIOKUKO_EXPECTED_DSH_VERSION }))
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 150_000, maxBuffer: 32 * 1024 * 1024 })
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
  assert.equal(result.error, undefined, 'selected native ownership tests must finish')
  assert.equal(result.signal, null, 'selected native ownership tests must not be killed')
  const counters = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => {
    const match = result.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))
    assert.ok(match, `missing TAP ${name} counter`)
    return [name, Number(match[1])]
  }))
  assert.equal(counters.tests, selected.count, 'every selected ownership case must actually run')
  for (const name of ['cancelled', 'skipped', 'todo']) assert.equal(counters[name], 0, `unexpected ${name}`)
  if (result.status !== 0 || counters.pass !== selected.count || counters.fail !== 0) failures.push({ path: selected.path, status: result.status, counters })
}
assert.deepEqual(failures, [], 'native continuation fixtures provide current source-bound interpretation and task-operation choices; eager/core behavior remains intact')
