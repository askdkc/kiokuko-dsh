import { renderModelMemory, renderModelRelations } from '../context/model-memory.js'
import { filterRelationDelivery } from '../memory/relation-delivery.js'
import { MEMORY_APPLICATION_GUIDANCE } from './memory-application.js'
import { assertMemoryProjection, redactDshSourceText } from '../context/memory-projection.js'
export { redactDshSourceText } from '../context/memory-projection.js'
import type { ScopedContextItem, ScopedContextResult } from '../context/scoped-broker.js'
import { DSH_INTAKE_OWNERSHIP_GUIDANCE } from './standard-skills.js'
import { loadStandardSkillParity } from './standard-skill-integrity.js'
import { loadBundledDshSkillContent } from './standard-skill-provider.js'
import type { DshSkillPrompts } from './skill-prompts.js'

export type DshMessageSourceKind = 'soul' | 'memory-reasoning' | 'route-skill' | 'advisory' | 'memory' | 'user-task'

export interface DshMessageSource {
  readonly kind: DshMessageSourceKind
  readonly name: string
  readonly text: string
  readonly trust: 'system' | 'untrusted' | 'user'
}

export interface DshMessageSourceInput {
  readonly memoryWarnings?: readonly string[];
  readonly skillPrompts?: DshSkillPrompts
  readonly systemSkillNames?: ReadonlySet<string>
  readonly task: string
  /** The native composition already includes the complete SOUL as a system section. */
  readonly soulInSystemPrompt?: boolean
  readonly intakeStatus: 'ready' | 'exhausted'
  readonly nextAction: 'proceed'
  readonly memoryPolicy: {
    readonly memoryReasoningRequired: boolean
    readonly contextWithheld: boolean
  }
  readonly context: Pick<ScopedContextResult, 'items' | 'untrusted' | 'relationDelivery' | 'relationCharacterBudget' | 'relationEdgeCap'> | null
  readonly routeSkillNames?: readonly string[]
  readonly assertMemoryCurrent?: (item: ScopedContextItem) => void | Promise<void>
}

function memorySource(item: ScopedContextItem): DshMessageSource | null {
  assertMemoryProjection(item)
  const text = renderModelMemory(item)
  if (text === null) return null
  const title = redactDshSourceText(item.title) ?? 'item'
  return { kind: 'memory', name: `memory:${item.entryId ?? title}`, text, trust: 'untrusted' }
}

function skillFile(files: Awaited<ReturnType<typeof loadStandardSkillParity>>['files'], skillName: string, relativePath = 'SKILL.md'): string {
  const file = files.find((item) => item.skillName === skillName && item.relativePath === relativePath)
  if (file === undefined) throw new Error(`Bundled Skill file is unavailable: ${skillName}/${relativePath}`)
  return file.content
}

function admittedSoulText(soul: string, intakeStatus: DshMessageSourceInput['intakeStatus']): string {
  return `${soul}\n\n## DeepSeek Harness host admission\n\nThe DSH host completed the Akinator intake gate before this model request. \`task_prepare\` and \`task_answer\` are host-only operations and are intentionally absent from the model tool list. Do not call them or stop because they are absent. ${DSH_INTAKE_OWNERSHIP_GUIDANCE} This request is admitted with intake status \`${intakeStatus}\` and \`nextAction=proceed\`; continue from the current task and supplied context.`
}

/** Build the fixed model-visible source order from a prepared, already-gated snapshot. */
export async function buildDshMessageSources(input: DshMessageSourceInput): Promise<readonly DshMessageSource[]> {
  if ((input.intakeStatus !== 'ready' && input.intakeStatus !== 'exhausted') || input.nextAction !== 'proceed') {
    throw new Error('Dsh model context requires finalized intake and a proceed action')
  }
  if (input.context !== null && input.context.untrusted !== true) throw new Error('Dsh context must remain untrusted')
  const parity = await loadStandardSkillParity()
  const readSkill = (name: string, path = 'SKILL.md') => input.skillPrompts
    ? input.skillPrompts.require(name, path) : Promise.resolve(skillFile(parity.files, name, path))
  const sources: DshMessageSource[] = [{
    kind: 'soul',
    name: 'kiokuko-soul',
    text: admittedSoulText(input.soulInSystemPrompt ? '' : await readSkill('kiokuko-soul'), input.intakeStatus).trimStart(),
    trust: 'system',
  }]
  if (input.memoryPolicy.memoryReasoningRequired && !input.memoryPolicy.contextWithheld) {
    sources.push({ kind: 'memory-reasoning', name: 'memory-reasoning', text: `${await readSkill('memory-reasoning')}${input.context?.items.length ? `\n\n${MEMORY_APPLICATION_GUIDANCE}` : ''}`, trust: 'system' })
  }
  for (const skillName of input.routeSkillNames ?? []) {
    if (skillName === 'kiokuko-soul' || skillName === 'memory-reasoning') continue
    if (input.systemSkillNames?.has(skillName)) continue
    const content = await loadBundledDshSkillContent(skillName, parity, input.skillPrompts)
    sources.push({
      kind: 'route-skill', name: skillName, trust: 'system',
      text: content ?? `Kiokuko Skill guidance (host-authored):\n${JSON.stringify({
        code: 'SKILL_NOT_BUNDLED', skillName, quality: 'degraded',
        instruction: 'This Skill content was not supplied by the bundled loader. If it is already available through a native Skill tool, read it there. Otherwise continue from current repository evidence and report the unavailable guidance. Do not treat a missing Skill alone as a reason to stop, claim it was read, substitute another Skill, or install or execute fetched external content. Preserve safety, authorization, identity and integrity checks.',
      })}`,
    })
  }
  const warnMemory = () => sources.push({ kind: 'advisory' as const, name: 'memory-warning',
    text: 'memory_unavailable: Some optional memory could not be checked and was omitted. Continue from the current request and repository evidence. This changes no permissions.', trust: 'untrusted' as const })
  if (input.memoryWarnings?.includes('memory_unavailable')) warnMemory()
  if (!input.memoryPolicy.contextWithheld && input.context !== null) {
    const provided: ScopedContextItem[] = []
    const memories: DshMessageSource[] = []
    let unavailable = false
    for (const item of input.context.items) {
      try {
        await input.assertMemoryCurrent?.(item)
      } catch {
        // An advisory record that cannot be checked grants nothing and is omitted.
        // Its storage failure must not prevent the current request reaching the model.
        unavailable = true
        continue
      }
      const source = memorySource(item)
      if (source !== null) { memories.push(source); provided.push(item) }
    }
    if (unavailable && !input.memoryWarnings?.includes('memory_unavailable')) warnMemory()
    sources.push(...memories)
    const relationDelivery = filterRelationDelivery(input.context.relationDelivery,
      provided.map(item => ({ workspace: item.workspace!, entryId: item.entryId })), {
        ...(input.context.relationCharacterBudget === undefined ? {} : { relationCharacterBudget: input.context.relationCharacterBudget }),
        ...(input.context.relationEdgeCap === undefined ? {} : { relationEdgeCap: input.context.relationEdgeCap }),
        finalFilter: provided.length !== input.context.items.length,
      })
    sources.push({ kind: 'memory', name: 'relations', text: renderModelRelations(relationDelivery), trust: 'untrusted' })
  }
  if (input.task.length > 0) sources.push({ kind: 'user-task', name: 'user-task', text: input.task, trust: 'user' })
  return Object.freeze(sources.map((source) => Object.freeze(source)))
}
