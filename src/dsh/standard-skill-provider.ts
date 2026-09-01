import { loadStandardSkillParity, standardSkillFrontmatter, type StandardSkillParity } from './parity.js'

export const STANDARD_DSH_SKILL_PROVIDER = 'kiokuko-standard'
export const STANDARD_DSH_SKILL_RANK = 600

export interface DshSkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export interface DshSkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: DshSkillInvocationPolicy
  readonly source: 'bundled'
  readonly provider: string
  readonly rank: number
  readonly locator: { readonly skillName: string }
  readonly resourceBase: { readonly kind: 'opaque'; readonly description: string }
}

export interface DshSkillDefinition extends DshSkillCandidate {
  readonly content: string
}

export interface DshSkillProvider {
  readonly name: string
  list(options: { readonly signal?: AbortSignal }): Promise<readonly DshSkillCandidate[] | { readonly candidates: readonly DshSkillCandidate[]; readonly complete: true }>
  get(candidate: DshSkillCandidate, options: { readonly signal?: AbortSignal }): Promise<DshSkillDefinition | undefined>
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Skill lookup aborted')
}

function candidates(parity: StandardSkillParity): DshSkillCandidate[] {
  return parity.skills.map((skillName) => {
    const primary = parity.files.find((file) => file.skillName === skillName && file.relativePath === 'SKILL.md')!
    const description = standardSkillFrontmatter(primary.content).description
    if (description === null || description.length === 0) throw new Error(`Missing standard Skill description: ${skillName}`)
    return {
      name: skillName,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: STANDARD_DSH_SKILL_PROVIDER,
      rank: STANDARD_DSH_SKILL_RANK,
      locator: { skillName },
      resourceBase: { kind: 'opaque', description: 'Kiokuko package bundled standard Skill resources' },
    }
  })
}

/** Create a complete, read-only provider over the core standard Skill loader. */
export function createStandardSkillProvider(): DshSkillProvider & { dispose(): void } {
  let disposed = false
  let parityPromise: Promise<StandardSkillParity> | undefined
  const parity = (): Promise<StandardSkillParity> => parityPromise ??= loadStandardSkillParity()
  const provider = {
    name: STANDARD_DSH_SKILL_PROVIDER,
    async list(options: { readonly signal?: AbortSignal }) {
      abortIfRequested(options.signal)
      if (disposed) return { candidates: [], complete: true as const }
      const result = { candidates: candidates(await parity()), complete: true as const }
      abortIfRequested(options.signal)
      return result
    },
    async get(candidate: DshSkillCandidate, options: { readonly signal?: AbortSignal }): Promise<DshSkillDefinition | undefined> {
      abortIfRequested(options.signal)
      if (disposed || candidate.provider !== STANDARD_DSH_SKILL_PROVIDER || candidate.source !== 'bundled') return undefined
      const result = await parity()
      const file = result.files.find((item) => item.skillName === candidate.locator.skillName && item.relativePath === 'SKILL.md')
      if (file === undefined || candidate.name !== file.skillName) return undefined
      abortIfRequested(options.signal)
      return { ...candidate, content: file.content }
    },
    dispose(): void {
      disposed = true
    },
  }
  return provider
}

export interface DshSkillContext {
  readonly skills: { registerProvider(create: (control: { readonly signal: AbortSignal }) => DshSkillProvider): () => void }
}

/** Register the bundled provider; the caller owns the returned Cordis disposer. */
export function mountStandardSkillProvider(ctx: DshSkillContext): () => void {
  let provider: (DshSkillProvider & { dispose(): void }) | undefined
  const unregister = ctx.skills.registerProvider((control) => {
    provider = createStandardSkillProvider()
    control.signal.addEventListener('abort', () => provider?.dispose(), { once: true })
    return provider
  })
  return () => {
    provider?.dispose()
    unregister()
  }
}
