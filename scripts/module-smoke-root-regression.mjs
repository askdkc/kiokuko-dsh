import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { detectRepositoryRoot } from '../dist/repository/detect-root.js'

// This regression executes the real smoke's fixture setup, not a second copy of
// its setup logic. Keep the extraction bounded before any native host mounts.
const source = await readFile(new URL('./module-package-smoke.mjs', import.meta.url), 'utf8')
const start = source.indexOf('const directory = realpathSync(await mkdtemp(')
const end = source.indexOf('\nconst ctx = ', start)
assert.ok(start >= 0 && end > start, 'module smoke fixture setup must remain identifiable')
assert.equal(source.indexOf('const directory = realpathSync(await mkdtemp(', start + 1), -1)
const fixtureSetup = source.slice(start, end)
assert.equal(source.split(fixtureSetup).length, 2, 'the exact fixture setup block must occur once')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const createFixture = new AsyncFunction('realpathSync', 'mkdtemp', 'join', 'tmpdir', 'mkdir', 'process', 'exec', `${fixtureSetup}\nreturn directory`)
const exec = promisify(execFile)
const controlled = realpathSync(await mkdtemp(join(tmpdir(), 'module-smoke-root-regression-')))
const parentRepository = join(controlled, 'parent-repository')
const nestedTmp = join(parentRepository, 'governed-tmp')
const oldEnvironment = { ...process.env }
let completed = 0
try {
  await mkdir(nestedTmp, { recursive: true })
  await mkdir(join(controlled, 'home'))
  process.env.HOME = join(controlled, 'home')
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_COUNT']) delete process.env[key]
  await exec('git', ['init', '--quiet', parentRepository], { timeout: 15_000 })
  assert.equal(realpathSync((await exec('git', ['rev-parse', '--show-toplevel'], { cwd: nestedTmp, timeout: 15_000 })).stdout.trim()), parentRepository)
  for (const [label, location] of [['direct-parent', parentRepository], ['nested-governed-tmp', nestedTmp]]) {
    process.env.TMPDIR = location
    let directory
    try {
      directory = await createFixture(realpathSync, mkdtemp, join, tmpdir, mkdir, process, exec)
      const detected = detectRepositoryRoot({ cwd: directory, allowDirectory: true })
      console.log(JSON.stringify({ label, fixtureRoot: directory, detectedRoot: detected.root, detectedSource: detected.source,
        smokeSha256: createHash('sha256').update(source).digest('hex') }))
      assert.equal(detected.root, directory, 'module smoke fixture must retain its own repository root inside a governed ancestor repository')
      assert.equal(detected.source, 'git', 'fixture boundary must be a real Git repository, not an empty marker')
      assert.notEqual(directory, parentRepository)
      completed++
    } finally { if (directory) await rm(directory, { recursive: true, force: true }) }
  }
  assert.equal(completed, 2, 'both fresh fixture placements must be exercised')
  console.log('Module smoke root regression passed: 2 fresh fixtures, exact repository roots, no skips.')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in oldEnvironment)) delete process.env[key]
  Object.assign(process.env, oldEnvironment)
  await rm(controlled, { recursive: true, force: true })
}
