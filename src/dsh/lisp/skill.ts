import { readFile } from 'node:fs/promises'
import { standardSkillFrontmatter } from '../standard-skill-integrity.js'

export const LISP_SKILL_NAME = 'kiokuko-lisp'

type BundledLispSkill = Readonly<{ name: string; description: string; content: string }>
let bundled: Promise<BundledLispSkill> | undefined

/** Load guidance without enabling Lisp or requiring its runtime and host services. */
export function loadLispSkill(): Promise<BundledLispSkill> {
  return bundled ??= (async () => {
    const content = await readFile(new URL('../../../skills/kiokuko-lisp/SKILL.md', import.meta.url), 'utf8')
    if (Buffer.byteLength(content) > 65_536) throw new Error('Bundled Lisp Skill exceeds 64 KiB')
    const metadata = standardSkillFrontmatter(content)
    if (metadata.name !== LISP_SKILL_NAME || !metadata.description || metadata.disableModelInvocation) {
      throw new Error('Bundled Lisp Skill identity is invalid')
    }
    return Object.freeze({ name: metadata.name, description: metadata.description, content })
  })()
}
