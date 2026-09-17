import { createHash } from 'node:crypto'
import { z } from 'zod'

export const SKILL_COMPILER_VERSION = 1
export const SkillPromptsConfig = z.object({ mode: z.enum(['full', 'compiled']).default('full') }).strict()
export type SkillPromptMode = z.infer<typeof SkillPromptsConfig>['mode']
export interface SkillSource { name: string; relativePath: string; content: string }
export const skillDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
export const skillResourceId = (source: Pick<SkillSource, 'name' | 'relativePath'>): string => `${source.name}/${source.relativePath}`
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const CompiledSkillResource = z.object({
  id: z.string().min(1).max(512), sourceDigest: digest, contentDigest: digest,
  sourceBytes: z.number().int().nonnegative(), contentBytes: z.number().int().nonnegative(),
  blocks: z.array(z.string().min(1).max(64)).max(256),
  representation: z.enum(['compiled', 'verbatim']), content: z.string().min(1).max(262144),
}).strict()
export type CompiledSkillResource = z.infer<typeof CompiledSkillResource>
export const SkillPromptBundle = z.object({ compilerVersion: z.literal(SKILL_COMPILER_VERSION), resources: z.array(CompiledSkillResource).max(64) }).strict()
export type SkillPromptBundle = z.infer<typeof SkillPromptBundle>
