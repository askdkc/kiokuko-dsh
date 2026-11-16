import { openConnection } from '../db/connection.js'
import { migrateDatabase } from '../db/migrate.js'
import { withImmediateTransaction } from '../db/transaction.js'
import type { RepositoryLearningEmbeddingSource } from './repository-learning-embedding.js'
import type { EmbeddingRuntime } from '../embedding/types.js'
import { abortable } from './http-json.js'
import { cosineDistance } from '../embedding/vector.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { recordEntryInTransaction } from '../memory/entries.js'
import { hybridSearch, type HybridSearchRuntime } from '../memory/hybrid-retrieval.js'
import type { RepositoryLearningPoint } from '../memory/repository-learning.js'
import { boundTaskRetrievalQuery, normalizeSearchSignal, parseRetrievalQuery } from '../memory/retrieval-query.js'
import { MemoryRetrievalConfig } from '../memory/retrieval-contracts.js'

export type RepositorySemanticSearch = 'available' | 'disabled' | 'unavailable' | 'timeout'

function searchText(point: RepositoryLearningPoint): string {
  const lesson = point.lesson
  return lesson ? [lesson.hypothesis, lesson.applicability, lesson.nextAction, lesson.verifyWith].join('\n') : point.summary!
}

const common = new Set(['the', 'this', 'that', 'and', 'for', 'with', 'please', 'change', 'fix'])
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' })

function searchTerms(text: string): Set<string> {
  return new Set([...segmenter.segment(normalizeSearchSignal(text))]
    .filter(item => item.isWordLike && item.segment.length >= 2 && !common.has(item.segment))
    .map(item => item.segment))
}

function isDirectMatch(point: RepositoryLearningPoint, terms: Set<string>, task: string): boolean {
  const metadata = [...point.tags, ...(point.keywords ?? [])].map(normalizeSearchSignal)
  const text = searchTerms(searchText(point))
  return metadata.some(tag => tag.length >= 2 && !common.has(tag) && (terms.has(tag) || task.includes(tag)))
    || [...terms].some(term => text.has(term))
}

type EmbeddedCorpus = NonNullable<Awaited<ReturnType<NonNullable<EmbeddingRuntime['embedSearchCorpus']>>>>

function semanticProjection(corpus: EmbeddedCorpus, ids: readonly string[]): HybridSearchRuntime['semantic'] {
  if (corpus.documents.length !== ids.length) throw new Error('repository_learning_embedding_count_mismatch')
  return {
    query: corpus.query,
    backend: {
      id: corpus.query.backendId,
      search: (_db, input) => ids.map((entryId, index) => ({
        entryId, distance: cosineDistance(input.queryVector, corpus.documents[index]!),
      })).filter(hit => hit.distance <= input.distanceCeiling)
        .sort((a, b) => a.distance - b.distance || (a.entryId < b.entryId ? -1 : 1))
        .slice(0, input.limit),
    },
  }
}

/** Disposable SQLite projection. The only source is the currently authorized ledger view. */
export async function searchRepositoryLearning(input: {
  task: string
  points: readonly RepositoryLearningPoint[]
  embedding?: RepositoryLearningEmbeddingSource | undefined
  signal: AbortSignal
  semanticTimeoutMs?: number
}): Promise<{
  candidates: { point: RepositoryLearningPoint; direct: boolean }[]
  semantic: RepositorySemanticSearch
}> {
  const { points, signal } = input
  const task = input.task.trim().slice(0, 4000)
  let semantic: RepositorySemanticSearch = input.embedding?.mode === 'off' || !input.embedding ? 'disabled' : 'unavailable'
  if (!task || !points.length) return { candidates: [], semantic }
  signal.throwIfAborted();
  const normalized = parseRetrievalQuery(task)
  const terms = searchTerms(task)
  for (const signal of normalized.exactSignals) terms.add(signal.normalizedValue)
  // Include dictionary words such as 再開, which can be shorter than a
  // trigram and attached directly to a Japanese particle.
  const japanese = [...terms].filter(term => /[\p{Script=Han}\p{Script=Katakana}]/u.test(term)).slice(0, 12)
  const query = boundTaskRetrievalQuery([task, ...japanese].join(' '))
  const ids = points.map(point => point.id ?? canonicalContentHash([point.workspace, point.sessionId, point.turnId]))
  const byId = new Map(ids.map((id, index) => [id, points[index]!]))
  const texts = points.map(searchText)
  const db = openConnection(':memory:')
  try {
    migrateDatabase(db)
    const workspace = points[0]!.workspace
    withImmediateTransaction(db, () => {
      for (const [index, point] of points.entries()) {
        if (point.workspace !== workspace) throw new Error('repository_learning_search_scope_mismatch')
        recordEntryInTransaction(db, {
          workspace, trustLevel: 'untrusted', kind: point.lesson ? 'lesson' : 'reference',
          title: point.lesson?.hypothesis ?? texts[index]!,
          body: texts[index]!,
          tags: [...new Set([...point.tags, ...(point.keywords ?? [])])],
          provenance: { type: 'repository-learning', reference: ids[index]! },
          // FTS ties prefer the most recently updated evidence.
        }, { idFactory: () => ids[index]!, now: new Date(point.revision).toISOString() })
      }
    })
    let vectors: HybridSearchRuntime['semantic']
    if (input.embedding?.mode !== 'off' && input.embedding?.embedSearchCorpus) {
      const timeoutMs = input.semanticTimeoutMs ?? 1000
      const deadline = performance.now() + timeoutMs
      const timeout = AbortSignal.timeout(timeoutMs)
      const embeddingSignal = AbortSignal.any([signal, timeout])
      try {
        const corpus = await abortable(input.embedding.embedSearchCorpus(
          task, texts, embeddingSignal), embeddingSignal)
        if (timeout.aborted || performance.now() >= deadline) semantic = 'timeout'
        else if (corpus) {
          vectors = semanticProjection(corpus, ids)
          semantic = 'available'
        }
      } catch {
        semantic = timeout.aborted || performance.now() >= deadline ? 'timeout' : 'unavailable'
      }
    }
    signal.throwIfAborted()
    const hits = hybridSearch(db, { workspace, query, limit: 4 }, {
      memoryRetrieval: MemoryRetrievalConfig.parse({ mode: 'active' }),
      ...(vectors ? { semantic: vectors } : {}),
    })
    return {
      semantic,
      candidates: hits.flatMap(hit => {
        const point = byId.get(hit.entryId)!
        const direct = isDirectMatch(point, terms, normalized.normalized.toLowerCase())
          || hit.laneRanks['exact-signal'] !== undefined
        // Broad substring hits alone are insufficient; semantic and related
        // candidates can still be evaluated by the applicability judge.
        if (!direct && hit.laneRanks.semantic === undefined && hit.laneRanks.related === undefined) return []
        return [{ point, direct }]
      }).slice(0, 4),
    }
  } finally {
    db.close()
  }
}
