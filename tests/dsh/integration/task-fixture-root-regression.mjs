import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Freeze this file at protocol RED. It exercises the unchanged real completion
// assertions; only the existing fixture file is the implementation edit target.
const repository = realpathSync(process.argv[2] ?? process.cwd())
const controlled = realpathSync(mkdtempSync(join(tmpdir(), 'task-fixture-root-regression-')))
const parentRepository = join(controlled, 'parent-repository')
const home = join(controlled, 'home')
mkdirSync(parentRepository)
mkdirSync(home)
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  TMPDIR: parentRepository,
  TMP: parentRepository,
  TEMP: parentRepository,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
}
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_COUNT']) delete environment[key]
try {
  const initialized = spawnSync('git', ['init', '--quiet', parentRepository], {
    cwd: controlled, env: environment, encoding: 'utf8', timeout: 15_000,
  })
  assert.equal(initialized.error, undefined, 'controlled repository setup must launch')
  assert.equal(initialized.status, 0, initialized.stderr)
  const detection = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: parentRepository, env: environment, encoding: 'utf8', timeout: 15_000,
  })
  assert.equal(detection.status, 0, detection.stderr)
  assert.equal(realpathSync(detection.stdout.trim()), parentRepository)

  const args = ['--import', 'tsx', '--test', '--test-reporter=tap',
    '--test-name-pattern=explicit completion validates actual current owned receipt provenance|Done source waits for final native answer',
    'tests/dsh/integration/task-workflow-host.test.ts']
  console.log(JSON.stringify({ repository, controlledParentRepository: parentRepository,
    executable: process.execPath, args }))
  const result = spawnSync(process.execPath, args, {
    cwd: repository, env: environment, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(result.error, undefined, 'the four real completion regressions must finish')
  assert.equal(result.signal, null, 'the regression subprocess must not be killed')
  assert.equal(result.status, 0, 'completion fixtures must keep their own root inside an ancestor repository')
  // A filtered-out, skipped, cancelled, or accidentally renamed test cannot turn
  // this regression green without exercising the four intended assertions.
  for (const [counter, expected] of [['tests', 4], ['pass', 4], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
    const found = result.stdout.match(new RegExp(`^# ${counter} (\\d+)$`, 'm'))
    assert.ok(found, `missing TAP ${counter} counter`)
    assert.equal(Number(found[1]), expected, `unexpected TAP ${counter} count`)
  }
  console.log('Fixture repository isolation regression passed: 4 real tests, no skips.')
} finally {
  rmSync(controlled, { recursive: true, force: true })
}
