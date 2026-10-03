import type { CapabilityDescriptor, CapabilityResolution } from '../../akinator/capabilities.js'
import { canonicalContentHash, compareCanonicalStrings } from '../../serialization/validate.js'
import type { DecisionBatch } from './contracts.js'
import type { DecisionService } from './service.js'

/** A host-side work budget, not a tokenizer estimate or an assurance about a v1 worker. */
export const LAYA_SKILL_INPUT_BYTES = 6000
export const LAYA_SKILL_SHORTLIST_POLICY = 'laya-skill-shortlist-v2'

/** Concrete alternatives fit Laya's finite-choice training; relevance never grants execution permission. */
export function layaSkillShortlistBatch(task: string, skills: readonly CapabilityDescriptor[]): DecisionBatch {
  return { purpose: 'skills', state: task,
    questions: [{ id: 'select-skill', instructions: 'Which of these skills best matches the task?',
      choices: [...skills.map((skill, index) => ({ id: `skill-${index}`, description: skill.description ? `${skill.name}: ${skill.description}` : skill.name })),
        { id: 'none', description: 'None of these skills is relevant.' }, { id: 'abstain', description: 'Cannot determine.' }], abstainId: 'abstain' }] }
}

async function selectLayaSkills(service: DecisionService, requestId: string, task: string, shortlist: readonly CapabilityDescriptor[], baseline: ReadonlySet<string>, mandatory: readonly string[], catalogDigest: string, signal: AbortSignal): Promise<readonly string[]> {
  // At most one model-selected optional Skill; unassessed baseline recommendations are retained. Removing a winner and asking again can force false positives.
  // Full descriptions stay in concrete Choice alternatives; long options are never clipped.
  const pool: CapabilityDescriptor[] = []
  for (const skill of shortlist) {
    if (pool.length === 4) break
    if (Buffer.byteLength(JSON.stringify(layaSkillShortlistBatch(task, [...pool, skill]))) <= LAYA_SKILL_INPUT_BYTES) pool.push(skill)
  }
  const fallback = () => [...new Set([...mandatory, ...shortlist.filter(skill => baseline.has(skill.name)).slice(0, 5).map(skill => skill.name)])]
  if (!pool.length) return fallback()
  const outcome = await service.evaluate(requestId, layaSkillShortlistBatch(task, pool), signal, canonicalContentHash({ catalogDigest, policy: LAYA_SKILL_SHORTLIST_POLICY }))
  if (outcome.status !== 'completed') return fallback()
  const answer = outcome.result.answers[0]
  const assessed = new Set(pool.map(skill => skill.name))
  const unassessed = shortlist.filter(skill => baseline.has(skill.name) && !assessed.has(skill.name)).map(skill => skill.name)
  // Abstention means no optional injection from this assessed pool, not a claim of irrelevance.
  // Reinjecting its noisy similarity baseline would defeat the purpose of model selection.
  if (answer?.status !== 'selected' || answer.choiceId === 'none') return [...new Set([...mandatory, ...unassessed.slice(0, 5)])]
  const selected = pool.find((_skill, index) => answer.choiceId === `skill-${index}`)
  return selected ? [...new Set([...mandatory, ...[selected.name, ...unassessed].slice(0, 5)])] : fallback()
}

function tokens(text: string): Set<string> {
  const normalized = text.toLowerCase(), words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(words.flatMap(word => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word) ? [...word].slice(1).map((c, i) => `${word[i]}${c}`) : [word]))
}
/** Preserve policy recommendations; rank only installed optional Skills, never external references. */
export async function selectInstalledSkills(service: DecisionService | undefined, requestId: string, task: string, catalog: readonly CapabilityDescriptor[], resolution: CapabilityResolution, signal: AbortSignal): Promise<readonly string[]> {
  const skills = catalog.filter(c => c.kind === 'skill'), installed = new Set(skills.map(c => c.name))
  const mandatory = resolution.recommendations.filter(r => r.kind === 'skill' && (r.source === 'akinator_policy' || r.required === true) && installed.has(r.name)).map(r => r.name)
  const baseline = new Set(resolution.recommendations.filter(r => r.kind === 'skill' && r.source === 'catalog_similarity' && installed.has(r.name)).map(r => r.name))
  const query = tokens(task)
  const shortlist = skills.filter(s => !mandatory.includes(s.name)).map(s => ({ skill: s, score: [...tokens(`${s.name} ${s.description ?? ''}`)].filter(t => query.has(t)).length }))
    .sort((a, b) => b.score - a.score || compareCanonicalStrings(a.skill.name, b.skill.name)).slice(0, 32)
  const baselineNames = shortlist.filter(s => baseline.has(s.skill.name)).slice(0, 5).map(s => s.skill.name)
  if (!service || !shortlist.length) return [...new Set([...mandatory, ...baselineNames])]
  const configuration = await service.bind(requestId, signal)
  const selection = configuration.skillSelection
  if (selection?.mode === 'score') {
    const criteria = ['Not applicable', 'Related but not materially useful', 'Materially applicable', 'Directly and strongly applicable']
    const outcome = await service.evaluate(requestId, { purpose: 'skills', state: { task },
      questions: shortlist.map(({ skill }, index) => ({ id: `skill-${index}`, type: 'score',
        instructions: `How materially does this installed Skill apply to the request?\n${JSON.stringify(skill)}`, criteria })) }, signal, canonicalContentHash(catalog))
    if (outcome.status === 'fallback') return [...new Set([...mandatory, ...baselineNames])]
    const accepted: { name: string; score: number }[] = [], uncertain = new Set<string>()
    for (const [index, { skill }] of shortlist.entries()) {
      const answer = outcome.result.answers[index]
      if (answer?.status === 'measured' && answer.type === 'score') {
        if (answer.confidence < selection.minConfidence) uncertain.add(skill.name)
        else if (answer.score >= selection.minScore) accepted.push({ name: skill.name, score: answer.score })
      } else uncertain.add(skill.name)
    }
    accepted.sort((a, b) => b.score - a.score || compareCanonicalStrings(a.name, b.name))
    const ranked = accepted.map(s => s.name)
    return [...new Set([...mandatory, ...[...ranked, ...baselineNames.filter(name => uncertain.has(name))].slice(0, 5)])]
  }
  if (configuration.provider === 'laya-coreml') return selectLayaSkills(service, requestId, task, shortlist.map(item => item.skill), baseline, mandatory, canonicalContentHash(catalog), signal)
  const questions = shortlist.map(({ skill }, index) => ({ id: `skill-${index}`, instructions: `Does this installed Skill materially apply to the request?\n${JSON.stringify(skill)}`,
    choices: [{ id: 'yes', description: 'Applicable' }, { id: 'no', description: 'Not applicable' }, { id: 'abstain', description: 'Insufficient evidence' }], abstainId: 'abstain' }))
  const outcome = await service.evaluate(requestId, { purpose: 'skills', state: { task }, questions }, signal, canonicalContentHash(catalog))
  const answers = new Map(outcome.status === 'completed' ? outcome.result.answers.map(answer => [answer.id, answer]) : [])
  const selected = shortlist.filter(({ skill }, index) => {
    const answer = answers.get(`skill-${index}`)
    return answer?.status === 'selected' ? answer.choiceId === 'yes' : baseline.has(skill.name)
  }).slice(0, 5).map(item => item.skill.name)
  return [...new Set([...mandatory, ...selected])]
}
