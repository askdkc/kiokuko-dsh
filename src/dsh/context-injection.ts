import type { PreparedAgentTask } from '../akinator/agent-task.js'
import { readEntry } from '../memory/entries.js'
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js'
import type { DshRuntime } from './runtime.js'
import type { DshExpertReference, DshMessageSource, DshMessageSourceInput } from './message-sources.js'
import { buildDshMessageSources } from './message-sources.js'
import type { RoleDirective } from '../enno-oduno/types.js'
import {
  STANDARD_FUNCTION_EXPERT_FILES,
  STANDARD_FUNCTION_EXPERT_IDS,
  STANDARD_UI_EXPERT_FILES,
  STANDARD_UI_EXPERT_IDS,
} from '../setup/standard-skills.js'

export interface DshModelMessage {
  readonly role: 'system' | 'user'
  readonly content: string
  readonly source: DshMessageSource['kind']
}

export interface DshDirectiveSourceSelection {
  readonly routeSkillNames: readonly string[]
  readonly expertRefs: readonly DshExpertReference[]
}

const expertFilesById = new Map<string, string>([
  ...STANDARD_FUNCTION_EXPERT_IDS.map((id, index) => [id, STANDARD_FUNCTION_EXPERT_FILES[index]!] as const),
  ...STANDARD_UI_EXPERT_IDS.map((id, index) => [id, STANDARD_UI_EXPERT_FILES[index]!] as const),
])

/** Project only the current role directive's required skills and selected experts. */
export function selectDshDirectiveSources(directive: Pick<RoleDirective, 'requiredSkills' | 'workUnit'>): DshDirectiveSourceSelection {
  const expertRefs = (directive.workUnit?.expertRefs ?? []).map((reference) => {
    const relativePath = expertFilesById.get(reference.id)
    if (relativePath === undefined) throw new Error(`No bundled dsh expert mapping exists for ${reference.id}`)
    const skillName = reference.id.startsWith('ui.') ? 'kiokuko-ui-design-soul' : 'kiokuko-single-purpose-functions'
    return { skillName, relativePath }
  })
  return Object.freeze({
    routeSkillNames: Object.freeze([...new Set(directive.requiredSkills)]),
    expertRefs: Object.freeze(expertRefs),
  })
}

function sourceInput(prepared: PreparedAgentTask, routeSkillNames: readonly string[], expertRefs: readonly DshExpertReference[]): DshMessageSourceInput {
  if (prepared.intake.status !== 'ready' && prepared.intake.status !== 'exhausted') throw new Error('Cannot inject context before intake is finalized')
  if (prepared.nextAction !== 'proceed') throw new Error('Cannot inject context when the host gate did not permit proceeding')
  return {
    task: prepared.intake.profile.target === null ? prepared.intake.profile.expected ?? '' : prepared.intake.profile.target,
    intakeStatus: prepared.intake.status,
    nextAction: 'proceed',
    memoryPolicy: prepared.memoryPolicy,
    context: prepared.context,
    routeSkillNames,
    expertRefs,
  }
}

/** Compose the fixed source ordering into dsh-compatible model messages. */
export async function injectDshContext(input: {
  readonly prepared: PreparedAgentTask
  readonly task: string
  readonly routeSkillNames?: readonly string[]
  readonly expertRefs?: readonly DshExpertReference[]
  readonly runtime?: Pick<DshRuntime, 'withDatabase'>
}): Promise<readonly DshModelMessage[]> {
  const assertMemoryCurrent = input.runtime === undefined || input.prepared.context === null
    ? undefined
    : async (item: (NonNullable<PreparedAgentTask['context']>['items'])[number]): Promise<void> => {
      await input.runtime!.withDatabase((database) => {
        const entry = readEntry(database, { workspace: input.prepared.project.workspace, entryId: item.entryId })
        if (entry.revision !== item.revision || !isRetrievableEntry(database, entry) || entry.status === 'superseded') {
          throw new Error('Scoped memory changed or is no longer retrievable')
        }
      })
    }
  const sources = await buildDshMessageSources({
    ...sourceInput(input.prepared, input.routeSkillNames ?? [], input.expertRefs ?? []),
    task: input.task,
    ...(assertMemoryCurrent === undefined ? {} : { assertMemoryCurrent }),
  })
  return Object.freeze(sources.map((source) => Object.freeze({
    role: source.kind === 'user-task' ? 'user' : 'system',
    content: source.text,
    source: source.kind,
  })))
}
