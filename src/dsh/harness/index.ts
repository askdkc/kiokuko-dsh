import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import * as DshAgent from '@deepseek-ai/dsh-agent'
import { KiokukoAgentFactory } from './factory.js'
import { kiokukoInboxProjection, kiokukoTurnBoundaries } from './projections.js'

export { KiokukoAgentFactory, KiokukoHarnessAgent } from './factory.js'
export { KiokukoHarnessLifecycle } from './lifecycle.js'
export const name='kiokuko-harness'
export const inject=['agents','sessions','llm','tools','systemPrompt','sessionProjections']
export const Config=z.object({provider:z.string().optional(),model:z.string().optional(),maxSteps:z.number().int().positive().default(128)}).default({maxSteps:128})
declare module '@deepseek-ai/cordis' { interface Context { kiokukoHarness: KiokukoAgentFactory } }
export async function apply(ctx:Context,raw:z.input<typeof Config>={}) {
  const config=Config.parse(raw)
  const factory=new KiokukoAgentFactory(ctx,{maxSteps:config.maxSteps,...(config.provider?{provider:config.provider}:{}),...(config.model?{model:config.model}:{})})
  ctx.provide('kiokukoHarness',factory)
  const projections=ctx.get('sessionProjections',false)
  projections?.register(kiokukoTurnBoundaries)
  projections?.register(kiokukoInboxProjection)
  // Current DSH exposes this client projection; published older hosts do not.
  const modelProjection=(DshAgent as {modelSelectionProjectionDefinition?:unknown}).modelSelectionProjectionDefinition
  // Keep the native definition intact across the older/newer register typings.
  if(modelProjection)await projections?.register(modelProjection as any)
  ctx.systemPrompt.variable('provider',context=>(context as any).modelSelection?.provider??context.agent?.options.provider)
  ctx.systemPrompt.variable('model',context=>(context as any).modelSelection?.model??context.agent?.options.model)
  ctx.effect(function*(){yield ctx.agents.setFactory(factory);yield()=>factory.dispose()},'Kiokuko harness factory')
}
