import type { Context } from '@deepseek-ai/cordis'
import { mountKiokukoModels } from './surface.js'

/** Saved conversation routes outlive failures of the optional execution plugin. */
export const name = 'kiokuko-models'
export const inject = ['llm', 'commands'] as const
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => mountKiokukoModels(ctx), 'kiokuko saved model providers')
}
