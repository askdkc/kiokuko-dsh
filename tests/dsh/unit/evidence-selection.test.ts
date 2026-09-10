import test from 'node:test'
import assert from 'node:assert/strict'
import { reduceDshFinalizationLog, type DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import { episodeSignals, type EpisodeEvidence } from '../../../src/memory/evolution/contracts.js'
import { draft } from '../integration/evolution/fixture.js'

async function* stream(events: DshLogEvent[]) { yield* events }
const event = (seq: number, type: string, data: unknown): DshLogEvent => ({ seq, time: seq, type, data })
const header = event(1, 'request/header', { header: { config: { provider: 'fixture', model: 'fixture' } } })
function logs(body = 'SQLITE_BUSY repair'): DshLogEvent[] {
  return [header, event(2, 'request/context', { contextWindow: 100000 }), event(3, 'turn/start', {}),
    event(4, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Latest requested repair' }] }),
    event(5, 'tool/call', { callId: 'a', name: 'verify', arguments: body }),
    ...Array.from({ length: 80 }, (_, i) => event(6 + i, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `Follow-up constraint ${i}` }] })),
    event(86, 'tool/result', { exitCode: 0, message: { source: { callId: 'a' }, content: [{ type: 'text', text: 'Repair verified' }] } }),
    event(87, 'turn/end', {})]
}

for (const mode of ['prefix_reuse', 'bounded_evidence'] as const) test(`v2 ${mode} keeps distant action/result together within both limits`, async () => {
  const events = logs()
  const current = await reduceDshFinalizationLog(stream(events), 3, 87, mode, undefined, 2)
  const legacy = await reduceDshFinalizationLog(stream(events), 3, 87, mode, undefined, 1)
  assert.equal(current.digest, legacy.digest, 'selection never changes the full source digest')
  const evidence = current.episodeEvidence!
  assert.ok(evidence.length <= 64); assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 24000)
  assert.ok(evidence.some(item => item.seq === 85))
  assert.ok(evidence.some(item => item.seq === 5))
  const result = evidence.find(item => item.seq === 86)!
  assert.equal(result.actionSeq, 5); assert.equal(result.callId, 'a'); assert.match(result.resultHash!, /^[a-f0-9]{64}$/u)
  assert.ok(!legacy.episodeEvidence!.some(item => item.seq === 5))
  if (mode === 'bounded_evidence') { assert.ok(current.boundedEvidence!.includes('seq=5')); assert.ok(current.boundedEvidence!.includes('seq=86')); assert.ok(Buffer.byteLength(current.boundedEvidence!) <= 65536) }
})

test('an oversized action cannot leave an orphaned success in bounded evidence', async () => {
  const reduced = await reduceDshFinalizationLog(stream(logs('x'.repeat(70000))), 3, 87, 'bounded_evidence', undefined, 2)
  assert.ok(!reduced.episodeEvidence!.some(item => item.outcome === 'passed'))
  assert.ok(!reduced.boundedEvidence!.includes('Repair verified'))
})

test('a different call cannot verify the chosen action or imply causal recovery', () => {
  const d = draft()
  const evidence: EpisodeEvidence[] = [
    { seq: 2, kind: 'result', text: 'failed', outcome: 'failed', selectionVersion: 2 },
    { seq: 3, kind: 'action', text: d.procedure, outcome: 'unknown', selectionVersion: 2, callId: 'chosen' },
    { seq: 4, kind: 'result', text: d.verification, outcome: 'passed', selectionVersion: 2, callId: 'other', actionSeq: 3, resultHash: 'a'.repeat(64) },
  ]
  assert.equal(episodeSignals(d, evidence).successful, false)
  assert.equal(episodeSignals(d, evidence).procedureSupported, false)
  evidence[2]!.callId = 'chosen'
  assert.equal(episodeSignals(d, evidence).successful, true)
  assert.equal(episodeSignals(d, evidence).recovered, false)
})
