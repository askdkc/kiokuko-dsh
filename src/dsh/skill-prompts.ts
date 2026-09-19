import { ConfiguredSkillPrompts } from './configured-skill-prompts.js'
import { loadSkillSources } from './skill-sources.js'
import type { SkillPromptMode, SkillSource } from './skill-prompt-contracts.js'
export type { SkillPromptDelivery } from './configured-skill-prompts.js'

/** Full compatibility inventory; core callers supply their own resource manifest. */
export class DshSkillPrompts extends ConfiguredSkillPrompts {
  constructor(config: { mode?: SkillPromptMode } = {}, artifact = new URL('../../dist/dsh/skill-prompts.json', import.meta.url),
    sources: () => Promise<readonly SkillSource[]> = loadSkillSources) {
    super(config, artifact, sources)
  }
}
