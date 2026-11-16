import assert from 'node:assert/strict'
import test from 'node:test'
import { searchRepositoryLearning } from '../../../src/dsh/repository-learning-search.js'
import { selectRepositoryLearning } from '../../../src/dsh/repository-learning-retrieval.js'
import type { RepositoryLearningPoint } from '../../../src/memory/repository-learning.js'

const point = (id: string, keywords: string[]): RepositoryLearningPoint => ({
  id, kind: 'hypothesis', workspace: 'project:a', captureRevision: 0, tags: ['typescript'], keywords,
  lesson: { hypothesis: id, applicability: 'matching feature only', nextAction: 'Inspect current source', verifyWith: 'Run the affected regression', evidenceRefs: ['native:s:1'] },
  evidenceRefs: ['native:s:1'], sessionId: 's', turnId: '1', outcome: 'completed', revision: 1,
  occurrences: 1, reflectionStatus: 'model',
})
const points = [point('resume fix', ['resume', '再開']), point('JSON encoding', ['JSON.parse', 'encoding'])]

async function retrieve(task: string, options: { decisions?: any; timeoutMs?: number } = {}) {
  const signal = new AbortController().signal
  const search = await searchRepositoryLearning({ task, points, signal })
  return selectRepositoryLearning({ task, candidates: search.candidates, signal, requestId: 'request', ...options })
}

test('keywords and tags select relevant stored capsules without a remote dependency', async () => {
  const result = await retrieve('再開すると止まるので修正してください')
  assert.deepEqual(result.points, [points[0]])
  assert.equal(result.source, 'hybrid')
})

test('Akinator can omit a lexical match without granting execution or changing memory', async () => {
  let batch: any
  const decisions = { bind: async () => ({ mode: 'on' }), evaluate: async (_id: string, value: any) => {
    batch = value
    return { status: 'completed', result: { answers: value.questions.map((q: any) => ({ id: q.id, status: 'selected', choiceId: 'omit' })) } }
  } }
  const result = await retrieve('resume fix', { decisions })
  assert.equal(batch.purpose, 'akinator')
  assert.equal(result.source, 'akinator')
  assert.deepEqual(result.points, [])
  assert.equal(points.length, 2)
})

test('an unavailable Akinator is bounded and falls back to reference candidates', async () => {
  const decisions = { bind: async () => ({ mode: 'on' }), evaluate: () => new Promise(() => {}) }
  const result = await retrieve('resume fix', { decisions, timeoutMs: 20 })
  assert.equal(result.source, 'hybrid')
  assert.deepEqual(result.points, [points[0]])
})

test('unrelated requests do not receive every saved repository memory', async () => {
  const result = await retrieve('Change the CSS spacing')
  assert.deepEqual(result.points, [])
})

test('semantic candidates from a Japanese paraphrase still require applicability when Akinator is enabled', async () => {
  const task = '中断した作業を途中から続けたい'
  const embedding = {
    mode: 'optional',
    async embedSearchCorpus(query: string, documents: readonly string[]) {
      assert.equal(query, task)
      assert.match(documents[0]!, /resume fix/)
      return {
        query: { profileId: 'fixture', dimensions: 2, backendId: 'fixture', distanceCeiling: 0.2,
          vector: new Float32Array([1, 0]), vectorHash: 'fixture' },
        documents: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      }
    },
  } as const
  const signal = new AbortController().signal
  assert.deepEqual((await searchRepositoryLearning({ task, points, signal })).candidates, [])
  const search = await searchRepositoryLearning({ task, points, embedding, signal })
  assert.equal(search.semantic, 'available')
  assert.deepEqual(search.candidates.filter(item => item.point === points[0]).map(item => item.point), [points[0]])
  assert.ok(search.candidates.every(item => !item.direct))
  for (const choiceId of ['use', 'omit']) {
    const decisions = { bind: async () => ({ mode: 'on' }), evaluate: async () => ({
      status: 'completed', result: { answers: [{ id: 'memory-0', status: 'selected', choiceId }] },
    }) }
    const selected = await selectRepositoryLearning({ task, candidates: search.candidates, requestId: 'request',
      signal, decisions: decisions as any })
    assert.deepEqual(selected.points, choiceId === 'use' ? [points[0]] : [])
  }
})

test('failed and stalled embedding searches report degradation and return only timely lexical results', async () => {
  const keepAlive = setInterval(() => {}, 1000)
  try {
    for (const status of ['unavailable', 'timeout']) {
      const embedding = {
        mode: 'optional',
        embedSearchCorpus: status === 'unavailable' ? async () => { throw new Error('fixture') } : () => new Promise<never>(() => {}),
      } as const
      const result = await searchRepositoryLearning({ task: 'resume fix', points, embedding,
        signal: new AbortController().signal, semanticTimeoutMs: 20 })
      assert.equal(result.semantic, status)
      assert.deepEqual(result.candidates.filter(item => item.direct).map(item => item.point), [points[0]])
    }
  } finally { clearInterval(keepAlive) }
})
