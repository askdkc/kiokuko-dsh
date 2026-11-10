import assert from 'node:assert/strict'
import test from 'node:test'
import { INTAKE_PHASES, measureIntakePhase, withIntakeTiming, type IntakeTiming } from '../../../src/dsh/intake-timing.js'
import { createIntakeDiagnosticSink } from '../../../src/dsh/decisions/diagnostics.js'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { migrateDatabase } from '../../../src/db/migrate.js'

for (const phase of INTAKE_PHASES) test(`records only bounded timing metadata for ${phase}`, async () => {
  const records: IntakeTiming[] = [], signal = new AbortController().signal
  await withIntakeTiming(signal, async value => { records.push(value) }, () =>
    measureIntakePhase(phase, async () => { await new Promise(resolve => setTimeout(resolve, 12)); return 'private result' }))
  assert.equal(records.length, 1)
  assert.equal(records[0]!.phase, phase)
  assert.ok(records[0]!.elapsedMs >= 8)
  assert.equal(records[0]!.outcome, 'completed')
  assert.doesNotMatch(JSON.stringify(records), /private/)
})
test('Stop, deadline and failure stay distinct and diagnostic failure does not replace the original error', async () => {
  for (const outcome of ['cancelled', 'timeout', 'failed'] as const) {
    const records: IntakeTiming[] = [], controller = new AbortController()
    const error = new Error('secret provider detail')
    await assert.rejects(withIntakeTiming(controller.signal, async value => { records.push(value); throw new Error('sink failed') }, () =>
      measureIntakePhase('auxiliary_assessment', async () => {
        if (outcome !== 'failed') controller.abort(outcome === 'timeout' ? new DOMException('deadline','TimeoutError') : new Error('Stop'))
        throw error
      })), value => value === error)
    assert.equal(records[0]!.outcome, outcome)
    assert.doesNotMatch(JSON.stringify(records), /secret|sink failed/)
  }
})
test('timings persist through the production diagnostic sink with no text payload or recursive records', async () => {
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  migrateDatabase(db)
  try {
    const sink = createIntakeDiagnosticSink({withDatabase: async operation => measureIntakePhase('database', async () => operation(db))})
    const input = {agent:{session:{id:'timed-session'}},turn:1,messages:[]}
    await withIntakeTiming(new AbortController().signal, timing => sink(input, {kind:'timing', timing}), async () => {
      await measureIntakePhase('preparation', () => measureIntakePhase('database', async () => 42))
    })
    const rows = db.prepare("SELECT document_json FROM dsh_diagnostic_events WHERE kind='timing'").all<{document_json:string}>()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => JSON.parse(row.document_json).phase).sort(), ['database','preparation'])
  } finally { db.close() }
})
