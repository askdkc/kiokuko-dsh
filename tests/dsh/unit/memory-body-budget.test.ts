import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from '../integration/evolution/fixture.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { recallEntries } from '../../../src/memory/retrieval.js'
import { SCOPED_CONTEXT_DEFAULT_CHARACTER_BUDGET } from '../../../src/context/scoped-broker.js'
import { CONTEXT_RANKING_DEFAULT_CHARACTER_BUDGET } from '../../../src/context/ranking.js'

test('ordinary and ranked context default to 16000 Unicode characters', () => {
  assert.equal(SCOPED_CONTEXT_DEFAULT_CHARACTER_BUDGET, 16000)
  assert.equal(CONTEXT_RANKING_DEFAULT_CHARACTER_BUDGET, 16000)
})
test('default recall retains a body larger than 8000 Unicode characters', () => {
  const { db } = fixture()
  try {
    const body = '😀'.repeat(12000)
    recordEntry(db, { workspace: 'project:test', kind: 'reference', title: 'Unicode memory budget', body, createdBy: 'fixture' })
    const result = recallEntries(db, { workspace: 'project:test', query: 'Unicode memory budget' })
    assert.equal(result.items[0]?.snippet, body)
    assert.equal(result.truncated, false)
    assert.ok(result.characterCount <= 16000)
  } finally { db.close() }
})
test('an explicit recall budget remains authoritative and uses Unicode code points', () => {
  const { db } = fixture()
  try {
    const title = 'Unicode memory budget', body = '😀'.repeat(12000)
    recordEntry(db, { workspace: 'project:test', kind: 'reference', title, body, createdBy: 'fixture' })
    for (const maxChars of [4000, 8000, 16000, 32000]) {
      const result = recallEntries(db, { workspace: 'project:test', query: title, maxChars })
      const snippet = result.items[0]?.snippet
      assert.equal(snippet, Array.from(body).slice(0, Math.min(12000, maxChars - Array.from(title).length - 1)).join(''))
      assert.equal(result.characterCount, Array.from(title).length + 1 + Array.from(snippet!).length)
      assert.ok(result.characterCount <= maxChars)
    }
  } finally { db.close() }
})
