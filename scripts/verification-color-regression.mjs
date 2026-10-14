import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

// Protocol regression: exercise the real verifier, not a copied merge function.
// Every fixture supplies the conflicting variables itself; the protocol runner's
// deliberately empty parent environment cannot accidentally make this green.
const repository = realpathSync(process.argv[2] ?? process.cwd())
const cases = [
  { name: 'check-force', contract: {}, check: { FORCE_COLOR: '1' }, expected: { FORCE_COLOR: '1' } },
  { name: 'check-no-color', contract: {}, check: { NO_COLOR: '1' }, expected: { NO_COLOR: '1' } },
  { name: 'contract-force', contract: { FORCE_COLOR: '1' }, check: {}, expected: { FORCE_COLOR: '1' } },
  { name: 'contract-no-color', contract: { NO_COLOR: '1' }, check: {}, expected: { NO_COLOR: '1' } },
  { name: 'check-overrides-contract', contract: { FORCE_COLOR: '1' }, check: { NO_COLOR: '1' }, expected: { NO_COLOR: '1' } },
]
let passed = 0
for (const entry of cases) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verify-color-regression-')))
  const root = join(base, 'project'), output = join(base, 'evidence'), home = join(base, 'home')
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(home)
  const environment = {
    PATH: [dirname(process.execPath), process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(delimiter),
    HOME: home, USERPROFILE: home, LANG: 'C.UTF-8', TMPDIR: base, TMP: base, TEMP: base,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1', FORCE_COLOR: '1',
  }
  try {
    for (const name of ['verify.mjs', 'verification-contract.mjs', 'verification-reporter.mjs', 'verification-test-environment.mjs', 'verification-completion.mjs'])
      cpSync(join(repository, 'scripts', name), join(root, 'scripts', name))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    const required = { literal42: true, literal142Rejected: true, colorEnvironment: true }
    writeFileSync(join(root, 'scripts', 'verification.json'), JSON.stringify({
      package: 'color-fixture', profiles: ['full'], environment: entry.contract, testExclusions: [],
      checks: [{ id: 'literal-color', profiles: ['full'], argv: ['node', 'literal.mjs'], env: entry.check,
        expected: 'Exact child color environment, clean literal output, and a real completion receipt', result: 'script', requires: [], dependsOn: [], completionEvidence: required }],
    }))
    writeFileSync(join(root, 'literal.mjs'), `
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { completeVerification } from './scripts/verification-completion.mjs'
const observedEnvironment = Object.fromEntries(['FORCE_COLOR', 'NO_COLOR'].filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]]))
const run = value => {
  const child = spawnSync(process.execPath, ['--eval', 'console.log(' + JSON.stringify(value) + ')'], { env: process.env, encoding: 'utf8', timeout: 10000 })
  return { status: child.status, signal: child.signal, error: child.error?.message ?? null, stdout: child.stdout, stderr: child.stderr }
}
const literal42 = run('42'), literal142 = run('142')
writeFileSync(join(dirname(process.env.KIOKUKO_VERIFY_COMPLETION_FILE), 'observed.json'), JSON.stringify({ environment: observedEnvironment, literal42, literal142 }))
assert.deepEqual(observedEnvironment, ${JSON.stringify(entry.expected)}, 'declared color overrides must not retain a contradictory inherited flag')
for (const actual of [literal42, literal142]) { assert.equal(actual.error, null); assert.equal(actual.signal, null); assert.equal(actual.status, 0); assert.equal(actual.stderr, '', 'color policy must not inject a Node warning into literal evidence') }
assert.equal(literal42.stdout, '42\\n')
assert.equal((literal42.stdout + literal42.stderr).trimEnd(), '42')
assert.equal(literal142.stdout, '142\\n')
assert.notEqual((literal142.stdout + literal142.stderr).trimEnd(), '42', 'strict literal comparison must still reject a containing number')
completeVerification(${JSON.stringify(required)})
`)
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, env: environment, encoding: 'utf8', timeout: 10000 })
    assert.equal(initialized.error, undefined); assert.equal(initialized.signal, null); assert.equal(initialized.status, 0, initialized.stderr)
    const child = spawnSync(process.execPath, ['scripts/verify.mjs', '--output', output], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    })
    const receiptDirectory = join(output, 'receipts', 'literal-color')
    const observed = existsSync(join(receiptDirectory, 'observed.json')) ? JSON.parse(readFileSync(join(receiptDirectory, 'observed.json'), 'utf8')) : null
    console.log(JSON.stringify({ case: entry.name, childExit: child.status, observed }))
    if (child.status !== 0) { process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '') }
    assert.equal(child.error, undefined, 'real verify entry must launch and finish')
    assert.equal(child.signal, null, 'real verify entry must not be killed')
    assert.ok(observed, 'the check must actually observe its environment and literal processes')
    assert.equal(child.status, 0, `${entry.name}: declared color override must keep literal evidence clean`)
    const report = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'))
    assert.equal(report.status, 'passed'); assert.equal(report.completionReady, true)
    assert.equal(report.checks.length, 1); assert.equal(report.checks[0].status, 'passed'); assert.equal(report.checks[0].exitCode, 0)
    const receipt = JSON.parse(readFileSync(join(receiptDirectory, 'complete.json'), 'utf8'))
    assert.equal(receipt.schema, 'verification-completion-v1'); assert.equal(receipt.id, 'literal-color')
    assert.equal(receipt.status, 'passed'); assert.equal(typeof receipt.nonce, 'string'); assert.ok(receipt.nonce.length)
    assert.deepEqual(receipt.evidence, required)
    passed++
  } finally { rmSync(base, { recursive: true, force: true }) }
}
assert.equal(passed, cases.length)
console.log(`Verifier color regression passed: ${passed} real verifier executions, exact 42/142 output, five completion receipts.`)
