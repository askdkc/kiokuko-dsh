import { loadStandardSkillParity } from './standard-skill-integrity.js'
import { loadJapaneseOutputSkill } from './japanese-output-skill.js'
import { loadLispSkill } from './lisp/skill.js'
import type { SkillSource } from './skill-prompt-contracts.js'

/** Closed, validated package inventory. Caller-supplied names never become paths. */
export async function loadSkillSources(): Promise<readonly SkillSource[]> {
  const [standard, japanese, lisp] = await Promise.all([loadStandardSkillParity(), loadJapaneseOutputSkill(), loadLispSkill()])
  return [...standard.files.map(file => ({ name: file.skillName, relativePath: file.relativePath, content: file.content })),
    ...[japanese, lisp].map(skill => ({ name: skill.name, relativePath: 'SKILL.md', content: skill.content }))]
}
