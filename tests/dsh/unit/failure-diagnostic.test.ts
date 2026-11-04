import assert from 'node:assert/strict'
import test from 'node:test'
import { failureDiagnostic } from '../../../src/dsh/failure-diagnostic.js'
import { createToolExposureDiagnostics, type ToolExposureContext } from '../../../src/dsh/tool-exposure-diagnostics.js'
import { ToolExposureConfig } from '../../../src/dsh/tool-exposure.js'

test('diagnostics bound hostile fields and omit private error structure', () => {
  const diagnostic = failureDiagnostic({ code: 'API_ERROR', status: 502, requestId: 'x'.repeat(257),
    message: 'Provider unavailable. '.repeat(1000) + 'authorization secret-value', cause: { private: 'private-value' }, stack: 'private-stack' }, 'redacted')
  assert.equal(diagnostic.code, 'API_ERROR'); assert.equal(diagnostic.status, 502)
  assert.equal(diagnostic.requestId, undefined); assert.equal(diagnostic.messageTruncated, true)
  assert.ok(String(diagnostic.message).length <= 2000)
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-value|private-value|private-stack/)
  assert.deepEqual(failureDiagnostic({ get failure() { throw new Error('private-getter') }, get message() { throw new Error('private-getter') } }), { code: 'UNKNOWN', messageOmitted: true })
  assert.equal(failureDiagnostic({ message: 'capacity exceeded' }, 'metadata').message, undefined)
})

test('tool exposure diagnostics correlate each native session, deduplicate exact observations and bound retention', () => {
  const lines: string[] = []
  const reporter = createToolExposureDiagnostics(() => ToolExposureConfig.parse({ mode: 'auto' }), { info: line => lines.push(line), warn: line => lines.push(line) })
  const context: ToolExposureContext = { agentId: 'agent', sessionId: 'session-a', runId: null, turn: null, nativeSeq: 3,
    prepareGeneration: null, closed: null, failed: null, taskType: null, intakeStatus: null, selectionStatus: null, policyKnown: false }
  reporter.fallback('pre_step_missing_turn', context); reporter.fallback('pre_step_missing_turn', context)
  reporter.fallback('pre_step_missing_turn', { ...context, sessionId: 'session-b' })
  assert.equal(lines.length, 2)
  const values = lines.map(line => JSON.parse(line.slice(line.indexOf('{'))))
  assert.notEqual(values[0].diagnosticId, values[1].diagnosticId)
  assert.equal(values[0].context.sessionId, 'session-a'); assert.equal(values[0].context.runId, null)
  assert.equal(typeof values[0].runtime.pluginVersion, 'string')
  for (let index = 0; index < 513; index++) reporter.fallback('pre_step_missing_turn', { ...context, sessionId: `session-${index}` })
  reporter.fallback('pre_step_missing_turn', context)
  assert.equal(lines.length, 516, 'bounded retention may re-emit old observations; it never suppresses a different session')
})
