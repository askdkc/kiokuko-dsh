import assert from 'node:assert/strict'
import test from 'node:test'
import { ContinuityConfig, buildContinuationView, renderContinuationView, type ContinuityInput } from '../../../../src/context/continuity-view.js'
import { adaptContinuity } from '../../../../src/dsh/continuity-adapter.js'
import { updateExecutionFrame } from '../../../../src/dsh/execution-frame.js'
import { Config } from '../../../../src/dsh/config.js'
import { DshEfficiencyObserver } from '../../../../src/dsh/efficiency.js'

function input(): ContinuityInput {
  const source = { kind: 'execution-evidence' as const, key: 'run:evidence', revision: 'digest' }
  return { owner: { runId: 'run', workspace: '/project', sessionId: 'session', mode: 'normal', workUnitId: null, role: null },
    stamp: 'stamp', sources: [source], coverage: 'complete', omittedItems: 0,
    items: [{ key: 'evidence', kind: 'observation', text: '資料🙂 {{not_a_command}}', basis: 'host-observation', validity: 'historical', sources: [source] }] }
}
test('configuration is opt-in with bounded integers without tightening unrelated config', () => {
  assert.equal(Config.parse({ unrelated: true }).continuity.mode, 'off')
  for (const value of [{ mode: 'on' }, { maxItems: 25 }, { maxItems: 1.5 }, { maxSupplementBytes: 511 }, { maxSupplementBytes: 8193 }]) {
    assert.equal(ContinuityConfig.safeParse(value).success, false)
  }
})
test('projection is deterministic, immutable and separates source and display digests', () => {
  const source = input(), before = structuredClone(source), config = ContinuityConfig.parse({ mode: 'active' })
  const first = renderContinuationView(buildContinuationView(source), config)
  assert.deepEqual(first, renderContinuationView(buildContinuationView(source), config))
  assert.deepEqual(source, before)
  const changed = renderContinuationView(buildContinuationView({ ...source, stamp: 'next-revision' }), config)
  assert.equal(first.bodyDigest, changed.bodyDigest)
  assert.notEqual(first.sourceDigest, changed.sourceDigest)
  assert.match(first.text, /\{\{not_a_command\}\}/)
})
test('whole Japanese and emoji items respect every byte budget and item cap with explicit omissions', () => {
  const source = input()
  for (const budget of [512, 600, 4096, 8192]) {
    const items = Array.from({ length: 40 }, (_, i) => ({ ...source.items[0]!, key: String(i), text: '日本語🙂'.repeat(i + 1) }))
    const output = renderContinuationView(buildContinuationView({ ...source, items }), ContinuityConfig.parse({ mode: 'active', maxSupplementBytes: budget, maxItems: 12 }))
    assert.ok(output.bytes <= budget)
    assert.ok(output.items <= 12)
    assert.equal(output.items + output.omittedItems, 40)
    assert.equal(output.coverage, 'partial')
    assert.match(output.text, /Omitted items:/)
    assert.doesNotMatch(output.text, /�/)
    for (const line of output.text.split('\n').filter(line => line.startsWith('observation'))) assert.doesNotThrow(() => JSON.parse(line.slice(line.indexOf(': ') + 2)))
  }
})
test('reject duplicate keys, missing or stale refs, control text, secrets and mislabeled model reports', () => {
  const source = input(), item = source.items[0]!
  const items = [item, item, { ...item, key: 'stale', sources: [{ ...source.sources[0]!, revision: 'old' }] },
    { ...item, key: 'control', text: 'hello\u0000there' }, { ...item, key: 'unsafe', basis: 'model-report' as const }]
  const view = buildContinuationView({ ...source, items })
  assert.equal(view.items.length, 1)
  assert.equal(view.omittedItems, 4)
  assert.equal(view.coverage, 'partial')
  assert.equal(buildContinuationView({ ...source, sources: [] }).items.length, 0)
  assert.equal(buildContinuationView({ ...source, coverage: 'unavailable' }).items.length, 0)
  assert.throws(() => buildContinuationView({ ...source, owner: { ...source.owner, runId: '\u0000' } }))
  assert.throws(() => buildContinuationView({ ...source, sources: [{ ...source.sources[0]!, key: 'other:evidence' }] }))
})

test('continuity metrics are bounded and allowlisted, never retaining text or caller extensions', () => {
  const observer = new DshEfficiencyObserver(1)
  const value = { mode: 'active' as const, bytes: 512, items: 1, omittedItems: 0, coverage: 'complete' as const, copiesInRequest: 1, privateText: 'must not be stored' }
  observer.recordContinuity(value)
  observer.recordContinuity({ ...value, bytes: -1 })
  assert.equal(observer.snapshot().continuity.length, 1)
  assert.equal('privateText' in observer.snapshot().continuity[0]!, false)
  observer.recordContinuity({ ...value, bytes: 600 })
  assert.equal(observer.snapshot().continuity[0]!.bytes, 600)
})
test('same text with distinct sources or trust labels is not collapsed; next checks are capped at three', () => {
  const source = input(), item = source.items[0]!
  const reportSource = { kind: 'enno-work-result' as const, key: 'run:report', revision: 'report-revision' }
  const view = buildContinuationView({ ...source, sources: [...source.sources, reportSource], items: [item, { ...item, key: 'report', kind: 'reported-result', basis: 'model-report', validity: 'unknown', sources: [reportSource] },
    ...Array.from({ length: 6 }, (_, i) => ({ ...item, key: `check-${i}`, kind: 'next-check' as const }))] })
  const output = renderContinuationView(view, ContinuityConfig.parse({ mode: 'active' }))
  assert.equal(output.items, 5)
  assert.equal(output.omittedItems, 3)
  assert.match(output.text, /model-report; unknown/)
})
test('normal adapter preserves source truth, prioritizes incomplete acquisitions, and discloses bounded coverage', () => {
  const source = input()
  const frame = updateExecutionFrame(undefined, '/project', 'read paths: src/file\ndone when: validate')
  const evidence = Array.from({ length: 32 }, (_, i) => ({ id: String(i), callId: String(i), rootCallId: String(i), turn: 1, generation: 'generation',
    operation: { kind: 'read' as const, paths: ['/project/src/file'], key: String(i), range: { offset: 1, limit: 2 } },
    digest: 'digest', presentation: 'full' as const, acquisition: i === 0 ? 'partial' as const : 'full' as const, toolSucceeded: true }))
  const view = adaptContinuity({ owner: source.owner, frame, evidence, generation: 'generation' })
  assert.equal(view.items[0]!.key, 'run:0')
  assert.equal(view.items[0]!.validity, 'historical')
  assert.equal(view.coverage, 'partial')
  assert.doesNotMatch(JSON.stringify(view.items), /done when/)
  assert.throws(() => adaptContinuity({ owner: { ...source.owner, workspace: '/other' }, frame, evidence, generation: 'generation' }))
  assert.equal(adaptContinuity({ owner: source.owner, evidence: [], generation: 'generation' }).coverage, 'unavailable')
})
