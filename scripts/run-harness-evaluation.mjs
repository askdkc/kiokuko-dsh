import { completeVerification } from './verification-completion.mjs';
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { parseNodeTapSummary } from '../src/dsh/node-tap-summary.js'

const manifestBytes = await readFile(new URL('../tests/fixtures/harness/expected-manifest.json', import.meta.url))
const manifest = JSON.parse(manifestBytes)
const scenarios = manifest.scenarios.map(({id,file,name}) => [id,file,name])
if (manifest.schema !== 'harness-scenarios-v1' || !scenarios.length || new Set(scenarios.map(([id])=>id)).size !== scenarios.length) throw new Error('Invalid fixed scenario manifest')
// A fixture change is reviewed with this digest rather than silently changing
// what the mandatory offline gate measures.
if (JSON.stringify(manifest.expected) !== JSON.stringify({tests:1,passed:1,failed:0,skipped:0,todo:0})) throw new Error('Harness requires one passing, non-skipped selected test per scenario')
const root = process.cwd()
const reportPath = resolve(process.env.KIOKUKO_HARNESS_REPORT ?? '.artifacts/harness-report.json')
await rm(reportPath, { force: true })
const fixtureRoot = resolve('tests/fixtures/dsh-runtime/node_modules')
const existingRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? fixtureRoot
const fixtureAvailable = await stat(existingRoot).then(value => value.isDirectory(), () => false)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const workingTreeClean = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === ''
const fixtureDigest = createHash('sha256')
fixtureDigest.update(manifestBytes)
const packageJson = JSON.parse(await readFile('tests/fixtures/dsh-runtime/package.json', 'utf8'))
const report = { schemaVersion: 1, invocationId: randomUUID(), commit, workingTreeClean,
  nodeVersion: process.version, dshVersion: packageJson.dependencies?.['@deepseek-ai/dsh'] ?? 'unknown',
  fixtureDigest: fixtureDigest.digest('hex'), mode: 'offline-native', scenarios: [],
  summary: { expected: scenarios.length, passed: 0, failed: 0, skipped: 0 }, realModelQuality: 'unmeasured' }

async function run(file, name) {
  const started = performance.now()
  const child = spawn(process.execPath, ['--import', resolve(root, 'tests/dsh/helpers/offline-skill-catalog.mjs'), '--import', 'tsx', '--test', '--test-reporter=tap',
    `--test-name-pattern=^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, file], {
    cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(resolve(root, 'tests/dsh/helpers/offline-skill-catalog.mjs')).href}`, KIOKUKO_REQUIRE_DSH_NATIVE: '1',
      ...(fixtureAvailable ? { KIOKUKO_DSH_PACKAGE_ROOT: existingRoot } : {}) },
  })
  let output = '', timedOut = false
  for (const lane of [child.stdout, child.stderr]) lane.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000) })
  const timer = setTimeout(() => {
    timedOut = true
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* exit may have won */ }
  }, 90_000)
  const exitCode = await new Promise(resolve => child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)))
  clearTimeout(timer)
  const observed = parseNodeTapSummary(output)
  const status = !timedOut && exitCode === 0 && observed?.tests === manifest.expected.tests && observed.pass === manifest.expected.passed
    && observed.fail === manifest.expected.failed && observed.skipped === manifest.expected.skipped && observed.todo === manifest.expected.todo ? 'passed'
      : observed?.skipped ? 'skipped' : 'failed'
  return { status, expected: { test: name, tests: 1, skipped: 0 },
    observed: { exitCode, tests: observed?.tests ?? null, pass: observed?.pass ?? null,
      fail: observed?.fail ?? null, skipped: observed?.skipped ?? null },
    elapsedMs: Math.round(performance.now() - started),
    reasonCode: status === 'passed' ? null : timedOut ? 'timeout' : observed === undefined ? 'missing_tap_summary'
      : observed.skipped ? 'skipped' : exitCode !== 0 ? 'test_failed' : 'unexpected_counts' }
}

try {
    for (const [id, file, name] of scenarios) {
      const result = await run(file, name)
      report.scenarios.push({ id, ...result })
      report.summary[result.status]++
      process.stdout.write(`${result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL'} ${id}${result.reasonCode ? ` (${result.reasonCode})` : ''}\n`)
    }
} finally {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(`Harness report: ${reportPath}\n`)
}
if (report.summary.passed !== report.summary.expected || report.summary.failed || report.summary.skipped) process.exitCode = 1

completeVerification({});
