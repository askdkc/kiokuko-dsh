import { readFile } from 'node:fs/promises'
import { SkillPromptBundle, SkillPromptsConfig, skillDigest, skillResourceId, type SkillPromptMode, type SkillSource } from './skill-prompt-contracts.js'

export interface SkillPromptDelivery {
  id: string; content: string; representation: 'full' | 'compiled' | 'verbatim'
  sourceDigest: string; contentDigest: string; fallback?: 'bundle_unavailable' | 'resource_mismatch'
}

/** One immutable source/artifact snapshot per plugin lifecycle; never compiles at runtime. */
export class ConfiguredSkillPrompts {
  readonly mode: SkillPromptMode
  #loaded?: Promise<ReadonlyMap<string, SkillPromptDelivery>>
  #sourceContents = new Map<string, string>()
  #diagnostics = new Map<string, Omit<SkillPromptDelivery, 'content'>>()
  constructor(config: { mode?: SkillPromptMode }, private readonly artifact: URL,
    private readonly sources: () => Promise<readonly SkillSource[]>) {
    this.mode = SkillPromptsConfig.parse(config).mode
  }
  async #load(): Promise<ReadonlyMap<string, SkillPromptDelivery>> {
    const sources = await this.sources() // Original integrity errors must propagate.
    let bundle: SkillPromptBundle | undefined
    if (this.mode === 'compiled') {
      try {
        const text = await readFile(this.artifact, 'utf8')
        if (Buffer.byteLength(text) > 2_097_152) throw new Error('Skill bundle exceeds limit')
        bundle = SkillPromptBundle.parse(JSON.parse(text))
        if (new Set(bundle.resources.map(resource => resource.id)).size !== bundle.resources.length) bundle = undefined
      } catch { /* The validated source remains available; diagnostics identify degraded delivery. */ }
    }
    return new Map(sources.map(source => {
      const id = skillResourceId(source), sourceDigest = skillDigest(source.content)
      this.#sourceContents.set(id, source.content)
      const resource = bundle?.resources.find(item => item.id === id)
      const matches = resource && resource.sourceDigest === sourceDigest && resource.sourceBytes === Buffer.byteLength(source.content)
        && resource.contentDigest === skillDigest(resource.content) && resource.contentBytes === Buffer.byteLength(resource.content)
        && (resource.representation === 'compiled' ? resource.blocks.length > 0 : resource.content === source.content && resource.blocks.length === 0)
      const result: SkillPromptDelivery = matches
        ? { id, content: resource.content, representation: resource.representation, sourceDigest, contentDigest: resource.contentDigest }
        : { id, content: source.content, representation: 'full', sourceDigest, contentDigest: sourceDigest,
          ...(this.mode === 'compiled' ? { fallback: bundle ? 'resource_mismatch' as const : 'bundle_unavailable' as const } : {}) }
      return [id, Object.freeze(result)]
    }))
  }
  async source(name: string, relativePath = 'SKILL.md'): Promise<string | undefined> {
    await (this.#loaded ??= this.#load())
    return this.#sourceContents.get(`${name}/${relativePath}`)
  }
  async get(name: string, relativePath = 'SKILL.md'): Promise<SkillPromptDelivery | undefined> {
    const result = (await (this.#loaded ??= this.#load())).get(`${name}/${relativePath}`)
    if (result) {
      const { content: _content, ...diagnostic } = result
      this.#diagnostics.set(result.id, diagnostic)
    }
    return result
  }
  async require(name: string, relativePath = 'SKILL.md'): Promise<string> {
    const result = await this.get(name, relativePath)
    if (!result) throw new Error(`Bundled Skill file is unavailable: ${name}/${relativePath}`)
    return result.content
  }
  diagnostics(): readonly Omit<SkillPromptDelivery, 'content'>[] { return [...this.#diagnostics.values()].map(value => ({ ...value })) }
}
