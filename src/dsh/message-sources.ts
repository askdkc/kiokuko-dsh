import { findSecret } from '../memory/secrets.js'
import type { ScopedContextItem, ScopedContextResult } from '../context/scoped-broker.js'
import { loadStandardSkillParity } from './parity.js'
import type { RoleDirective } from '../enno-oduno/types.js'

export type DshMessageSourceKind = 'soul' | 'directive' | 'memory-reasoning' | 'route-skill' | 'expert' | 'memory' | 'user-task'

export interface DshMessageSource {
  readonly kind: DshMessageSourceKind
  readonly name: string
  readonly text: string
  readonly trust: 'system' | 'untrusted' | 'user'
}

export interface DshExpertReference {
  readonly skillName: string
  readonly relativePath: string
}

export interface DshMessageSourceInput {
  readonly task: string
  readonly intakeStatus: 'ready' | 'exhausted'
  readonly nextAction: 'proceed'
  readonly memoryPolicy: {
    readonly memoryReasoningRequired: boolean
    readonly contextWithheld: boolean
  }
  readonly context: Pick<ScopedContextResult, 'items' | 'untrusted'> | null
  readonly directive?: Pick<RoleDirective, 'role' | 'harness' | 'objective' | 'requiredSkills' | 'workUnit' | 'stopConditions' | 'reportSchema'>
  readonly routeSkillNames?: readonly string[]
  readonly expertRefs?: readonly DshExpertReference[]
  readonly assertMemoryCurrent?: (item: ScopedContextItem) => void | Promise<void>
}

function directiveSource(directive: DshMessageSourceInput['directive']): DshMessageSource | null {
  if (directive === undefined) return null
  const text = JSON.stringify({
    role: directive.role,
    harness: directive.harness,
    objective: directive.objective,
    requiredSkills: directive.requiredSkills,
    workUnit: directive.workUnit,
    stopConditions: directive.stopConditions,
    reportSchema: directive.reportSchema,
  })
  return { kind: 'directive', name: 'kiokuko-directive', text: `Current Kiokuko role directive (host-authored; do not invent missing fields):\n${text}`, trust: 'system' }
}

const INTERNAL_ID = /\b(?:run|entry|delivery|session|work[_-]?unit|orchestration|request)[_-]?(?:id)?\s*[:=]\s*[A-Za-z0-9._:-]{4,}\b/giu
const LONG_HEX_ID = /\b[0-9a-f]{32,}\b/giu
const ABSOLUTE_PATH = /(?:^|[\s(])(?:\/(?:Users|private|tmp|var|opt|home)\/[^\s)]+|[A-Za-z]:\\[^\s)]+)/gu

function sourceText(value: string): string | null {
  if (findSecret(value) !== undefined) return null
  const redacted = value
    .replace(INTERNAL_ID, '[internal id redacted]')
    .replace(LONG_HEX_ID, '[internal id redacted]')
    .replace(ABSOLUTE_PATH, (match) => match.startsWith(' ') || match.startsWith('(') ? `${match[0]}[path redacted]` : '[path redacted]')
    .trim()
  return redacted.length > 0 ? redacted : null
}

function memorySource(item: ScopedContextItem): DshMessageSource | null {
  const text = sourceText([item.title, item.summary ?? '', item.bodyPreview].filter(Boolean).join('\n'))
  if (text === null) return null
  const title = sourceText(item.title) ?? 'item'
  return { kind: 'memory', name: `memory:${title}`, text, trust: 'untrusted' }
}

function skillFile(files: Awaited<ReturnType<typeof loadStandardSkillParity>>['files'], skillName: string, relativePath = 'SKILL.md'): string {
  const file = files.find((item) => item.skillName === skillName && item.relativePath === relativePath)
  if (file === undefined) throw new Error(`Bundled Skill file is unavailable: ${skillName}/${relativePath}`)
  return file.content
}

function admittedSoulText(soul: string, intakeStatus: DshMessageSourceInput['intakeStatus']): string {
  return `${soul}\n\n## DeepSeek Harness host admission\n\nThe DSH host completed the Akinator intake gate before this model request. \`task_prepare\` and \`task_answer\` are host-only operations and are intentionally absent from the model tool list. Do not call them or stop because they are absent. This request is admitted with intake status \`${intakeStatus}\` and \`nextAction=proceed\`; continue from the current directive and supplied context.`
}

/** Build the fixed model-visible source order from a prepared, already-gated snapshot. */
export async function buildDshMessageSources(input: DshMessageSourceInput): Promise<readonly DshMessageSource[]> {
  if ((input.intakeStatus !== 'ready' && input.intakeStatus !== 'exhausted') || input.nextAction !== 'proceed') {
    throw new Error('Dsh model context requires finalized intake and a proceed action')
  }
  if (input.context !== null && input.context.untrusted !== true) throw new Error('Dsh context must remain untrusted')
  const parity = await loadStandardSkillParity()
  const sources: DshMessageSource[] = [{
    kind: 'soul',
    name: 'kiokuko-soul',
    text: admittedSoulText(skillFile(parity.files, 'kiokuko-soul'), input.intakeStatus),
    trust: 'system',
  }]
  const directive = directiveSource(input.directive)
  if (directive !== null) sources.push(directive)
  if (input.memoryPolicy.memoryReasoningRequired && !input.memoryPolicy.contextWithheld) {
    sources.push({ kind: 'memory-reasoning', name: 'memory-reasoning', text: skillFile(parity.files, 'memory-reasoning'), trust: 'system' })
  }
  for (const skillName of input.routeSkillNames ?? []) {
    if (skillName === 'kiokuko-soul' || skillName === 'memory-reasoning') continue
    sources.push({ kind: 'route-skill', name: skillName, text: skillFile(parity.files, skillName), trust: 'system' })
  }
  for (const reference of input.expertRefs ?? []) {
    if (!reference.relativePath.startsWith('references/')) throw new Error(`Invalid bundled expert path: ${reference.relativePath}`)
    sources.push({ kind: 'expert', name: `${reference.skillName}/${reference.relativePath}`, text: skillFile(parity.files, reference.skillName, reference.relativePath), trust: 'system' })
  }
  if (!input.memoryPolicy.contextWithheld) {
    for (const item of input.context?.items ?? []) {
      await input.assertMemoryCurrent?.(item)
      const source = memorySource(item)
      if (source !== null) sources.push(source)
    }
  }
  sources.push({ kind: 'user-task', name: 'user-task', text: input.task, trust: 'user' })
  return Object.freeze(sources.map((source) => Object.freeze(source)))
}
