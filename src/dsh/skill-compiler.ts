import { SKILL_COMPILER_VERSION, skillDigest, skillResourceId, type CompiledSkillResource, type SkillPromptBundle, type SkillSource } from './skill-prompt-contracts.js'

function hasSkillBlocks(text: string): boolean {
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined
    } else if (match) fence = match[1]!
    else if (/<!--\s*\/?kiokuko:/u.test(line)) return true
  }
  return false
}

/** Pure extraction: only author-classified runtime blocks are executable guidance. */
export function compileSkillResource(source: SkillSource): CompiledSkillResource {
  const normalized = source.content.replace(/\r\n/gu, '\n')
  const annotated = hasSkillBlocks(normalized)
  let content = source.content
  const blocks: string[] = []
  if (annotated) {
    const body = source.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')
    const runtime: string[] = [], ids = new Set<string>()
    let block: { kind: string; lines: string[] } | undefined
    let fence: { char: string; length: number } | undefined
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\r$/u, '')
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
      if (fence) {
        block!.lines.push(rawLine)
        if (fenceMatch && fenceMatch[1]![0] === fence.char && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) fence = undefined
        continue
      }
      const opening = /^<!-- kiokuko:(runtime|documentation) ([a-z][a-z0-9-]{0,63}) -->$/u.exec(line)
      const closing = /^<!-- \/kiokuko:(runtime|documentation) -->$/u.exec(line)
      if (opening) {
        if (block || ids.has(opening[2]!)) throw new Error(`Duplicate or nested Skill block: ${skillResourceId(source)}`)
        ids.add(opening[2]!); block = { kind: opening[1]!, lines: [] }
        if (block.kind === 'runtime') blocks.push(opening[2]!)
      } else if (closing) {
        if (!block || block.kind !== closing[1]) throw new Error(`Unmatched Skill block: ${skillResourceId(source)}`)
        if (block.kind === 'runtime') runtime.push(block.lines.join('\n'))
        block = undefined
      } else {
        if (/<!--\s*\/?kiokuko:/u.test(line)) throw new Error(`Invalid Skill marker: ${skillResourceId(source)}`)
        if (block) {
          block.lines.push(rawLine)
          if (fenceMatch) fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length }
        } else if (line.trim() && !/^<!-- KIOKUKO MANAGED STANDARD SKILL: [a-z-]+ -->$/u.test(line)) {
          throw new Error(`Unclassified Skill text: ${skillResourceId(source)}`)
        }
      }
    }
    if (block || fence || !blocks.length || runtime.some(text => !text.trim())) throw new Error(`Incomplete Skill contract: ${skillResourceId(source)}`)
    content = `Skill: ${source.name}. Complete runtime guidance follows; no full-file reread is required.\n\n${runtime.join('\n\n')}\n`
  }
  return { id: skillResourceId(source), sourceDigest: skillDigest(source.content), contentDigest: skillDigest(content),
    sourceBytes: Buffer.byteLength(source.content), contentBytes: Buffer.byteLength(content), blocks,
    representation: annotated ? 'compiled' : 'verbatim', content }
}

export function compileSkillBundle(sources: readonly SkillSource[]): SkillPromptBundle {
  const ids = sources.map(skillResourceId)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Skill resource')
  return { compilerVersion: SKILL_COMPILER_VERSION, resources: [...sources]
    .sort((a, b) => skillResourceId(a) < skillResourceId(b) ? -1 : 1).map(compileSkillResource) }
}
