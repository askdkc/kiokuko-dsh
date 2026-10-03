import test from 'node:test'
import assert from 'node:assert/strict'
import { captureCompactionArm } from '../../../../scripts/laya-compaction-native.mjs'
import { decisions } from '../../helpers/semantic-compaction.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'

test('evaluation O/D/L preserve identical native tools, route and complete pending constraints', async () => {
  const fixture = { id: 'comparison', family: 'comparison', language: 'en' as const,
    task: 'Count the original log lines', body: 'record\r\n'.repeat(1400), tool: 'read', constraints: 'Do not deploy; preserve order.' }
  const rows = []
  for (const arm of ['original', 'deterministic', 'laya'] as const) {
    const d = decisions({ decisionConfig: TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': {
      model: 'aac6fef/laya-multilingual-coreml', runtimeFingerprint: `sha256:${'a'.repeat(64)}`, compaction: { mode: arm === 'laya' ? 'shadow' : 'off' },
    } }), preflight: async () => undefined, evaluate: async batch => ({ provider: 'fixture', requestedModel: 'fixture', policyVersion: 'fixture',
      answers: batch.questions.map(q => ({ id: q.id, status: 'selected', choiceId: q.id === 'fruit' ? 'apple' : 'lossless' })) }) })
    rows.push(await captureCompactionArm(fixture, arm, d.service, AbortSignal.timeout(30_000)))
  }
  const [original, deterministic, laya] = rows
  assert.ok(rows.every(row => row.originalHistoryIntact))
  assert.ok(rows.every(row => row.requests.length === 1))
  for (const row of rows) {
    const request = row.requests[0] as any
    assert.deepEqual(request.tools, (original!.requests[0] as any).tools)
    assert.equal(request.model, (original!.requests[0] as any).model)
    assert.ok(JSON.stringify(request.messages).includes(fixture.constraints))
  }
  assert.ok(deterministic!.requestBytes[0]! < original!.requestBytes[0]! * .8)
  assert.equal(laya!.requestBytes[0], original!.requestBytes[0], 'shadow forwards the same complete request')
  assert.equal(laya!.requestNativeEstimated[0], original!.requestNativeEstimated[0])
  assert.equal(laya!.appendedEvents.some((e: any) => e.type === 'compaction/prune'), false)
})
