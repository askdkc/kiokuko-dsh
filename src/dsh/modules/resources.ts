import { readFile } from 'node:fs/promises'
import type { DshModule, ModuleResource } from '../core/modules.js'
import { STANDARD_SKILL_MANIFESTS } from '../standard-skills.js'

/** Explicit trusted build inventory. Resource names never originate in user input. */
export function bundledResources(names: readonly string[]): readonly ModuleResource[] {
  return names.flatMap(name => {
    const files = STANDARD_SKILL_MANIFESTS.find(manifest => manifest.name === name)?.files ?? ['SKILL.md']
    return files.map(relativePath => ({ name, relativePath, load: () => readFile(new URL(`../../../skills/${name === 'natural-japanese-output' ? 'japanese-translation-for-oss-models' : name}/${relativePath}`, import.meta.url), 'utf8') }))
  })
}
export function skillModule<Host>(id: string, names: readonly string[]): DshModule<Host> {
  return { id, coreVersion: 1, requires: [], resources: bundledResources(names), configure(value) { if (value !== undefined) throw new Error(`Skill-only module has no configuration: ${id}`); return undefined } }
}
export const coreSkills = skillModule('core-skills', ['kiokuko-soul', 'memory-reasoning', 'natural-japanese-output'])
export const codingSkills = skillModule('coding-skills', ['kiokuko-single-purpose-functions', 'one-shot-software-completion', 'kiokuko-simple-work', 'kiokuko-ui-design-soul', 'veteran-programmer-skill'])
