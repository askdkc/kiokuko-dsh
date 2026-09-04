import assert from 'node:assert/strict'
import test from 'node:test'
import { boundaryFailureCopy } from '../../../src/dsh/user-interaction.js'

test('internal failure recovery explains the cause and retry boundary in the user language', () => {
  const ja = boundaryFailureCopy('ja')
  assert.match(ja.title, /内部処理が3回失敗/u)
  assert.match(ja.recoveryInstruction, /依頼内容が不足しているという意味ではありません/u)
  assert.match(ja.recoveryInstruction, /原因が未解消なら/u)
  assert.match(ja.recoveryInstruction, /空欄・取消では停止/u)
  const en = boundaryFailureCopy('en')
  assert.match(en.title, /internal processing failures/u)
  assert.match(en.recoveryInstruction, /does not mean your task description is incomplete/u)
  assert.match(en.recoveryInstruction, /empty answer or cancellation leaves processing stopped/u)
})
