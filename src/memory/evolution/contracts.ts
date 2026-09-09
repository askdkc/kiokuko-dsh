// Independent implementation; design reference: MemTensor/memmy-agent @ 98146714aad8569a298cf8692946da8bb28bf7cb.
// No upstream code/prompts copied. See docs/memory-evolution.md for scope and attribution.
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { canonicalJson } from '../../serialization/validate.js'
import { findSecret } from '../secrets.js'

export const EVOLUTION_VERSION = 'episode-evolution-v1'
export const MemoryEvolutionConfig = z.object({
  mode: z.enum(['active', 'observe', 'off']).default('active'),
  dailyCalls: z.number().int().min(1).max(8).default(8),
  maxInputBytes: z.number().int().min(1024).max(32768).default(32768),
  maxOutputTokens: z.number().int().min(128).max(2048).default(2048),
  timeoutMs: z.number().int().min(100).max(60000).default(60000),
}).strict()
export type EvolutionConfig = z.output<typeof MemoryEvolutionConfig>
export type EvolutionMode = EvolutionConfig['mode']
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const normalize = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()

const text = z.string().trim().min(1).max(2000).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s.replace(/\n|\r|\t/g, '')) && !findSecret(s), 'Unsafe evolution text')
const short = text.pipe(z.string().max(200))
const refs = z.array(z.number().int().nonnegative()).min(1).max(8)
export const EpisodeDraftSchema = z.object({
  goal: text,
  applicability: text,
  anchors: z.object({ error: short, tool: short, target: short, version: short }).strict(),
  events: z.array(z.object({
    kind: z.enum(['decision', 'failure', 'action', 'verification', 'correction']),
    description: text,
    evidence: refs,
  }).strict()).max(6),
  procedure: text,
  verification: text,
  boundary: text,
  unresolved: z.array(text).max(6),
  avoidance: z.object({ trigger: text, avoid: text, alternative: text, verification: text, evidence: refs }).strict().nullable(),
}).strict()
export type EpisodeDraft = z.infer<typeof EpisodeDraftSchema>
export interface EpisodeEvidence {
  seq: number
  kind: 'user' | 'action' | 'result'
  text: string
  outcome: 'passed' | 'failed' | 'unknown'
}
export type EpisodeEvidenceRef = Omit<EpisodeEvidence, 'text'> & { contentHash: string }
export const evidenceReferences = (evidence: readonly EpisodeEvidence[]): EpisodeEvidenceRef[] => evidence.map(({ text, ...ref }) => ({ ...ref, contentHash: digest(normalize(text)) }))
export interface Episode {
  runId: string
  workspace: string
  sessionId: string
  start: number
  end: number
  logDigest: string
  evidenceDigest: string
  signature: string
  outcome: 'completed' | 'failed'
  draft: EpisodeDraft
  evidence: EpisodeEvidenceRef[]
  sources: Array<{ entryId: string; revision: number; hash: string }>
  successful: boolean
  procedureSupported: boolean
  failed: boolean
  corrective: boolean
  alternativeObserved: boolean
  recovered: boolean
}
export const LessonDraftSchema = z.object({
  applicability: text, procedure: text, verification: text, boundary: text,
  // References are validated against the exact bounded input, never fabricated IDs.
  evidence: z.array(z.string().min(1).max(256)).min(1).max(6),
  conflict: z.boolean(),
}).strict()
export type LessonDraft = z.infer<typeof LessonDraftSchema>

/** Validate evidence type and membership; this does not assert semantic entailment. */
export function parseEpisodeDraft(value: unknown, evidence: readonly EpisodeEvidence[]): EpisodeDraft {
  const parsed = EpisodeDraftSchema.parse(value)
  const bySeq = new Map(evidence.map(e => [e.seq, e]))
  for (const event of parsed.events) {
    if (event.evidence.some(seq => !bySeq.has(seq))) throw new Error('episode_unknown_evidence')
    const sources = event.evidence.map(seq => bySeq.get(seq)!)
    if (event.kind === 'verification' && !sources.some(e => e.kind === 'result')) throw new Error('episode_unobserved_verification')
    if (event.kind === 'failure' && !sources.some(e => e.outcome === 'failed')) throw new Error('episode_unobserved_failure')
    if (event.kind === 'correction' && !sources.some(e => e.kind === 'user')) throw new Error('episode_unobserved_correction')
    if (event.kind === 'action' && !sources.some(e => e.kind === 'action')) throw new Error('episode_unobserved_action')
  }
  if (parsed.avoidance?.evidence.some(seq => !bySeq.has(seq))) throw new Error('episode_unknown_evidence')
  // Exact anchors must occur in presented native evidence. "unknown" never groups.
  const source = normalize(evidence.map(e => e.text).join('\n'))
  if (Object.values(parsed.anchors).some(a => normalize(a) !== 'unknown' && !source.includes(normalize(a)))) throw new Error('episode_ungrounded_anchor')
  return parsed
}

export function episodeSignals(draft: EpisodeDraft, evidence: readonly EpisodeEvidence[]): Pick<Episode, 'successful' | 'procedureSupported' | 'failed' | 'corrective' | 'alternativeObserved' | 'recovered'> {
  const bySeq = new Map(evidence.map(e => [e.seq, e]))
  const actionSeqs = draft.events.filter(e => e.kind === 'action').flatMap(e => e.evidence)
  const successful = draft.events.some(e => e.kind === 'verification' && e.evidence.some(seq =>
    bySeq.get(seq)?.outcome === 'passed' && actionSeqs.some(action => action < seq)))
  const procedureSupported = evidence.some(action => action.kind === 'action' && actionSeqs.includes(action.seq) && normalize(action.text).includes(normalize(draft.procedure)) &&
    draft.events.some(item => item.kind === 'verification' && item.evidence.some(seq => seq > action.seq && bySeq.get(seq)?.outcome === 'passed')))
  const failed = draft.events.some(e => e.kind === 'failure')
  const corrective = draft.events.some(e => e.kind === 'correction')
  const a = draft.avoidance
  const alternatives = a ? evidence.filter(item => a.evidence.includes(item.seq) && normalize(item.text).includes(normalize(a.alternative))) : []
  const correctiveEvidence = draft.events.filter(item => item.kind === 'correction').flatMap(item => item.evidence)
  const alternativeObserved = alternatives.some(item => item.kind === 'action' || item.kind === 'user' && correctiveEvidence.includes(item.seq))
  const failures = draft.events.filter(item => item.kind === 'failure').flatMap(item => item.evidence)
  const recovered = alternatives.some(action => action.kind === 'action' && failures.some(seq => seq < action.seq) &&
    draft.events.some(item => item.kind === 'verification' && item.evidence.some(seq => seq > action.seq && bySeq.get(seq)?.outcome === 'passed')))
  return { successful, procedureSupported, failed, corrective, alternativeObserved, recovered }
}

export function supportingEvidenceDigest(draft: EpisodeDraft, evidence: readonly EpisodeEvidence[]): string {
  const refs = new Set([...draft.events.filter(e => e.kind !== 'decision').flatMap(e => e.evidence), ...(draft.avoidance?.evidence ?? [])])
  const corrections = new Set(draft.events.filter(e => e.kind === 'correction').flatMap(e => e.evidence))
  return digest([...new Set(evidence.filter(e => refs.has(e.seq) && (e.kind !== 'user' || corrections.has(e.seq))).map(e => canonicalJson({ kind: e.kind, text: normalize(e.text), outcome: e.outcome })))].sort())
}

export function episodeSignature(workspace: string, draft: EpisodeDraft): string {
  return digest({ workspace, anchors: Object.fromEntries(Object.entries(draft.anchors).map(([k, v]) => [k, normalize(v)])) })
}

/** Replays and overlapping ranges never become independent support. */
export function independentEpisodes(input: readonly Episode[]): Episode[] {
  const selected: Episode[] = []
  for (const e of [...input].sort((a, b) => a.runId.localeCompare(b.runId))) {
    if (selected.some(p => p.runId === e.runId || p.evidenceDigest === e.evidenceDigest ||
      p.sessionId === e.sessionId && p.start <= e.end && e.start <= p.end)) continue
    selected.push(e)
  }
  return selected
}

const generic = /^(?:be careful|verify more|avoid assumptions|do better|気を[つ付]ける|もっと確認する|注意する|小心一点|多验证)[。.!！]?$/iu
export function eligibleAvoidance(e: Episode): boolean {
  const a = e.draft.avoidance
  if (!a || [a.trigger, a.avoid, a.alternative, a.verification].some(s => generic.test(s)) || normalize(a.avoid) === normalize(a.alternative)) return false
  if (!e.alternativeObserved) return false
  return e.failed || e.corrective
}

export function inductionKind(episodes: readonly Episode[]): 'positive' | 'avoidance' | undefined {
  if (!episodes.length || episodes.some(e => e.workspace !== episodes[0]!.workspace || e.signature !== episodes[0]!.signature)) return undefined
  if (episodes.some(e => Object.values(e.draft.anchors).some(a => normalize(a) === 'unknown'))) return undefined
  const independent = independentEpisodes(episodes)
  if (independent.some(e => eligibleAvoidance(e) && (e.corrective || e.failed && e.recovered && e.successful)) ||
    independent.filter(e => eligibleAvoidance(e) && e.failed).length >= 2) return 'avoidance'
  if (independent.length >= 3 && independent.filter(e => e.successful && e.procedureSupported).length >= 2) return 'positive'
  return undefined
}
