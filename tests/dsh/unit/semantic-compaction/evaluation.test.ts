import assert from 'node:assert/strict'
import test from 'node:test'
import { captureGateReport, validateDataset } from '../../../../scripts/evaluate-laya-compaction.mjs'

test('scripted capture, shadow selection and empty evidence never qualify C0-C7', () => {
  const report = captureGateReport({ kind: 'regression', fixtures: [] }, [{ arm: 'laya', wire: [{ request: { op: 'predict_strict' } }], diagnostics: [{ status: 'selected', choice: 'keep' }, { status: 'selected', choice: 'lossless' }], observations: [{ purpose: 'compaction', selected: 2 }] }])
  assert.equal(report.realPredictions, 1); assert.equal(report.modelLosslessSelections, 1)
  assert.equal(report.acceptedRequestChanges, 0); assert.equal(report.qualified, false)
  assert.equal(Object.keys(report.gates).length, 8)
  assert.ok(Object.values(report.gates).every(gate => gate.status === 'UNVERIFIED'))
})


test('freeze requires unique paired independent holdout families and safe artifact IDs', () => {
  const fixture = { id: 'en', family: 'one', language: 'en', task: 'Count lines', body: 'line', tool: 'read', constraints: 'Preserve evidence' }
  assert.throws(() => validateDataset({ kind: 'holdout', fixtures: [fixture] }))
  assert.throws(() => validateDataset({ kind: 'regression', fixtures: [fixture, fixture] }))
  assert.throws(() => validateDataset({ kind: 'regression', fixtures: [{ ...fixture, id: '../../escape' }] }))
  assert.equal(validateDataset({ kind: 'regression', fixtures: [fixture] }).fixtures.length, 1)
})
