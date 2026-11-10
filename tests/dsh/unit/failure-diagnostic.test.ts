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

test('routine tool exposure is silent while actual failures still warn', (t) => {
  const previous = process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG
  delete process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG
  t.after(() => {
    if (previous === undefined) delete process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG
    else process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG = previous
  })
  const lines: string[] = []
  t.mock.method(console, 'info', (line: string) => lines.push(line))
  t.mock.method(console, 'warn', (line: string) => lines.push(line))
  const reporter = createToolExposureDiagnostics(() => ToolExposureConfig.parse({ mode: 'auto' }))
  const context: ToolExposureContext = { agentId: 'agent', sessionId: 'session', runId: null, turn: null, nativeSeq: 6,
    prepareGeneration: null, closed: null, failed: null, taskType: null, intakeStatus: null, selectionStatus: null, policyKnown: false }
  const metrics = { toolCountBefore: 83, toolCountAfter: 83, taskFilteredCount: 0, phaseFilteredCount: 0,
    descriptionTransformedCount: 1, descriptionBytesBefore: 23485, descriptionBytesAfter: 23068,
    parameterBytesBefore: 62586, parameterBytesAfter: 62586, unownedSurfaceReductionCount: 0 as const,
    unownedSurfaceReductionReason: 'registration_provenance_unavailable' as const }
  for (let prepareGeneration = 1; prepareGeneration <= 10; prepareGeneration++) {
    reporter.fallback('unbound:turn_record_missing', { ...context, nativeTurn: prepareGeneration })
    reporter.projection('lean', 'task_execution:build:projected', metrics, { ...context, prepareGeneration })
  }
  assert.deepEqual(lines, [])
  reporter.fallback('pre_step_runtime', { ...context, failure: { code: 'API_ERROR' } })
  reporter.fallback('unbound:policy_binding', context)
  assert.equal(lines.length, 2)
  process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG = '1'
  reporter.fallback('unbound:turn_record_missing', { ...context, nativeTurn: 1 })
  reporter.projection('lean', 'task_execution:build:projected', metrics, { ...context, prepareGeneration: 1 })
  assert.equal(lines.length, 4)
  assert.match(lines[3]!, /kiokuko.tool-exposure.v1/)
})

test('tool exposure diagnostics collapse per-step repeats within one native turn', (t) => {
  const previous = process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG
  process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG
    else process.env.KIOKUKO_TOOL_EXPOSURE_DEBUG = previous
  })
  const lines: string[] = []
  const reporter = createToolExposureDiagnostics(() => ToolExposureConfig.parse({ mode: 'auto' }), { info: line => lines.push(line), warn: line => lines.push(line) })
  const base: ToolExposureContext = { agentId: 'agent', sessionId: 'session-a', runId: null, turn: null, nativeTurn: 1, step: 1, nativeSeq: 26,
    prepareGeneration: null, closed: null, failed: null, taskType: null, intakeStatus: null, selectionStatus: null, policyKnown: false }
  for (let step = 1; step <= 25; step++) reporter.fallback('unbound:turn_record_missing', { ...base, step, nativeSeq: 26 + step * 15 })
  assert.equal(lines.length, 1, 'steps of one native turn share one identity: the first observation is kept, repeats are dropped')
  reporter.fallback('unbound:turn_record_missing', { ...base, nativeTurn: 2, step: 1, nativeSeq: 500 })
  assert.equal(lines.length, 2, 'a new native turn is a new identity')
  reporter.fallback('unbound:turn_record_missing', { ...base, nativeTurn: 2, step: 2, nativeSeq: 520 })
  assert.equal(lines.length, 2)
  reporter.fallback('pre_step_runtime', { ...base, failure: { code: 'API_ERROR' } })
  assert.equal(lines.length, 3, 'a different reason is never suppressed')
  const first = JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')))
  assert.equal(first.context.nativeSeq, 41, 'the kept line still attributes its own step and sequence')
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
