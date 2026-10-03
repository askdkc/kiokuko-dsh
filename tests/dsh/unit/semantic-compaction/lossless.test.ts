import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeLosslessCompaction, decodeLosslessCompaction, verifyLosslessCandidate, LOSSLESS_COMPACTION_MARKER, LOSSLESS_COMPACTION_LIMIT } from '../../../../src/dsh/semantic-compaction/lossless.js'
import { history } from '../../helpers/semantic-compaction.js'
import { selectCandidates } from '../../../../src/dsh/semantic-compaction/policy.js'

const source = { callId: 'original-call', eventSeq: 7 }
const random = (() => { let seed = 20261003; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed } })()
test('C1: 10,000 seeded round trips preserve UTF-16, separators, counts, order and unique middles', () => {
  const atoms = ['abc', '日本語', '😀', '\ud800', '\udfff', ' \t', '\u0000', 'boundary']
  for (let index = 0; index < 10_000; index++) {
    const separator = index % 2 ? '\r\n' : '\n'
    const line = `${atoms[random() % atoms.length]}:${random()}${separator}`
    const original = line.repeat(30 + random() % 20) + `unique-${index}-${atoms[index % atoms.length]}${separator}`
      + line.repeat(30 + random() % 20) + (index % 3 ? '' : 'end without newline')
    const encoded = encodeLosslessCompaction(original, source)
    assert.ok(encoded, `generated compressible case ${index}`)
    assert.equal(decodeLosslessCompaction(encoded, source), original)
  }
})

test('C1: 500 malformed or mutated envelopes/messages reject before commit', () => {
  const original = 'first\r\n'.repeat(100) + 'unique middle\n' + 'last😀\n'.repeat(100)
  const encoded = encodeLosslessCompaction(original, source)!
  let commits = 0
  for (let index = 0; index < 500; index++) {
    const envelope = JSON.parse(encoded.slice(LOSSLESS_COMPACTION_MARKER.length + 1))
    const message: any = { id: 'result', role: 'tool', source: { kind: 'tool', callId: source.callId }, toolCallId: source.callId, content: [{ type: 'text', text: original }] }
    const replacement = structuredClone(message)
    switch (index % 12) {
      case 0: envelope.source.callId += '-other'; break
      case 1: envelope.source.eventSeq++; break
      case 2: envelope.sha256Utf16le = '0'.repeat(64); break
      case 3: envelope.codec = 'unknown'; break
      case 4: envelope.codeUnits++; break
      case 5: envelope.runs[0].count++; break
      case 6: envelope.runs.reverse(); break
      case 7: envelope.extra = 'metadata'; break
      case 8: envelope.runs[0].count = Number.MAX_SAFE_INTEGER; break
      case 9: envelope.runs[0].text += 'changed'; break
      case 10: replacement.source.kind = 'user'; break
      case 11: replacement.id = 'another-result'; break
    }
    replacement.content[0].text = `${LOSSLESS_COMPACTION_MARKER}\n${JSON.stringify(envelope)}`
    const candidate: any = { id: 'r7', callId: source.callId, event: { seq: source.eventSeq }, original: message, replacement }
    assert.throws(() => { verifyLosslessCandidate(candidate); commits++ }, `mutation ${index}`)
  }
  assert.equal(commits, 0)
  assert.equal(encodeLosslessCompaction('x'.repeat(LOSSLESS_COMPACTION_LIMIT + 1), source), undefined)
  assert.throws(() => decodeLosslessCompaction(encoded, { ...source, eventSeq: Number.MAX_SAFE_INTEGER }))
})

test('candidate admission pins first/newest six, errors, protected tools, ambiguous IDs and replaced results', () => {
  const meter = { estimateMessage: (message: any) => JSON.stringify(message).length, measure: () => { throw new Error('unused') } }
  const select = (events: ReturnType<typeof history>) => selectCandidates(events, meter, new Map(), undefined, 'laya-coreml')
  assert.equal(select(history('line\n'.repeat(1000))).length, 1)
  assert.equal(select(history('line\n'.repeat(1000), 'task_prepare')).length, 0)
  const error = history(); (error[7]!.data.message.content[0] as any).isError = true; assert.equal(select(error).length, 0)
  const ambiguous = history(); ambiguous[6]!.data.message.content.push({ ...ambiguous[6]!.data.message.content[0] }); assert.equal(select(ambiguous).length, 0)
  const pinned = history(); pinned.splice(0, 3); assert.equal(select(pinned).length, 0)
  const replacement = history(); replacement[7]!.sourceEventSeqs = [7]; assert.equal(select(replacement).length, 0)
})
