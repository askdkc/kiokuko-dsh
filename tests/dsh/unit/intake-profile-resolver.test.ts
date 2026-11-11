import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveGroundedIntakeProfile } from '../../../src/dsh/intake-profile-resolver.js'

test('missing target and success criteria remain Akinator questions, not invented cwd/task answers', () => {
  const resolved = resolveGroundedIntakeProfile({ task: 'Fix it', cwd: '/repo', profileHints: { taskType: 'debug' } })
  assert.equal(resolved.profileHints.target, null)
  assert.equal(resolved.profileHints.expected, null)
})

test('long original requests are admitted without truncating their final instruction', () => {
  const task = '診断ログ: 正常な投影です。\n'.repeat(20_000) + 'この無駄な出力を止めて。削除はしないで。'
  assert.equal(resolveGroundedIntakeProfile({ task, cwd: '/repo', profileHints: { taskType: 'debug' } }).task, task)
  for (const task of ['', '   ', 'bad\u0000request']) {
    assert.throws(() => resolveGroundedIntakeProfile({ task, cwd: '/repo' }))
  }
  assert.throws(() => resolveGroundedIntakeProfile({ task, cwd: '/' + 'x'.repeat(4096) }))
})

test('explicit grounded intake answers remain intact', () => {
  const hints = { taskType: 'debug' as const, target: 'login', expected: 'login succeeds', constraints: null }
  assert.deepEqual(resolveGroundedIntakeProfile({ task: 'Fix login', cwd: '/repo', profileHints: hints }).profileHints, hints)
})

test('Akinator source answers accept a multiline target without losing the request or exclusions', () => {
  const task = 'kiokuko-dsh の resume を修正してください。\n準備状態を復旧する。\ndsh-cli は変更しない。'
  const resolved = resolveGroundedIntakeProfile({ task, cwd: '/repo', profileHints: { taskType: 'debug', target: task } })
  assert.equal(resolved.task, task)
  assert.equal(resolved.profileHints.target, task)
})
