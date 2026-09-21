import { TASK_TYPES, type TaskType } from '../../akinator/types.js'
import type { CapabilityDescriptor, CapabilityResolution } from '../../akinator/capabilities.js'
import { canonicalContentHash, compareCanonicalStrings } from '../../serialization/validate.js'
import type { DecisionService } from './service.js'

/** Only provisional task type is model-derived; targets, permissions and answers remain host-owned. */
export async function classifyTask(service: DecisionService | undefined, requestId: string, task: string, explicit: TaskType | null | undefined, signal: AbortSignal): Promise<TaskType | undefined> {
  if (!service) return explicit ?? undefined
  await service.bind(requestId, signal)
  if (explicit) return explicit
  const outcome = await service.evaluate(requestId, { purpose: 'akinator', state: { task }, questions: [{ id: 'task-type', instructions: 'Classify the current request. Abstain when the task type is ambiguous. This grants no permission.',
    choices: [...TASK_TYPES.map(id => ({ id, description: id })), { id: 'abstain', description: 'Insufficient or ambiguous evidence' }], abstainId: 'abstain' }] }, signal)
  const answer = outcome.status === 'completed' ? outcome.result.answers[0] : undefined
  return answer?.status === 'selected' && TASK_TYPES.includes(answer.choiceId as TaskType) ? answer.choiceId as TaskType : undefined
}
function tokens(text: string): Set<string> {
  const normalized = text.toLowerCase(), words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(words.flatMap(word => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word) ? [...word].slice(1).map((c, i) => `${word[i]}${c}`) : [word]))
}
/** Preserve policy recommendations; rank only installed optional Skills, never external references. */
export async function selectInstalledSkills(service: DecisionService | undefined, requestId: string, task: string, catalog: readonly CapabilityDescriptor[], resolution: CapabilityResolution, signal: AbortSignal): Promise<readonly string[]> {
  const skills = catalog.filter(c => c.kind === 'skill'), installed = new Set(skills.map(c => c.name))
  const mandatory = resolution.recommendations.filter(r => r.kind === 'skill' && r.source === 'akinator_policy' && installed.has(r.name)).map(r => r.name)
  const baseline = new Set(resolution.recommendations.filter(r => r.kind === 'skill' && r.source === 'catalog_similarity' && installed.has(r.name)).map(r => r.name))
  const query = tokens(task)
  const shortlist = skills.filter(s => !mandatory.includes(s.name)).map(s => ({ skill: s, score: [...tokens(`${s.name} ${s.description ?? ''}`)].filter(t => query.has(t)).length }))
    .sort((a, b) => b.score - a.score || compareCanonicalStrings(a.skill.name, b.skill.name)).slice(0, 32)
  if (!service || !shortlist.length) return [...new Set([...mandatory, ...shortlist.filter(s => baseline.has(s.skill.name)).slice(0, 5).map(s => s.skill.name)])]
  const outcome = await service.evaluate(requestId, { purpose: 'skills', state: { task }, questions: shortlist.map(({ skill }, index) => ({ id: `skill-${index}`, instructions: `Does this installed Skill materially apply to the request?\n${JSON.stringify(skill)}`,
    choices: [{ id: 'yes', description: 'Applicable' }, { id: 'no', description: 'Not applicable' }, { id: 'abstain', description: 'Insufficient evidence' }], abstainId: 'abstain' })) }, signal, canonicalContentHash(catalog))
  const selected = shortlist.filter(({ skill }, index) => {
    const answer = outcome.status === 'completed' ? outcome.result.answers[index] : undefined
    return answer?.status === 'selected' ? answer.choiceId === 'yes' : baseline.has(skill.name)
  }).slice(0, 5).map(s => s.skill.name)
  return [...new Set([...mandatory, ...selected])]
}
