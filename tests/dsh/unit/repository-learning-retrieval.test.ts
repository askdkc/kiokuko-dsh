import assert from 'node:assert/strict'
import test from 'node:test'
import { selectRepositoryLearning } from '../../../src/dsh/repository-learning-retrieval.js'
import type { RepositoryLearningPoint } from '../../../src/memory/repository-learning.js'

const point = (id: string, keywords: string[]): RepositoryLearningPoint => ({
  id, kind: 'hypothesis', workspace: 'project:a', captureRevision: 0, tags: ['typescript'], keywords,
  lesson: { hypothesis: id, applicability: 'matching feature only', nextAction: 'Inspect current source', verifyWith: 'Run the affected regression', evidenceRefs: ['native:s:1'] },
  evidenceRefs: ['native:s:1'], sessionId: 's', turnId: '1', outcome: 'completed', revision: 1,
  occurrences: 1, reflectionStatus: 'model',
})
const points = [point('resume fix', ['resume', '再開']), point('JSON encoding', ['JSON.parse', 'encoding'])]

test('keywords and tags select relevant stored capsules without a remote dependency', async () => {
  const result = await selectRepositoryLearning({ task: '再開すると止まるので修正してください', points, requestId: 'request', signal: new AbortController().signal })
  assert.deepEqual(result.points, [points[0]])
  assert.equal(result.source, 'keywords')
})

test('Akinator can omit a lexical match without granting execution or changing memory', async () => {
  let batch: any
  const decisions = { bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, value: any) => {
    batch = value
    return { status: 'completed', result: { answers: value.questions.map((q: any) => ({ id: q.id, status: 'selected', choiceId: 'omit' })) } }
  } }
  const result = await selectRepositoryLearning({ task: 'resume fix', points, requestId: 'request', signal: new AbortController().signal, decisions: decisions as any })
  assert.equal(batch.purpose, 'akinator')
  assert.equal(result.source, 'akinator')
  assert.deepEqual(result.points, [])
  assert.equal(points.length, 2)
})

test('an unavailable Akinator is bounded and falls back to reference candidates', async () => {
  const decisions = { bind: async () => ({ mode: 'on' }), evaluate: () => new Promise(() => {}) }
  const result = await selectRepositoryLearning({ task: 'resume fix', points, requestId: 'request', signal: new AbortController().signal, decisions: decisions as any, timeoutMs: 20 })
  assert.equal(result.source, 'keywords')
  assert.deepEqual(result.points, [points[0]])
})

test('unrelated requests do not receive every saved repository memory', async () => {
  const result = await selectRepositoryLearning({ task: 'Change the CSS spacing', points, requestId: 'request', signal: new AbortController().signal })
  assert.deepEqual(result.points, [])
})
