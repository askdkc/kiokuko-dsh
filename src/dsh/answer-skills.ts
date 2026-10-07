import { canonicalContentHash } from '../serialization/validate.js'
import { resolveCapabilities } from '../akinator/capabilities.js'
import type { TaskType } from '../akinator/types.js'
import type { ConfiguredSkillPrompts } from './configured-skill-prompts.js'
import type { DecisionService } from './decisions/service.js'
import { selectInstalledSkills } from './decisions/workflows.js'
import { dshTurnRequestId } from './intake-profile-resolver.js'
import type { DemandInput } from './on-demand-intake.js'

interface SkillView {
  readonly name: string
  readonly description?: string
  readonly provider?: string
  readonly source?: string
  readonly invocation?: { readonly modelInvocable?: boolean }
}
export interface AnswerSkillRegistry {
  snapshot(options: unknown): Promise<{ complete: boolean; skills: readonly SkillView[] }>
  get?(name: string, options: unknown): Promise<(SkillView & { content: string }) | undefined>
}
/** Read already installed, model-invocable instructions; never install, invoke tools, or invent task admission. */
export async function answerSkillContext(input: DemandInput, task: string, taskType: TaskType | null,
  host: { skills: AnswerSkillRegistry; prompts: ConfiguredSkillPrompts; decisions: DecisionService; cwd: string }): Promise<readonly string[]> {
  const options = { scope: input.agent, cwd: host.cwd, signal: input.signal }
  const snapshot = await host.skills.snapshot(options)
  if (!snapshot.complete) throw new Error('Native answer Skill inventory is incomplete')
  const installed = snapshot.skills.filter(skill => skill.invocation?.modelInvocable !== false)
  const catalog = installed.map(({ name, description }) => ({ kind: 'skill' as const, name, ...(description ? { description } : {}) }))
  const resolution = resolveCapabilities({ task, profile: { taskType, target: null, expected: null, constraints: null }, recommendedTags: [], capabilities: catalog, memoryUse: 'none' })
  const names = await selectInstalledSkills(host.decisions, dshTurnRequestId({ dshSessionId: input.agent.session!.id, turn: input.turn }), task, catalog, resolution, input.signal)
  const instructions: string[] = []
  for (const name of names) {
    if (name === 'kiokuko-soul') continue // Already in the native system prompt.
    const selected = installed.find(skill => skill.name === name)
    if (!selected) throw new Error('Selected answer Skill is not in the bound inventory')
    const bundled = await host.prompts.get(name)
    const loaded = bundled ? { name, content: bundled.content } : await host.skills.get?.(name, options)
    if (loaded && (loaded.name !== name || loaded.invocation?.modelInvocable === false || typeof loaded.content !== 'string')) throw new Error('Native answer Skill identity changed')
    if (loaded?.content && Buffer.byteLength(loaded.content) <= 262144) instructions.push(`Applicable installed Skill for this request: ${name}\n\n${loaded.content}`)
    else instructions.push(`Applicable installed Skill selected: ${name}. Its body is unavailable in this answer context; do not claim to have read it.`)
  }
  const current = await host.skills.snapshot(options)
  if (!current.complete || canonicalContentHash(current.skills.filter(skill => skill.invocation?.modelInvocable !== false)) !== canonicalContentHash(installed)) throw new Error('Native answer Skill inventory changed during selection')
  input.signal.throwIfAborted()
  return instructions
}
