import { loadStandardSkillParity } from './parity.js'

export const KIOKUKO_SOUL_PROMPT_SECTION = 'kiokuko:soul'
export const KIOKUKO_SOUL_PROMPT_ORDER = -100_000

interface DshPromptRegistry {
  readonly systemPrompt: {
    getSectionOrder(name: string): number
    section(input: { readonly name: string; readonly order: number; readonly text: string }): () => void
  }
  effect(execute: () => Promise<() => void>, label?: string): unknown
}

export async function loadSoulPrompt(): Promise<string> {
  const parity = await loadStandardSkillParity()
  return parity.files.find((file) => file.skillName === 'kiokuko-soul' && file.relativePath === 'SKILL.md')!.content
}

/** Add the exact SOUL body as a stable, earliest prompt section. */
export function mountSoulPrompt(ctx: DshPromptRegistry): unknown {
  return ctx.effect(async () => ctx.systemPrompt.section({
    name: KIOKUKO_SOUL_PROMPT_SECTION,
    order: Math.min(KIOKUKO_SOUL_PROMPT_ORDER, ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY') - 1),
    text: await loadSoulPrompt(),
  }), 'kiokuko-dsh soul prompt')
}
