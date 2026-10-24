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
  const file = row.file.split('/').at(-1)
  // Known environment failures are never rescued by another matching failure.
  if (['EPERM','EACCES','ENOENT','EADDRINUSE','EADDRNOTAVAIL','ECONNREFUSED','ENETUNREACH','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_DLOPEN_FAILED','ERR_UNKNOWN_FILE_EXTENSION'].includes(e.code)
    || /NETLINK_ROUTE|operation not permitted|Cannot find (?:package|module)|Command failed:.*(?:npm|pnpm|build)/iu.test(message)) return false
  if (row.failureType !== 'testCodeFailure') return false
  if (kind === 'historical') {
    if ((file === 'deep-quality-migration.test.ts' && row.name === 'quality migration preserves a version 1 interrupted attempt byte-for-byte and resumes its original protocol')
      || (file === 'v4-message-sources.test.ts' && row.name === 'V4 upgrade normalizes only unsent Deep inputs and preserves uncertain delivery'))
      return e.code === 'ERR_SQLITE_ERROR' && message === 'no such column: task_owner_session_id'
        && /claimExecutionOwner.*execution-owner\.ts:/u.test(stack) && /deep-thinker\/store\.ts:/u.test(stack)
    if (file === 'schema-baseline.test.ts' && row.name === 'baseline initialization creates the complete DSH schema with clean integrity') {
      if (e.code !== 'ERR_ASSERTION' || e.operator !== 'deepStrictEqual' || !Array.isArray(e.actual) || !Array.isArray(e.expected)) return false
      return equalJson(e.actual.filter(x => !e.expected.includes(x)).sort(), ['dsh_task_source_entries','dsh_task_source_finalizations','dsh_task_source_history','ledger_task_evidence'])
        && e.expected.every(x => e.actual.includes(x)) && /schema-baseline\.test\.ts:/u.test(stack)
    }
  }
  if (kind === 'owned-stop' && file === 'task-preflight-cancel.test.ts') {
    const allowed = ['start-job keeps a started job cancellable when its acknowledgement has stale task authority',
      'tool-call keeps a started job cancellable when its acknowledgement has stale task authority',
      'cancellation keeps an owned job unresolved until its host receipt confirms termination']
    return allowed.includes(row.name) && e.code === 'STOP_UNCONFIRMED'
      && /LispManager\.(?:cancel|dispose).*lisp\/manager\.ts:/u.test(stack)
  }
  if (kind === 'bundle' && file === 'bundle-install.test.ts') {
    const allowed = ['dsh bundle manifest has one named Kiokuko Cordis row and no default export',
      'dsh installs and removes the packed bundle in an isolated profile']
    return allowed.includes(row.name) && e.name === 'SyntaxError'
      && /^Unexpected non-whitespace character after JSON at position \d+/u.test(message)
      && /JSON\.parse/u.test(stack) && /bundle-install\.test\.ts:(?:116|156|157):/u.test(stack)
  }
  if (kind === 'queued' && file === 'queued-intent-native.test.ts'
    && ['queued full-laya eager: preserve every request without purpose UI','queued full-jev eager: preserve every request without purpose UI'].includes(row.name)) {
    if (e.code !== 'ERR_ASSERTION' || e.operator !== 'strictEqual' || e.actual !== 1 || e.expected !== 2 || !/queued-intent-native\.test\.ts:/u.test(stack)) return false
    try {
      const diagnostic = JSON.parse(message.split('\n\n')[0])
      const first = diagnostic.results.find(r => r.toolCallId === 'queued-probe-0')
      const second = diagnostic.results.find(r => r.toolCallId === 'queued-probe-1')
      return first?.isError === false && second?.isError === true
        && second.content.some(block => typeof block.text === 'string' && block.text.includes('Before tool-backed work, call prepare_requested_work'))
    } catch { return false }
  }
  if (kind === 'continuity' && file === 'native-loop.test.ts'
    && /^real DSH continuity (?:off|shadow|active): final requests after compaction and same-run reload$/u.test(row.name)
    && message.startsWith('Native execution path timed out: ') && /at settle.*native-loop\.test\.ts:/u.test(stack)) {
    try {
      const diagnostic = JSON.parse(message.slice('Native execution path timed out: '.length))
      const runs = diagnostic.state.ledger_runs.filter(row => row.dsh_session_id === 'execution-session')
      const run = runs[0], unresolved = JSON.parse(run.task_unresolved_json)
      const denied = diagnostic.events.find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === 'prepare-resume')?.data?.message
      return runs.length === 1 && run.status === 'active' && run.task_state === 'Working' && unresolved.reason === 'DECISION_AUTH'
        && denied?.isError === true && denied.content.some(block => block.text === 'Error: The current task continuation is unresolved or stale')
        && diagnostic.requests === 11 && diagnostic.reads === 4 && diagnostic.writes === 0
    } catch { return false }
  }
  if (kind === 'native-close' && file === 'native-adapter.test.ts'
    && row.name === 'native adapter mounts model tools and admits a grounded turn without redundant questions'
    && e.code === 'ERR_ASSERTION' && e.operator === 'deepStrictEqual' && /native-adapter\.test\.ts:/u.test(stack)) {
    const { authority, ...rest } = e.actual ?? {}
    return authority && typeof authority.taskId === 'string' && authority.taskId === rest.runId
      && typeof authority.sessionId === 'string' && typeof authority.repositoryRoot === 'string'
      && Number.isInteger(authority.revision) && Number.isInteger(authority.generation)
      && !Object.hasOwn(e.expected ?? {}, 'authority') && equalJson(rest, e.expected)
  }
  return false
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

test("Continuity reload prepares the same research task with current host-bound intent evidence", { timeout: 270000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-native-fixture-contract-'))
  try {
    const env = { ...process.env, KIOKUKO_TEST_CONCURRENCY: '1', TSX_DISABLE_CACHE: '1', NO_COLOR: '1' }
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'DEV_RUNNER_OBSERVATION_FD', 'KIOKUKO_VERIFY_REPORT_DIR', 'KIOKUKO_DSH_SOURCE_ROOT', 'FORCE_COLOR']) delete env[key]
    for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      env[key] = join(base, key); await mkdir(env[key])
    }
    env.NODE_OPTIONS = '--test-reporter=tap'
    env.KIOKUKO_DSH_PACKAGE_ROOT = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root, 'tests/fixtures/dsh-runtime/node_modules')
    env.KIOKUKO_EXPECTED_DSH_VERSION = JSON.parse(await readFile(join(env.KIOKUKO_DSH_PACKAGE_ROOT, '@deepseek-ai/dsh/package.json'), 'utf8')).version
    env.KIOKUKO_REQUIRE_DSH_NATIVE = '1'
    const argv = ['scripts/run-tests.mjs', "tests/dsh/integration/continuity/native-loop.test.ts"]
    const result = await execute(argv, env)
    t.diagnostic(JSON.stringify({ argv: [process.execPath, ...argv], cwd: root, code: result.code, signal: result.signal, timedOut: result.timedOut,
      nativePackageRoot: env.KIOKUKO_DSH_PACKAGE_ROOT, expectedNativeVersion: env.KIOKUKO_EXPECTED_DSH_VERSION }))
    t.diagnostic(result.stdout)
    if (result.stderr) t.diagnostic(result.stderr)
    t.diagnostic(JSON.stringify({ innerLifecycle: result.inner, innerError: result.innerError }))
    validateInnerRun(result, "continuity", argv.slice(1).map(target => resolve(root, target)))
    if (result.timedOut || result.signal !== null) throw new Error('The public suite did not exit normally: ' + JSON.stringify({ timedOut: result.timedOut, signal: result.signal }))
    assert.equal(result.code, 0, result.stdout + '\n' + result.stderr)
    // NODE_OPTIONS pins the public child runner to TAP without changing its selected targets.
    assert.match(result.stdout, /^# tests [1-9][0-9]*$/mu, 'The public runner must execute real tests')
    for (const category of ['fail', 'skipped', 'cancelled', 'todo'])
      assert.match(result.stdout, new RegExp('^# ' + category + ' 0$', 'mu'), 'Coverage cannot contain ' + category)
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
})
