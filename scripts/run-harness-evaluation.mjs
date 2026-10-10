import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { parseNodeTapSummary } from '../src/dsh/node-tap-summary.js'

const scenarios = [
  ['normal-unmet', 'tests/dsh/integration/task-completion-lifecycle.test.ts', 'normal enforce keeps the run open until every approved condition has fresh host evidence'],
  ['enno-unmet', 'tests/dsh/integration/final-verification/repository-mutation.test.ts', 'opted-in Enno acceptance requires a pre-bound fresh verifier for every criterion'],
  ['required-skip', 'tests/dsh/integration/final-verification/repository-mutation.test.ts', 'opted-in Enno selected-test criterion rejects an exit-zero run with a skipped required test'],
  ['normal-selected-skip', 'tests/dsh/unit/task-completion.test.ts', 'a selected skipped test is unmet while an unsupported or incomplete output is unknown'],
  ['post-accept-edit', 'tests/dsh/integration/final-verification/repository-mutation.test.ts', 'an external edit after acceptance returns meditation to verification'],
  ['cold-start-policy', 'tests/dsh/unit/execution-support.test.ts', 'cold-start policy read failure blocks structured file operations until the saved frame is restored'],
  ['never-settling-flush', 'tests/dsh/integration/boundary-worker.test.ts', 'an unresponsive native flush times out without dispatch or an overlapping retry'],
  ['dispatch-replay', 'tests/dsh/integration/boundary-worker.test.ts', 'dispatch-before-observed crash survives worker restart with the same deterministic delivery id'],
  ['compacted-context', 'tests/dsh/integration/context-projection.test.ts', 'compaction and restart reinstate only fragments missing from the retained surface'],
  ['context-provenance', 'tests/dsh/unit/agenticreplay-request-manifest.test.ts', 'AgenticReplay metadata records current host section digests without source text or a forged user section'],
  ['native-resume', 'tests/dsh/e2e/native-agent-loop.test.ts', 'real DSH agent loop: persisted resume, verification retry, completion (text)'],
  ['native-default-resume', 'tests/dsh/e2e/native-agent-loop.test.ts', 'real DSH agent loop: persisted resume, verification retry, completion (default_resume)'],
]
// A fixture change is reviewed with this digest rather than silently changing
// what the mandatory offline gate measures.
const EXPECTED_FIXTURE_DIGEST = 'd9dcc13bab74cc48f3d5ac5f8087de7a2f8ae71d210d6d95335934f1870c1308'
const root = process.cwd()
const reportPath = resolve(process.env.KIOKUKO_HARNESS_REPORT ?? '.artifacts/harness-report.json')
await rm(reportPath, { force: true })
const fixtureRoot = resolve('tests/fixtures/dsh-runtime/node_modules')
const existingRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? fixtureRoot
const fixtureAvailable = await stat(existingRoot).then(value => value.isDirectory(), () => false)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const workingTreeClean = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === ''
const fixtureDigest = createHash('sha256')
for (const file of [...new Set(scenarios.map(([, file]) => file))]) fixtureDigest.update(file).update(await readFile(file))
const packageJson = JSON.parse(await readFile('tests/fixtures/dsh-runtime/package.json', 'utf8'))
const report = { schemaVersion: 1, invocationId: randomUUID(), commit, workingTreeClean,
  nodeVersion: process.version, dshVersion: packageJson.dependencies?.['@deepseek-ai/dsh-agent'] ?? 'unknown',
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
  const status = !timedOut && exitCode === 0 && observed?.tests === 1 && observed.pass === 1
    && observed.fail === 0 && observed.skipped === 0 && observed.todo === 0 ? 'passed'
      : observed?.skipped ? 'skipped' : 'failed'
  return { status, expected: { test: name, tests: 1, skipped: 0 },
    observed: { exitCode, tests: observed?.tests ?? null, pass: observed?.pass ?? null,
      fail: observed?.fail ?? null, skipped: observed?.skipped ?? null },
    elapsedMs: Math.round(performance.now() - started),
    reasonCode: status === 'passed' ? null : timedOut ? 'timeout' : observed === undefined ? 'missing_tap_summary'
      : observed.skipped ? 'skipped' : exitCode !== 0 ? 'test_failed' : 'unexpected_counts' }
}

try {
  if (report.fixtureDigest !== EXPECTED_FIXTURE_DIGEST) {
    for (const [id, , name] of scenarios) report.scenarios.push({ id, status: 'failed', expected: { test: name },
      observed: {}, elapsedMs: 0, reasonCode: 'fixture_digest_mismatch' })
    report.summary.failed = scenarios.length
    process.stderr.write('Harness fixture digest changed; review the fixed scenarios and update the expected digest.\n')
  } else {
    for (const [id, file, name] of scenarios) {
      const result = await run(file, name)
      report.scenarios.push({ id, ...result })
      report.summary[result.status]++
      process.stdout.write(`${result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL'} ${id}${result.reasonCode ? ` (${result.reasonCode})` : ''}\n`)
    }
  }
} finally {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(`Harness report: ${reportPath}\n`)
}
if (report.summary.passed !== report.summary.expected || report.summary.failed || report.summary.skipped) process.exitCode = 1
