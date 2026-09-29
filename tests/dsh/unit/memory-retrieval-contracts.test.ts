import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRetrievalConfig, parseUnambiguousMemoryTime, timeConstraintForRequest } from '../../../src/memory/retrieval-contracts.js'

test('explicit calendar ranges bind anchor and timezone and use local half-open days', () => {
  const parsed = parseUnambiguousMemoryTime('2026-03-08..2026-03-08', {
    basis: 'occurred', anchorTimeMs: Date.UTC(2026, 2, 9), timeZone: 'America/Los_Angeles',
  })!
  assert.equal(parsed.startMs, Date.UTC(2026, 2, 8, 8))
  assert.equal(parsed.endMs, Date.UTC(2026, 2, 9, 7))
  assert.equal(parsed.endMs - parsed.startMs, 23 * 60 * 60 * 1000)
  assert.equal(parsed.anchorTimeMs, Date.UTC(2026, 2, 9))
  assert.equal(parsed.timeZone, 'America/Los_Angeles')
  assert.equal(parsed.mode, 'restrict')
})

test('Japanese date ranges and single dates parse while incomplete dates stay unbound', () => {
  const options = { basis: 'recorded' as const, anchorTimeMs: 1234, timeZone: 'Asia/Tokyo' }
  const range = parseUnambiguousMemoryTime('2026年9月10日から2026年9月12日までの記憶', options)!
  assert.equal(range.startMs, Date.parse('2026-09-09T15:00:00.000Z'))
  assert.equal(range.endMs, Date.parse('2026-09-12T15:00:00.000Z'))
  assert.throws(() => parseUnambiguousMemoryTime('2026-02-30', options), /invalid date/iu)
  assert.equal(parseUnambiguousMemoryTime('2026-09-10T15:30:00Z', options), undefined)
})

test('relative calendar periods use the request anchor and local week/month boundaries', () => {
  const options = { basis: 'occurred' as const, anchorTimeMs: Date.parse('2026-09-10T15:00:00.000Z'), timeZone: 'Asia/Tokyo' }
  const previousWeek = parseUnambiguousMemoryTime('先週の作業を探す', options)!
  assert.equal(previousWeek.startMs, Date.parse('2026-08-30T15:00:00.000Z'))
  assert.equal(previousWeek.endMs, Date.parse('2026-09-06T15:00:00.000Z'))
  const today = parseUnambiguousMemoryTime('today', options)!
  assert.equal(today.startMs, Date.parse('2026-09-10T15:00:00.000Z'))
  assert.equal(today.endMs, Date.parse('2026-09-11T15:00:00.000Z'))
  assert.throws(() => parseUnambiguousMemoryTime('today and 2026-09-10', options), /ambiguous/iu)
  assert.throws(() => parseUnambiguousMemoryTime('2026-09-12から2026-09-10', options), /empty or reversed/iu)
  assert.throws(() => parseUnambiguousMemoryTime('today and yesterday', options), /ambiguous/iu)
  assert.throws(() => parseUnambiguousMemoryTime('before 2026-09-10', options), /open-ended/iu)
  assert.throws(() => parseUnambiguousMemoryTime('2026-09-10以降', options), /open-ended/iu)
})

test('default-off ignores dates; observe binds a shadow-only time condition', () => {
  const query = 'Show me what happened on 2026-09-10'
  assert.equal(timeConstraintForRequest(query, MemoryRetrievalConfig.parse({ mode: 'off' }), 1), undefined)
  assert.equal(timeConstraintForRequest(query, MemoryRetrievalConfig.parse({ mode: 'observe' }), 1)?.anchorTimeMs, 1)
  assert.equal(timeConstraintForRequest(query, MemoryRetrievalConfig.parse({ mode: 'active' }), 1)?.anchorTimeMs, 1)
  assert.throws(() => MemoryRetrievalConfig.parse({ mode: 'active', timeZone: 'Not/AZone' }))
})
