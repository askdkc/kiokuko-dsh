import { canonicalJson } from '../../serialization/validate.js'
import { digest, inductionKind, eligibleAvoidance, independentEpisodes, type Episode } from './contracts.js'

export const REFERENCE_PROMOTION_VERSION = 'reference-promotion-v2'
export type ReferenceLessonKind = 'positive' | 'avoidance'

/** The concise, auditable view derived from one immutable episode manifest. */
export interface ReferenceLesson {
  version: 2
  kind: ReferenceLessonKind
  selectedFromRunId: string
  supportRunIds: string[]
  condition: { applicability: string; anchors: Episode['draft']['anchors']; boundary: string }
  procedure: string
  verification: string
  avoidance?: { trigger: string; avoid: string; alternative: string; verification: string }
  unresolved: Array<{ runId: string; items: string[] }>
  corrections: Array<{ runId: string; description: string; evidenceSeqs: number[] }>
}

function exactText(value: string): string {
  // Keep code identifiers case-sensitive and retain internal whitespace.
  return value.normalize('NFC').trim()
}

function conditionFor(episode: Episode, kind: ReferenceLessonKind): unknown {
  const avoidance = kind === 'avoidance' ? episode.draft.avoidance : null
  return {
    workspace: episode.workspace,
    anchors: Object.fromEntries(Object.entries(episode.draft.anchors).map(([key, value]) => [key, exactText(value)])),
    applicability: exactText(avoidance?.trigger ?? episode.draft.applicability),
    boundary: exactText(episode.draft.boundary),
    ...(avoidance ? { avoid: exactText(avoidance.avoid) } : {}),
  }
}

/** Group only byte-stable conditions; paraphrases and code-case changes stay separate. */
export function referencePromotionSignature(episode: Episode, kind: ReferenceLessonKind): string {
  return digest({ version: REFERENCE_PROMOTION_VERSION, kind, condition: conditionFor(episode, kind) })
}

function methodFor(episode: Episode, kind: ReferenceLessonKind): { procedure: string; verification: string } | undefined {
  if (kind === 'positive') return { procedure: exactText(episode.draft.procedure), verification: exactText(episode.draft.verification) }
  const avoidance = episode.draft.avoidance
  return avoidance ? { procedure: exactText(avoidance.alternative), verification: exactText(avoidance.verification) } : undefined
}

/**
 * Select a complete observed field set from one episode. Conflicting methods
 * under the same conditions are withheld; no cross-episode synthesis occurs.
 */
export function buildReferenceLesson(input: readonly Episode[], kind: ReferenceLessonKind): ReferenceLesson | undefined {
  const episodes = independentEpisodes(input)
  if (!episodes.length || episodes.some(episode => referencePromotionSignature(episode, kind) !== referencePromotionSignature(episodes[0]!, kind))) return undefined
  if (inductionKind(episodes) !== kind) return undefined
  if (kind === 'avoidance' && episodes.some(episode => !eligibleAvoidance(episode))) return undefined

  const methods = new Set(episodes.map(episode => canonicalJson(methodFor(episode, kind))))
  if (methods.size !== 1) return undefined

  const unresolved = episodes.flatMap(episode => episode.draft.unresolved.length
    ? [{ runId: episode.runId, items: [...new Set(episode.draft.unresolved.map(exactText))].sort() }]
    : []).sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0)
  const corrections = episodes.flatMap(episode => episode.draft.events
    .filter(event => event.kind === 'correction')
    .map(event => ({ runId: episode.runId, description: exactText(event.description), evidenceSeqs: [...new Set(event.evidence)].sort((a, b) => a - b) })))
    .sort((left, right) => left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : (left.evidenceSeqs[0] ?? -1) - (right.evidenceSeqs[0] ?? -1))

  const lessonFor = (episode: Episode): ReferenceLesson => {
    const method = methodFor(episode, kind)!
    const avoidance = kind === 'avoidance' ? episode.draft.avoidance : null
    return {
      version: 2,
      kind,
      selectedFromRunId: episode.runId,
      supportRunIds: episodes.map(item => item.runId).sort(),
      condition: { applicability: exactText(avoidance?.trigger ?? episode.draft.applicability),
        anchors: { error: exactText(episode.draft.anchors.error), tool: exactText(episode.draft.anchors.tool),
          target: exactText(episode.draft.anchors.target), version: exactText(episode.draft.anchors.version) },
        boundary: exactText(episode.draft.boundary) },
      procedure: method.procedure,
      verification: method.verification,
      ...(avoidance ? { avoidance: {
        trigger: exactText(avoidance.trigger), avoid: exactText(avoidance.avoid),
        alternative: exactText(avoidance.alternative), verification: exactText(avoidance.verification),
      } } : {}),
      unresolved,
      corrections,
    }
  }
  const selected = [...episodes].map(episode => lessonFor(episode))
    .sort((left, right) => Buffer.byteLength(`${left.kind === 'avoidance' ? 'Avoidance' : 'Lesson'}: ${exactText(episodes.find(item => item.runId === left.selectedFromRunId)!.draft.goal)}\n${renderReferenceLesson(left)}`)
      - Buffer.byteLength(`${right.kind === 'avoidance' ? 'Avoidance' : 'Lesson'}: ${exactText(episodes.find(item => item.runId === right.selectedFromRunId)!.draft.goal)}\n${renderReferenceLesson(right)}`)
      || (left.selectedFromRunId < right.selectedFromRunId ? -1 : left.selectedFromRunId > right.selectedFromRunId ? 1 : 0))[0]!
  return selected
}

export function renderReferenceLesson(lesson: ReferenceLesson): string {
  const anchors = Object.entries(lesson.condition.anchors).map(([name, value]) => `${name}=${value}`).join(', ')
  const sections = [
    `未検証の参照教訓 / Unverified ${lesson.kind} reference`,
    `When: ${lesson.condition.applicability}; ${anchors}`,
    `Do: ${lesson.procedure}`,
    `Verify: ${lesson.verification}`,
    `Not for: ${lesson.condition.boundary}`,
  ]
  if (lesson.avoidance) sections.push(`Avoid: ${lesson.avoidance.avoid}; use: ${lesson.avoidance.alternative}`)
  for (const item of lesson.unresolved) sections.push(`Unresolved (one observation): ${item.items.join('; ')}`)
  for (const correction of lesson.corrections) sections.push(`Observed correction at native seq ${correction.evidenceSeqs.join(',')}: ${correction.description}`)
  sections.push(`Support: ${lesson.supportRunIds.length} independent observations; association is not causal proof.`)
  return sections.join('\n')
}
