import assert from 'node:assert/strict'
import test from 'node:test'
import { withNativeForegroundOnly } from '../../../../src/dsh/lisp/native-foreground.js'

test('job admission is rejected before producer execution and normal calls remain unchanged', async () => {
  let starts = 0
  const jobs = { start() { starts++; return 'job' } }, original = jobs.start
  await withNativeForegroundOnly(jobs, async () => {
    assert.throws(() => jobs.start(), /foreground execution/)
    assert.equal(starts, 0)
  })
  assert.equal(jobs.start, original)
  assert.equal(jobs.start(), 'job'); assert.equal(starts, 1)
})
test('concurrent synchronous invocations cannot launch jobs or change an unrelated invocation', async () => {
  let starts = 0
  const jobs = { start() { starts++ } }, original = jobs.start
  const calls = [5, 15].map(delay => withNativeForegroundOnly(jobs, async () => {
    await new Promise(resolve => setTimeout(resolve, delay))
    assert.throws(() => jobs.start(), /foreground execution/)
  }))
  jobs.start()
  await Promise.all(calls)
  assert.equal(starts, 1)
  assert.equal(jobs.start, original)
})
test('nested scopes and failed dispatch restore the existing host method', async () => {
  const jobs = { start() { throw new Error('producer must not run') } }, original = jobs.start
  await assert.rejects(withNativeForegroundOnly(jobs, async () => {
    await withNativeForegroundOnly(jobs, async () => assert.throws(() => jobs.start(), /foreground execution/))
    assert.throws(() => jobs.start(), /foreground execution/)
    throw new Error('dispatch failed')
  }), /dispatch failed/)
  assert.equal(jobs.start, original)
})
test('hosts without a jobs registry keep their foreground dispatch', async () => {
  let calls = 0
  assert.equal(await withNativeForegroundOnly(undefined, async () => { calls++; return 42 }), 42)
  assert.equal(calls, 1)
})
