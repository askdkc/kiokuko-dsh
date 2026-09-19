import { ConfiguredSkillPrompts } from '../configured-skill-prompts.js'
import { standardSkillFrontmatter } from '../standard-skill-integrity.js'
import type { DshSkillProvider, DshSkillCandidate } from '../standard-skill-provider.js'
import type { ModuleResource } from './modules.js'

/** Manifest-only delivery. Missing resources never fall back to a full installation. */
export function configuredSkillPrompts(resources: readonly ModuleResource[], mode: 'full' | 'compiled', artifact: URL): ConfiguredSkillPrompts {
  const snapshot = resources.map(resource => ({ ...resource }))
  return new ConfiguredSkillPrompts({ mode }, artifact, async () => Promise.all(snapshot.map(async resource => {
    const content = await resource.load()
    if (!content || Buffer.byteLength(content) > 262_144) throw new Error(`Invalid Skill resource: ${resource.name}/${resource.relativePath}`)
    const marker = `<!-- KIOKUKO MANAGED STANDARD SKILL: ${resource.name} -->`
    if (content.split(marker).length !== 2) throw new Error(`Invalid Skill ownership marker: ${resource.name}/${resource.relativePath}`)
    return { name: resource.name, relativePath: resource.relativePath, content }
  })))
}

export function configuredSkillProvider(resources: readonly ModuleResource[], prompts: ConfiguredSkillPrompts): DshSkillProvider & { dispose(): void } {
  const names = resources.filter(resource => resource.relativePath === 'SKILL.md').map(resource => resource.name)
  let disposed = false
  let inventory: Promise<DshSkillCandidate[]> | undefined
  const candidates = () => inventory ??= Promise.all(names.map(async name => {
    const content = await prompts.source(name)
    if (!content) throw new Error(`Missing Skill source: ${name}`)
    const frontmatter = standardSkillFrontmatter(content)
    if (frontmatter.name !== name || !frontmatter.description) throw new Error(`Invalid Skill identity: ${name}`)
    return { name, description: frontmatter.description, invocation: { modelInvocable: true, userInvocable: true }, source: 'bundled' as const, provider: 'kiokuko-configured', rank: 600, locator: { skillName: name }, resourceBase: { kind: 'opaque' as const, description: 'Configured local Kiokuko resources' } }
  }))
  return {
    name: 'kiokuko-configured',
    async list({ signal }) {
      signal?.throwIfAborted()
      const items = disposed ? [] : await candidates()
      signal?.throwIfAborted()
      return { candidates: disposed ? [] : items.map(candidate => structuredClone(candidate)), complete: true }
    },
    async get(candidate, { signal }) {
      signal?.throwIfAborted()
      if (disposed || candidate.provider !== 'kiokuko-configured' || candidate.source !== 'bundled' || candidate.locator.skillName !== candidate.name) return undefined
      const owned = (await candidates()).find(item => item.name === candidate.name)
      if (!owned) return undefined
      const content = await prompts.require(owned.name)
      signal?.throwIfAborted()
      if (disposed) return undefined
      return { ...structuredClone(owned), content }
    },
    dispose() { disposed = true },
  }
}
