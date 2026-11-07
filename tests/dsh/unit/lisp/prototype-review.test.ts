import assert from 'node:assert/strict'
import test from 'node:test'
import { PrototypeReview, type InspectionReceipt } from '../../../../src/dsh/lisp/prototype-review.js'

function page(data: string, offset: number, totalCharacters: number, nextOffset: number | null): InspectionReceipt {
  return { version: 'version', page: {
    ok: true, state: 'SUCCEEDED', resultOperationId: 'prototype', section: 'result',
    offset, totalCharacters, nextOffset, data,
  } }
}

for (const size of [1999, 2000, 2001]) test(`reviews exactly ${size} code points across the page limit`, () => {
  const review = new PrototypeReview('prototype', 'version')
  const first = 'x'.repeat(1998) + '🙂' + (size >= 2000 ? 'e' : '')
  const continued = size > 2000
  assert.equal(review.record(page(first, 0, size, continued ? 2000 : null), 0), !continued)
  if (continued) {
    assert.deepEqual(review.status(), { issue: 'end_unseen', totalCharacters: 2001, firstMissingOffset: 2000, endSeen: false })
    assert.equal(review.record(page('\u0301', 2000, size, null), 2000), true)
  }
})

test('coverage uses delivered ranges and merges overlaps, duplicates and pages arriving out of order', () => {
  const review = new PrototypeReview('prototype', 'version')
  assert.equal(review.record(page('ghi', 6, 9, null), 6), false)
  assert.deepEqual(review.status(), { issue: 'missing_ranges', totalCharacters: 9, firstMissingOffset: 0, endSeen: true })
  for (let retry = 0; retry < 2; retry++)
    assert.equal(review.record(page('abcd', 0, 9, 4), 0), false)
  assert.equal(review.status().firstMissingOffset, 4)
  assert.equal(review.record(page('def', 3, 9, 6), 3), true)
})

test('invalid and failed pages do not fill a missing range or prove the end', () => {
  const review = new PrototypeReview('prototype', 'version')
  assert.equal(review.record(page('ab', 0, 4, 2), 0), false)
  for (const [invalid, requestedOffset] of [
    [page('cd', 2, 4, null), 1],
    [page('cd', -1, 4, null), -1],
    [page('c', 2, 4, null), 2],
    [page('cd', 2, 4, 4), 2],
    [page('', 2, 4, 2), 2],
    [page('', 4, 4, null), 4],
    [page('cde', 2, 5, null), 2],
  ] as const) {
    assert.equal(review.record(invalid, requestedOffset), false)
    assert.equal(review.status().issue, 'invalid_page')
    assert.equal(review.status().firstMissingOffset, 2)
    assert.equal(review.status().endSeen, false)
  }
  assert.equal(review.record(undefined, 2), false)
  assert.equal(review.status().issue, 'inspection_failed')
  assert.equal(review.record(page('cd', 2, 4, null), 2), true)
})
