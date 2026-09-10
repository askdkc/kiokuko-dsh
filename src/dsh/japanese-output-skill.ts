import { readFile } from 'node:fs/promises'
import { standardSkillFrontmatter } from './standard-skill-integrity.js'

export const JAPANESE_OUTPUT_SKILL_NAME = 'natural-japanese-output'
export const JAPANESE_OUTPUT_SECTION = 'kiokuko:natural-japanese-output'
const PROMPT_VARIABLE = 'kiokuko_natural_japanese_output'

/** Match model identity, including namespace and quantization suffixes, not a host's label. */
export function needsJapaneseOutputSkill(model: string | undefined): boolean {
  if (!model) return false
  return /(?:^|[^a-z0-9])(?:deepseek|kimi|glm|qwen|hunyuan|hy|mimo|minimax)(?=$|[^a-z0-9]|\d)/iu.test(model)
}

type BundledJapaneseSkill = Readonly<{ name: string; description: string; content: string }>
let bundled: Promise<BundledJapaneseSkill> | undefined
/** Load the user-supplied bundled file verbatim once; no network or translation call. */
export function loadJapaneseOutputSkill(): Promise<BundledJapaneseSkill> {
  return bundled ??= (async () => {
    const content = await readFile(new URL('../../skills/japanese-translation-for-oss-models/SKILL.md', import.meta.url), 'utf8')
    if (Buffer.byteLength(content) > 65_536) throw new Error('Bundled Japanese output Skill exceeds 64 KiB')
    const metadata = standardSkillFrontmatter(content)
    if (metadata.name !== JAPANESE_OUTPUT_SKILL_NAME || !metadata.description || metadata.disableModelInvocation) {
      throw new Error('Bundled Japanese output Skill identity is invalid')
    }
    return Object.freeze({ name: metadata.name, description: metadata.description, content })
  })()
}

interface PromptAssembly {
  sections: { name: string; text: string }[]
  variables: Record<string, string | undefined>
}

/** Apply after routing resolves variables; retain native prompt logging and budget accounting. */
export async function applyJapaneseOutputSkill<T extends PromptAssembly>(assembly: T): Promise<T & PromptAssembly> {
  const applies = needsJapaneseOutputSkill(assembly.variables.model)
  const previous = assembly.sections.some(section => section.name === JAPANESE_OUTPUT_SECTION)
  if (!applies && !previous) return assembly
  const sections = assembly.sections.filter(section => section.name !== JAPANESE_OUTPUT_SECTION)
  const { [PROMPT_VARIABLE]: _previous, ...variables } = assembly.variables
  if (!applies) return { ...assembly, sections, variables }
  const skill = await loadJapaneseOutputSkill()
  variables[PROMPT_VARIABLE] = [
    `Bundled Skill: ${skill.name}. Its complete content follows; no Skill tool call is needed.`,
    'Apply this writing guidance when the user writes in Japanese or requests Japanese output. Otherwise preserve the requested language. An explicit output-language request takes precedence over the language of quoted input.',
    'Preserve the required response schema and machine-readable fields. For structured output, apply the guidance only to human-readable Japanese string values. Do not translate user input, code identifiers, literal quotations, evidence references or protocol values. Do not expose internal reasoning or add a separate translation/reasoning transcript.',
    skill.content,
  ].join('\n\n')
  // Interpolate once so literal {{...}} in the bundled Skill is never a prompt variable.
  sections.push({ name: JAPANESE_OUTPUT_SECTION, text: `{{${PROMPT_VARIABLE}}}` })
  return { ...assembly, sections, variables }
}
