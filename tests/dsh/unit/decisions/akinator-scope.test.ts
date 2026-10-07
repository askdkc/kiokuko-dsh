import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAkinatorClassificationBatch } from '../../../../src/dsh/decisions/akinator-classification.js'

test('question punctuation cannot bypass unsupported or combined execution scope', () => {
  for (const task of ['検索機能を実装してくれますか？', 'バグを修正してデプロイしてくれますか？', 'Fix and deploy the application?', 'Could you build a compiler?', '富士山について調べて紹介文を書いてくれますか？', 'Can you do that?', 'それをお願いできますか？']) {
    assert.equal(buildAkinatorClassificationBatch(task), undefined, task)
  }
})
test('ordinary questions and supported single requests still preserve the original text', () => {
  for (const task of ['富士山って日本で一番高い山?', 'Is Mount Fuji not the highest mountain in Japan?', 'Are cats and dogs mammals?', 'ログイン時の例外を修正してくれますか？', '富士山の標高を公式資料で調べてもらえますか？', 'Could you write a thank-you email?']) {
    assert.equal(buildAkinatorClassificationBatch(task)?.state, task, task)
  }
})
