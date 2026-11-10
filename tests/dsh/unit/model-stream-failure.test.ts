import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeModelStreamFailure } from '../../../src/dsh/harness/model-stream-failure.js'

const diagnostic = { configuredTransport: 'auto', phase: 'after_message_stream_start', eventsEmitted: true, requestBytes: 859451, code: 1012 }
const message = (details: unknown) => `Codex WebSocket failure\n${JSON.stringify(details)}`

for (const code of [1012, 1013]) for (const eventsEmitted of [false, true]) {
  test(`Codex close ${code} is transport failure ${eventsEmitted ? 'after' : 'before'} stream start`, () => {
    const failure = Object.freeze({ code: 'PI_AI_ERROR', message: message({ ...diagnostic, code, eventsEmitted,
      phase: eventsEmitted ? 'after_message_stream_start' : 'before_message_stream_start' }), providerRetryAfterMs: 25 })
    const result = normalizeModelStreamFailure(failure)
    assert.deepEqual(result, { ...failure, code: 'TRANSPORT' })
    assert.equal(failure.code, 'PI_AI_ERROR', 'Caller-owned failure remains unchanged')
  })
}

for (const code of [1000, 1002, 1008, 1009, 4001, '1012', undefined]) {
  test(`does not turn unknown or nontransient close ${code} into a retryable failure`, () => {
    const failure = { code: 'PI_AI_ERROR', message: message({ ...diagnostic, code }) }
    assert.equal(normalizeModelStreamFailure(failure), failure)
  })
}

for (const code of ['AUTH', 'INVALID_REQUEST', 'ABORTED', 'QUOTA', 'TRANSPORT']) {
  test(`preserves existing ${code} classification`, () => {
    const failure = { code, message: message(diagnostic) }
    assert.equal(normalizeModelStreamFailure(failure), failure)
  })
}

for (const text of [
  'Codex WebSocket failure',
  'Codex WebSocket failure {bad json}',
  'Codex WebSocket failure null',
  message([diagnostic]),
  `Unrelated provider failure ${JSON.stringify(diagnostic)}`,
  message({ ...diagnostic, phase: 'unknown' }),
  message({ ...diagnostic, eventsEmitted: false }),
]) {
  test(`preserves unrecognized diagnostic: ${text}`, () => {
    const failure = { code: 'PI_AI_ERROR', message: text }
    assert.equal(normalizeModelStreamFailure(failure), failure)
  })
}

for (const status of [400, 401, 403, 413, 429]) {
  test(`does not override explicit HTTP rejection ${status}`, () => {
    const failure = { code: 'PI_AI_ERROR', status, message: message(diagnostic) }
    assert.equal(normalizeModelStreamFailure(failure), failure)
  })
}
