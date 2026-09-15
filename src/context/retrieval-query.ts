import { boundTaskRetrievalQuery } from '../memory/retrieval-query.js'
import type { ScopedContextQuery } from './scoped-broker.js'

/** One bounded lexical/semantic query. Active focus reserves the front for new evidence. */
export function renderScopedRetrievalQuery(query: ScopedContextQuery): string {
  const original = [query.task, query.taskProfile.taskType ?? '', query.taskProfile.target ?? '',
    query.taskProfile.expected ?? '', query.taskProfile.constraints ?? '', ...(query.recommendedTags ?? [])]
  return boundTaskRetrievalQuery((query.focus === undefined
    ? [...original, ...(query.changedPaths ?? []), ...(query.errorSignatures ?? [])]
    : [...(query.errorSignatures ?? []), ...(query.changedPaths ?? []), ...query.focus.identifiers,
      query.focus.objective ?? '', query.focus.constraints, ...original]).join('\n'))
}
