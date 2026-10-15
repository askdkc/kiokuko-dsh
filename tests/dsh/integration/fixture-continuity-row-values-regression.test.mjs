import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
// A narrow, frozen failure allowlist. Unknown failures are ordinary Errors.
const EXPECTED_COUNTS = {
  'deep-quality-migration.test.ts': 1, 'v4-message-sources.test.ts': 1,
  'schema-baseline.test.ts': 6, 'task-preflight-cancel.test.ts': 7,
  'bundle-install.test.ts': 7, 'queued-intent-native.test.ts': 10,
  'native-loop.test.ts': 3, 'native-adapter.test.ts': 2,
}
function blocked(reason) { throw new Error('Inner suite cannot authorize fixture changes: ' + reason) }
function equalJson(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function expectedFailure(row, kind) {
  const e = row.error ?? {}, message = String(e.message ?? ''), stack = String(e.stack ?? '')
  if (kind !== 'continuity-row-values' || row.file.split('/').at(-1) !== 'native-loop.test.ts'
    || !/^real DSH continuity (?:off|shadow|active): final requests after compaction and same-run reload$/u.test(row.name)
    || row.failureType !== 'testCodeFailure' || e.code !== 'ERR_ASSERTION' || e.operator !== 'deepStrictEqual'
    || !message.startsWith('source-bound preparation resumes the exact persisted task and clears only its resolved continuation')
    || !message.includes('[Object: null prototype]') || !/native-loop\.test\.ts:142:/u.test(stack)) return false
  if (!Array.isArray(e.actual) || !Array.isArray(e.expected) || e.actual.length !== 1 || !equalJson(e.actual, e.expected)) return false
  const value = e.expected[0]
  return Object.keys(value).sort().join(',') === 'id,status,unresolved' && typeof value.id === 'string'
    && /^[0-9a-f-]{36}$/u.test(value.id) && value.status === 'completed' && value.unresolved === null
}
function validateInnerRun(result, kind, targets) {
  if (result.timedOut || result.signal !== null || !Number.isInteger(result.code) || result.code < 0 || result.code > 125 || result.code === 124)
    blocked('abnormal exit or wrapper deadline')
  if (result.innerError) blocked(result.innerError)
  const report = result.inner
  if (report?.schema !== 'fixture-inner-events-v1' || report.complete !== true || report.summaryCount !== 1 || !Array.isArray(report.tests) || !Array.isArray(report.suites))
    blocked('missing or incomplete official test lifecycle')
  const counts = report.counts ?? {}
  for (const key of ['tests','passed','failed','cancelled','skipped','todo']) if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) blocked('invalid count: ' + key)
  if (!counts.tests || counts.tests !== report.tests.length || counts.cancelled || counts.skipped || counts.todo) blocked('empty, skipped, cancelled or todo coverage')
  if (report.suites.length) blocked('unexpected suite-level lifecycle')
  for (const target of targets) {
    const name = target.split('/').at(-1)
    const expected = name === 'fixture-contract.test.ts' ? (kind === 'historical-contract' ? 2 : kind === 'owned-stop' ? 5 : undefined) : EXPECTED_COUNTS[name]
    if (!expected || report.tests.filter(row => row.file === target).length !== expected) blocked('changed target inventory: ' + target)
  }
  if (report.tests.some(row => !targets.includes(row.file) || row.fileOnly || row.skipped || row.todo || !['test:pass','test:fail'].includes(row.type))) blocked('unexpected/file-only/skipped test entry')
  if (new Set(report.tests.map(row => row.file + ':' + row.name)).size !== report.tests.length) blocked('duplicate test identity')
  const failures = report.tests.filter(row => row.type === 'test:fail')
  if (counts.failed !== failures.length || counts.passed !== report.tests.length - failures.length || counts.passed + counts.failed !== counts.tests) blocked('inconsistent lifecycle counts')
  if ((result.code === 0) !== (failures.length === 0)) blocked('exit does not agree with lifecycle')
  // TAP stays diagnostic. Require its final aggregate to agree before reaching an assertion.
  for (const [key,value] of Object.entries({ tests: counts.tests, pass: counts.passed, fail: counts.failed, cancelled: 0, skipped: 0, todo: 0 })) {
    const matches = [...result.stdout.matchAll(new RegExp('^# ' + key + ' ([0-9]+)$', 'gmu'))]
    if (matches.length !== 1 || Number(matches[0][1]) !== value) blocked('missing/inconsistent TAP summary: ' + key)
  }
  const unknown = failures.filter(row => !expectedFailure(row, kind))
  if (unknown.length) blocked('unrecognized failure(s): ' + unknown.map(row => row.name + ' [' + (row.error?.code ?? row.error?.name ?? row.failureType) + ']').join('; '))
  return { tests: counts.tests, failed: failures.length, classification: failures.length ? 'recognized-fixture-failure' : 'passed' }
}

const INNER_REPORTER_SOURCE = "// Supplemental lifecycle diagnostics, never a governed host receipt.\nimport path from 'node:path'\nfunction failure(error) {\n  const cause = error?.cause ?? error\n  if (!cause) return null\n  return { name: cause.name, code: cause.code, message: cause.message, stack: cause.stack,\n    operator: cause.operator, actual: cause.actual, expected: cause.expected }\n}\nexport default async function* reporter(source) {\n  const tests = [], suites = []\n  let summary, summaryCount = 0\n  for await (const event of source) {\n    const d = event.data\n    if (event.type === 'test:summary' && d.file === undefined) { summary = d; summaryCount++ }\n    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue\n    const file = path.resolve(d.file ?? '')\n    const row = { file, name: d.name, type: event.type, skipped: !!d.skip, todo: !!d.todo,\n      fileOnly: d.line === 1 && d.column === 1 && [d.file, path.relative(process.cwd(), file), path.basename(file)].includes(d.name),\n      failureType: d.details?.error?.failureType, error: failure(d.details?.error) }\n    ;(d.details?.type === 'suite' ? suites : tests).push(row)\n  }\n  yield JSON.stringify({ schema: 'fixture-inner-events-v1', summaryCount,\n    complete: summaryCount === 1 && tests.length > 0 && tests.length === summary?.counts?.tests,\n    counts: summary?.counts, tests, suites }) + '\\n'\n}\n"
async function execute(args, env) {
  const cwdForRun = root
  const evidenceRoot = await mkdtemp(join(env.TMPDIR, 'fixture-inner-events-'))
  try {
    const reporterPath = join(evidenceRoot, 'reporter.mjs'), reportPath = join(evidenceRoot, 'events.json')
    await writeFile(reporterPath, INNER_REPORTER_SOURCE)
    if (!process.allowedNodeEnvironmentFlags.has('--test-reporter-destination')) throw new Error('Pinned Node lacks reporter destinations')
    const childEnv = { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --test-reporter=${pathToFileURL(reporterPath).href} --test-reporter-destination=stdout --test-reporter-destination=${reportPath}` }
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, args, { cwd: cwdForRun, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', timedOut = false
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', value => { stdout += value })
      child.stderr.on('data', value => { stderr += value })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 240000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr, timedOut }) })
    })
    try {
      const bytes = await readFile(reportPath, 'utf8')
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('inner lifecycle exceeds bounded capture')
      result.inner = JSON.parse(bytes)
    } catch (error) { result.innerError = 'Unable to read inner lifecycle: ' + String(error.message ?? error) }
    return result
  } finally { await rm(evidenceRoot, { recursive: true, force: true }) }
}

test("Continuity assertion compares persisted values without requiring SQLite row prototypes", { timeout: 270000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-native-fixture-contract-'))
  try {
    const env = { ...process.env, KIOKUKO_TEST_CONCURRENCY: '1', TSX_DISABLE_CACHE: '1', NO_COLOR: '1' }
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'DEV_RUNNER_OBSERVATION_FD', 'KIOKUKO_VERIFY_REPORT_DIR', 'KIOKUKO_DSH_SOURCE_ROOT', 'FORCE_COLOR']) delete env[key]
    for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      env[key] = join(base, key); await mkdir(env[key])
    }
    env.NODE_OPTIONS = '--test-reporter=tap'
    env.KIOKUKO_DSH_PACKAGE_ROOT = join(root, 'tests/fixtures/dsh-runtime/node_modules')
    env.KIOKUKO_EXPECTED_DSH_VERSION = JSON.parse(await readFile(join(root, 'tests/fixtures/dsh-runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
    env.KIOKUKO_REQUIRE_DSH_NATIVE = '1'
    const argv = ['scripts/run-tests.mjs', "tests/dsh/integration/continuity/native-loop.test.ts"]
    const result = await execute(argv, env)
    t.diagnostic(JSON.stringify({ argv: [process.execPath, ...argv], cwd: root, code: result.code, signal: result.signal, timedOut: result.timedOut,
      nativePackageRoot: env.KIOKUKO_DSH_PACKAGE_ROOT, expectedNativeVersion: env.KIOKUKO_EXPECTED_DSH_VERSION }))
    t.diagnostic(result.stdout)
    if (result.stderr) t.diagnostic(result.stderr)
    t.diagnostic(JSON.stringify({ innerLifecycle: result.inner, innerError: result.innerError }))
    validateInnerRun(result, "continuity-row-values", argv.slice(1).map(target => resolve(root, target)))
    if (result.timedOut || result.signal !== null) throw new Error('The public suite did not exit normally: ' + JSON.stringify({ timedOut: result.timedOut, signal: result.signal }))
    assert.equal(result.code, 0, result.stdout + '\n' + result.stderr)
    // NODE_OPTIONS pins the public child runner to TAP without changing its selected targets.
    assert.match(result.stdout, /^# tests [1-9][0-9]*$/mu, 'The public runner must execute real tests')
    for (const category of ['fail', 'skipped', 'cancelled', 'todo'])
      assert.match(result.stdout, new RegExp('^# ' + category + ' 0$', 'mu'), 'Coverage cannot contain ' + category)
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
})
