import assert from 'node:assert/strict'
import test from 'node:test'
import { probeLispP0 } from '../../../../scripts/lisp-p0/probe.js'

const required = process.env.KIOKUKO_REQUIRE_LISP_P0 === '1'

test('native macOS candidate starts and enforces fixture boundaries; quota counterexamples remain visible', {
  skip: required ? false : 'Explicit native P0 run required; skipped checks are not protection evidence.',
  timeout: 60_000,
}, async () => {
  assert.equal(process.platform, 'darwin', 'This test is specifically the macOS native candidate')
  const report = await probeLispP0()
  for (const id of ['native-build', 'filesystem-sample', 'network-sample', 'fd-sample',
    'rlimit-fsize-counterexample', 'rlimit-as-sample', 'fork-denial-sample', 'rlimit-nproc-thread-counterexample']) {
    const check = report.checks.find(item => item.id === id)
    assert.equal(check?.status, 'passed', `${id}: ${check?.detail ?? JSON.stringify(report.checks)}`)
  }
  assert.equal(report.readyForP1, false)
  assert.equal(report.checks.find(item => item.id === 'aggregate-tasks')?.status, 'unverified')
})
