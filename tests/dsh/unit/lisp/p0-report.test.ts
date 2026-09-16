import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyIsolation, formatP0Report, parseNativeObservations, unverifiedRequirements } from '../../../../scripts/lisp-p0/report.js'
import { seatbeltProfile } from '../../../../scripts/lisp-p0/probe.js'

function rows(denial = 0) {
  return [0, 1].map(child => ({ child, readInput: 0, writeInput: denial, readPrivate: denial,
    writeScratch: 0, tcp: denial, udp: denial, unix: denial, unexpectedFds: 0 }))
}

test('denial only counts when the identical unconfined fixture operation succeeds', () => {
  assert.ok(classifyIsolation(rows(), rows(13)).every(check => check.status === 'passed'))
  assert.equal(classifyIsolation(rows(13), rows(13))[0]!.status, 'unverified')
  assert.equal(classifyIsolation(rows(), rows(61))[1]!.status, 'failed')
  assert.equal(classifyIsolation(rows(), rows(2))[0]!.status, 'failed')
})

test('child escape, broken scratch access and an inherited descriptor fail the corresponding probe', () => {
  const observations = rows(1)
  observations[1]!.tcp = 0
  observations[1]!.writeScratch = 13
  observations[1]!.unexpectedFds = 1
  assert.ok(classifyIsolation(rows(), observations).every(check => check.status === 'failed'))
})

test('malformed, incomplete, repeated and oversized observation shapes cannot become proof', () => {
  const observations = rows()
  assert.deepEqual(parseNativeObservations(observations.map(row => JSON.stringify(row)).join('\n')), observations)
  for (const value of ['', '{}', 'null\nnull', '[1]\n[2]', '{"child":0}\n{"child":1}',
    observations.map(() => JSON.stringify(observations[0])).join('\n'),
    observations.map(row => JSON.stringify({ ...row, injected: 1 })).join('\n')]) {
    assert.throws(() => parseNativeObservations(value))
  }
})

test('primitive success does not claim aggregate quotas, descendant cleanup or production admission', () => {
  const checks = [...classifyIsolation(rows(), rows(1)), ...unverifiedRequirements()]
  const text = formatP0Report({ schemaVersion: 1, phase: 'P0', platform: 'darwin', architecture: 'arm64',
    kernel: 'fixture', node: 'fixture', sbcl: 'fixture', backend: 'fixture', checks, readyForP1: false })
  assert.match(text, /BLOCKED/)
  for (const id of ['aggregate-memory', 'aggregate-cpu', 'aggregate-tasks', 'scratch-quota', 'crash-cleanup', 'dsh-all-paths']) {
    assert.equal(checks.find(check => check.id === id)?.status, 'unverified')
  }
})

test('candidate Seatbelt profile admits only fixture paths and rejects profile injection', () => {
  const profile = seatbeltProfile('/private/tmp/p0-fixture')
  assert.match(profile, /\(deny default\)/)
  assert.doesNotMatch(profile, /\(allow (default|network)/)
  // dyld needs data access to the root directory itself, not its descendants.
  assert.match(profile, /\(allow file-read-data \(literal "\/"\)\)/)
  assert.doesNotMatch(profile, /\(subpath "\/"\)/)
  assert.match(profile, /literal "\/private\/tmp\/p0-fixture\/input"/)
  const noFork = seatbeltProfile('/private/tmp/p0-fixture', false)
  assert.match(noFork, /\(deny process-fork\)/)
  assert.doesNotMatch(noFork, /\(allow process-fork\)/)
  for (const root of ['relative', '/tmp/"x', '/tmp/x\n', '/tmp/\\x']) assert.throws(() => seatbeltProfile(root))
})
